/* =========================================================
 *  多计时器 APP - 核心逻辑
 *  功能：正向/反向计时、多任务并发、暂停/结束、声音提醒
 * ========================================================= */

// ========== 全局状态 ==========
const STORAGE_KEY = "multi_timer_app_v1";

/** @type {Array<TimerTask>} */
let tasks = [];

// 主循环使用的计时器ID映射：taskId -> setInterval ID
const loopTimers = new Map();

// ========== 原生本地通知（Capacitor） ==========
/**
 * 在原生 APP 中，倒计时启动时一次性调度一个系统级通知。
 * 即使 APP 被杀、锁屏，Android 系统也会在指定时间弹出通知并响铃。
 * 在网页环境中此模块为空操作（no-op）。
 */
const NativeTimer = {
  isNative: typeof window !== "undefined" &&
            window.Capacitor &&
            window.Capacitor.isNativePlatform &&
            window.Capacitor.isNativePlatform(),
  _plugin: null,
  _channelReady: false,

  /** 获取 LocalNotifications 插件 */
  plugin() {
    if (!this.isNative) return null;
    if (!this._plugin) {
      this._plugin = window.Capacitor?.Plugins?.LocalNotifications;
    }
    return this._plugin;
  },

  /** 把 task.id (字符串) 转成稳定的 32 位 int，作为通知 ID */
  idToInt(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) {
      h = ((h << 5) - h + id.charCodeAt(i)) | 0;
    }
    return Math.abs(h) % 2147483647;
  },

  /** 初始化：申请权限 + 创建通知渠道 */
  async init() {
    if (!this.isNative) return;
    const p = this.plugin();
    if (!p) return;
    try {
      // 申请通知权限
      const perm = await p.requestPermissions();
      console.log("[NativeTimer] 通知权限:", perm.display);

      // 创建通知渠道（Android 8+ 必须）
      if (!this._channelReady) {
        await p.createChannel({
          id: "timer_alert",
          name: "计时提醒",
          description: "倒计时结束提醒",
          importance: 5, // HIGH：会响铃 + 震动 + 弹出
          visibility: 1, // PUBLIC：锁屏也显示
          sound: "default",
          vibration: true,
          lights: true,
          lightColor: "#6c5ce7",
        });
        this._channelReady = true;
      }
    } catch (e) {
      console.warn("[NativeTimer] 初始化失败", e);
    }
  },

  /**
   * 为倒计时任务调度系统通知。
   * 只在 reverse 模式 + running 状态调用。
   */
  async schedule(task) {
    if (!this.isNative || task.mode !== "reverse") return;
    const p = this.plugin();
    if (!p) return;
    if (task.remaining <= 0) return;

    try {
      const fireAt = new Date(Date.now() + task.remaining * 1000);
      await p.schedule({
        notifications: [
          {
            id: this.idToInt(task.id),
            title: "⏰ " + task.name,
            body: "时间到！",
            schedule: { at: fireAt, allowWhileIdle: true }, // allowWhileIdle 关键：Doze 模式也触发
            channelId: "timer_alert",
            sound: "default",
            smallIcon: "ic_launcher",
            largeIcon: "ic_launcher",
            ongoing: false,
            autoCancel: true,
            extra: { taskId: task.id },
          },
        ],
      });
      console.log("[NativeTimer] 已调度通知", task.name, "触发时间:", fireAt.toLocaleString());
    } catch (e) {
      console.warn("[NativeTimer] 调度失败", e);
    }
  },

  /** 取消任务的通知（暂停/结束/删除/重启时调用） */
  async cancel(task) {
    if (!this.isNative) return;
    const p = this.plugin();
    if (!p) return;
    try {
      await p.cancel({ notifications: [{ id: this.idToInt(task.id) }] });
    } catch (e) {
      console.warn("[NativeTimer] 取消失败", e);
    }
  },
};

// ========== Wake Lock（保持屏幕常亮） ==========
const WakeLock = {
  _lock: null,
  _supported: "wakeLock" in navigator,

  /** 有任意 running 任务时调用，请求保持屏幕常亮 */
  async acquire() {
    if (!this._supported) return;
    if (this._lock) return; // 已持有
    try {
      this._lock = await navigator.wakeLock.request("screen");
      this._lock.addEventListener("release", () => {
        this._lock = null;
      });
      console.log("[WakeLock] 已保持屏幕常亮");
    } catch (e) {
      console.warn("[WakeLock] 请求失败", e);
    }
  },

  /** 没有 running 任务时释放 */
  async release() {
    if (this._lock) {
      try { await this._lock.release(); } catch (e) {}
      this._lock = null;
      console.log("[WakeLock] 已释放");
    }
  },

  /** 根据当前任务状态自动申请/释放 */
  sync() {
    const hasRunning = tasks.some((t) => t.status === "running");
    if (hasRunning) this.acquire();
    else this.release();
  },
};

// ========== 数据结构 ==========
/**
 * @typedef {Object} TimerTask
 * @property {string} id          - 唯一ID
 * @property {string} name        - 事项名称
 * @property {'reverse'|'forward'} mode  - 模式：reverse=倒计时, forward=正计时
 * @property {number} totalSeconds - 倒计时的总秒数（reverse 用）
 * @property {number} remaining   - 剩余秒数（reverse 用）
 * @property {number} elapsed     - 已过秒数（forward 用）
 * @property {'idle'|'running'|'paused'|'ended'} status  - 状态
 * @property {number} startedAt   - 开始的时间戳 ms
 * @property {number} soundType   - 声音类型 beep/alarm/bell
 * @property {number} createdAt   - 创建时间戳
 */

// ========== 工具函数 ==========
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

function uid() {
  return "t_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** 把秒格式化为 HH:MM:SS，不足补零；如果总时长<1小时，不显示小时 */
function formatTime(seconds, showAlwaysHours = false) {
  seconds = Math.max(0, Math.floor(seconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n) => n.toString().padStart(2, "0");
  if (showAlwaysHours || h > 0) {
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }
  return `${pad(m)}:${pad(s)}`;
}

function saveToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch (e) {
    console.warn("保存失败", e);
  }
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      tasks = JSON.parse(raw);
      // 修复旧版本数据缺字段
      tasks.forEach((t) => {
        if (!t.status) t.status = "idle";
        if (t.mode === "reverse" && typeof t.remaining !== "number") {
          t.remaining = t.totalSeconds || 0;
        }
        if (t.mode === "forward" && typeof t.elapsed !== "number") {
          t.elapsed = 0;
        }
      });
    }
  } catch (e) {
    console.warn("读取失败", e);
    tasks = [];
  }
}

// ========== Web Audio API 声音引擎 ==========
const SoundEngine = (() => {
  let ctx = null;
  let activeOscillators = [];
  let beepTimer = null;
  let bellTimer = null;

  function ensureCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
    }
    // 某些浏览器需要 resume
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
    return ctx;
  }

  /** 单滴短音 */
  function beep(freq = 880, duration = 0.2, gainValue = 0.3) {
    try {
      const c = ensureCtx();
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, c.currentTime);
      gain.gain.linearRampToValueAtTime(gainValue, c.currentTime + 0.02);
      gain.gain.linearRampToValueAtTime(0, c.currentTime + duration);
      osc.connect(gain).connect(c.destination);
      osc.start();
      osc.stop(c.currentTime + duration);
    } catch (e) {}
  }

  /** 播放结束提示声音（根据类型循环播放） */
  function playEndSound(type = "beep") {
    stopEndSound();
    switch (type) {
      case "bell":
        // 柔和铃声：两个音交替
        bellTimer = setInterval(() => {
          beep(660, 0.25, 0.25);
          setTimeout(() => beep(880, 0.25, 0.25), 200);
        }, 800);
        beep(660, 0.25, 0.25);
        setTimeout(() => beep(880, 0.25, 0.25), 200);
        break;
      case "alarm":
        // 闹钟：高频急促滴滴
        beepTimer = setInterval(() => {
          beep(1200, 0.1, 0.35);
          setTimeout(() => beep(900, 0.1, 0.35), 120);
        }, 300);
        break;
      case "beep":
      default:
        // 普通滴滴
        beepTimer = setInterval(() => beep(880, 0.18, 0.3), 450);
        beep(880, 0.18, 0.3);
        break;
    }
  }

  function stopEndSound() {
    if (beepTimer) { clearInterval(beepTimer); beepTimer = null; }
    if (bellTimer) { clearInterval(bellTimer); bellTimer = null; }
    activeOscillators.forEach((o) => { try { o.stop(); } catch (e) {} });
    activeOscillators = [];
  }

  // 用户点击任意处时确保 AudioContext 被 resume（iOS 要求）
  document.addEventListener("click", () => ensureCtx(), { once: false });

  return { playEndSound, stopEndSound, ensureCtx };
})();

// ========== Toast ==========
function showToast(msg, duration = 2000) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove("show"), duration);
}

// ========== 计时核心 ==========

/** 启动单个计时器的 setInterval 循环 */
function startLoop(task) {
  stopLoop(task.id);
  const intervalMs = 250; // 250ms 刷新一次，足够平滑又省电
  const timerId = setInterval(() => tick(task), intervalMs);
  loopTimers.set(task.id, timerId);
}

function stopLoop(taskId) {
  const tid = loopTimers.get(taskId);
  if (tid) {
    clearInterval(tid);
    loopTimers.delete(taskId);
  }
}

/** 每个 tick 更新一次 */
function tick(task) {
  if (task.status !== "running") return;

  if (task.mode === "reverse") {
    // 剩余 = 总秒数 - 已过秒数
    const elapsed = (Date.now() - task.startedAt) / 1000;
    const left = task.totalSeconds - (task._pausedAccum || 0) - elapsed;
    task.remaining = Math.max(0, left);

    if (task.remaining <= 0) {
      task.remaining = 0;
      task.status = "ended";
      stopLoop(task.id);
      onTaskEnded(task);
    }
  } else {
    // 正计时：已过 = 历史暂停累计 + 当前运行时长
    const runningNow = (Date.now() - task.startedAt) / 1000;
    task.elapsed = (task._pausedAccum || 0) + runningNow;
  }

  renderTask(task);
  saveToStorage();
}

/** 倒计时结束回调 */
function onTaskEnded(task) {
  SoundEngine.playEndSound(task.soundType || "beep");
  showNotificationBanner(task.name + " 时间到！");
  showToast("✅ " + task.name + " 已结束");

  // 尝试系统通知（需要权限）
  trySendNotification(task);

  saveToStorage();
  updateHeaderCount();
  WakeLock.sync();
}

function showNotificationBanner(text) {
  let banner = $(".notification-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.className = "notification-banner";
    banner.innerHTML = `
      <span class="nb-icon">🎉</span>
      <span class="nb-text"></span>
      <button class="nb-close" type="button">✕</button>
    `;
    banner.querySelector(".nb-close").addEventListener("click", () => {
      SoundEngine.stopEndSound();
      banner.classList.remove("show");
    });
    document.body.appendChild(banner);
  }
  banner.querySelector(".nb-text").textContent = text;
  banner.classList.add("show");
  clearTimeout(showNotificationBanner._t);
  showNotificationBanner._t = setTimeout(() => {
    banner.classList.remove("show");
    SoundEngine.stopEndSound();
  }, 12000);
}

function trySendNotification(task) {
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") {
    new Notification("⏰ 时间到", {
      body: task.name,
      tag: task.id,
    });
  }
}

// ========== 任务操作 ==========

function createTask(data) {
  /** @type {TimerTask} */
  const task = {
    id: uid(),
    name: data.name || "未命名事项",
    mode: data.mode || "reverse",
    totalSeconds: data.totalSeconds || 0,
    remaining: data.totalSeconds || 0,
    elapsed: 0,
    status: "idle",
    startedAt: 0,
    _pausedAccum: 0,
    soundType: data.soundType || "beep",
    createdAt: Date.now(),
  };
  tasks.unshift(task);
  saveToStorage();
  renderList();

  // 自动开始
  startTask(task.id);

  // 请求通知权限（异步）
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }

  return task;
}

function startTask(taskId) {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return;

  if (task.status === "idle") {
    task.startedAt = Date.now();
    task._pausedAccum = 0;
    if (task.mode === "reverse") {
      task.remaining = task.totalSeconds;
    } else {
      task.elapsed = 0;
    }
  } else if (task.status === "paused") {
    // 从暂停恢复
    task.startedAt = Date.now();
  } else if (task.status === "running") {
    return;
  } else if (task.status === "ended") {
    // 已结束则重启
    if (task.mode === "reverse") {
      task.remaining = task.totalSeconds;
    } else {
      task.elapsed = 0;
    }
    task._pausedAccum = 0;
    task.startedAt = Date.now();
  }

  task.status = "running";
  startLoop(task);
  renderTask(task);
  saveToStorage();
  updateHeaderCount();
  WakeLock.sync();
  // 原生环境：调度系统通知（锁屏也会响）
  NativeTimer.schedule(task);
}

function pauseTask(taskId) {
  const task = tasks.find((t) => t.id === taskId);
  if (!task || task.status !== "running") return;

  // 暂停时，把当前这段时间累计到 _pausedAccum
  const delta = (Date.now() - task.startedAt) / 1000;
  task._pausedAccum = (task._pausedAccum || 0) + delta;

  if (task.mode === "reverse") {
    task.remaining = Math.max(0, task.totalSeconds - task._pausedAccum);
  } else {
    task.elapsed = task._pausedAccum;
  }

  task.status = "paused";
  stopLoop(task.id);
  renderTask(task);
  saveToStorage();
  updateHeaderCount();
  WakeLock.sync();
  // 暂停时取消系统通知
  NativeTimer.cancel(task);
}

function resumeTask(taskId) {
  startTask(taskId);
}

function endTask(taskId) {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return;
  task.status = "ended";
  stopLoop(task.id);
  // 结算最后一次 tick
  if (task.mode === "reverse") {
    // 结束按钮是"手动结束"，不是自然结束，不触发声音
    const delta = (Date.now() - task.startedAt) / 1000;
    task._pausedAccum = (task._pausedAccum || 0) + delta;
    task.remaining = Math.max(0, task.totalSeconds - task._pausedAccum);
  } else {
    const delta = (Date.now() - task.startedAt) / 1000;
    task._pausedAccum = (task._pausedAccum || 0) + delta;
    task.elapsed = task._pausedAccum;
  }
  renderTask(task);
  saveToStorage();
  updateHeaderCount();
  WakeLock.sync();
  NativeTimer.cancel(task);
  showToast("已结束 " + task.name);
}

function restartTask(taskId) {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return;
  stopLoop(task.id);
  NativeTimer.cancel(task); // 取消旧通知
  task._pausedAccum = 0;
  task.startedAt = Date.now();
  if (task.mode === "reverse") {
    task.remaining = task.totalSeconds;
  } else {
    task.elapsed = 0;
  }
  task.status = "running";
  startLoop(task);
  renderTask(task);
  saveToStorage();
  updateHeaderCount();
  WakeLock.sync();
  NativeTimer.schedule(task); // 重新调度
  showToast("已重新开始 " + task.name);
}

function deleteTask(taskId) {
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return;
  const task = tasks[idx];
  const name = task.name;
  stopLoop(taskId);
  NativeTimer.cancel(task);
  tasks.splice(idx, 1);
  saveToStorage();
  renderList();
  updateHeaderCount();
  WakeLock.sync();
  showToast("已删除 " + name);
}

// ========== 渲染 ==========

function renderList() {
  const list = $("#timerList");
  const empty = $("#emptyState");
  list.innerHTML = "";

  if (tasks.length === 0) {
    list.appendChild(empty);
    return;
  }

  tasks.forEach((t) => {
    list.appendChild(buildCard(t));
    renderTask(t);
  });
}

function buildCard(task) {
  const card = document.createElement("div");
  card.className = `timer-card mode-${task.mode}`;
  card.dataset.id = task.id;
  card.innerHTML = `
    <div class="card-glow"></div>
    <div class="card-header">
      <div class="card-title-row">
        <div class="card-icon">${task.mode === "reverse" ? "⏳" : "⏱️"}</div>
        <div class="card-title"></div>
        <span class="card-mode-tag">${task.mode === "reverse" ? "倒计时" : "正计时"}</span>
      </div>
      <button class="card-delete" data-act="delete" type="button" aria-label="删除">🗑️</button>
    </div>
    <div class="card-time">--:--</div>
    <div class="card-progress">
      <div class="card-progress-bar"></div>
    </div>
    <div class="card-actions"></div>
  `;
  card.querySelector(".card-title").textContent = task.name;

  // 绑定事件
  card.querySelector("[data-act=delete]").addEventListener("click", (e) => {
    e.stopPropagation();
    if (confirm(`确定删除「${task.name}」？`)) {
      deleteTask(task.id);
    }
  });

  return card;
}

function renderTask(task) {
  const card = document.querySelector(`.timer-card[data-id="${task.id}"]`);
  if (!card) return;

  // 状态 class
  card.classList.remove("active", "ended", "urgent");
  if (task.status === "running") card.classList.add("active");
  if (task.status === "ended") card.classList.add("ended");

  // 紧急提醒
  if (task.mode === "reverse" && task.status === "running" && task.remaining < 10 && task.remaining > 0) {
    card.classList.add("urgent");
  }

  // 时间文字
  const timeEl = card.querySelector(".card-time");
  if (task.mode === "reverse") {
    timeEl.textContent = formatTime(task.remaining, task.totalSeconds >= 3600);
  } else {
    timeEl.textContent = formatTime(task.elapsed);
  }

  // 进度条
  const bar = card.querySelector(".card-progress-bar");
  if (task.mode === "reverse") {
    const pct = task.totalSeconds > 0 ? (task.remaining / task.totalSeconds) * 100 : 0;
    bar.style.width = pct + "%";
  } else {
    // 正计时不显示进度（因为没有上限）
    bar.style.width = "100%";
    bar.style.opacity = "0.3";
  }

  // 按钮
  const actions = card.querySelector(".card-actions");
  actions.innerHTML = "";
  const btnStart = (text, act, cls) => `<button class="action-btn ${cls}" data-act="${act}" type="button">${text}</button>`;

  if (task.status === "idle") {
    actions.innerHTML = btnStart("▶ 开始", "start", "action-btn-start");
  } else if (task.status === "running") {
    actions.innerHTML =
      btnStart("⏸ 暂停", "pause", "action-btn-pause") +
      btnStart("■ 结束", "end", "action-btn-end");
  } else if (task.status === "paused") {
    actions.innerHTML =
      btnStart("▶ 继续", "resume", "action-btn-resume") +
      btnStart("■ 结束", "end", "action-btn-end");
  } else if (task.status === "ended") {
    actions.innerHTML = btnStart("↺ 重新开始", "restart", "action-btn-restart");
  }

  // 绑定按钮事件
  actions.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const act = btn.dataset.act;
      if (act === "start") startTask(task.id);
      else if (act === "pause") pauseTask(task.id);
      else if (act === "resume") resumeTask(task.id);
      else if (act === "end") endTask(task.id);
      else if (act === "restart") restartTask(task.id);
    });
  });
}

function updateHeaderCount() {
  const running = tasks.filter((t) => t.status === "running").length;
  const total = tasks.length;
  const sub = $("#taskCount");
  if (!sub) return;
  if (total === 0) {
    sub.textContent = "";
  } else if (running > 0) {
    sub.textContent = `${running} 个运行中`;
  } else {
    sub.textContent = `共 ${total} 个事项`;
  }
}

// ========== 新建弹窗 ==========
const AddModal = (() => {
  const modal = $("#addModal");
  const nameInput = $("#taskName");
  const modeBtns = $$(".mode-btn");
  const timeGroup = $("#timeInputGroup");
  const h = $("#inputHours");
  const m = $("#inputMinutes");
  const s = $("#inputSeconds");

  let currentMode = "reverse";

  function open() {
    // 重置表单
    nameInput.value = "";
    modeBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === "reverse"));
    currentMode = "reverse";
    h.value = 0;
    m.value = 5;
    s.value = 0;
    h.disabled = m.disabled = s.disabled = false;
    timeGroup.style.display = "";

    // 默认选中第一个声音
    const defaultSound = document.querySelector('input[name="sound"][value="beep"]');
    if (defaultSound) defaultSound.checked = true;

    modal.classList.add("open");
    setTimeout(() => nameInput.focus(), 200);
  }

  function close() {
    modal.classList.remove("open");
  }

  function bind() {
    $("#addBtn").addEventListener("click", () => {
      SoundEngine.ensureCtx(); // iOS 需要
      open();
    });
    $("#cancelBtn").addEventListener("click", close);
    $(".modal-backdrop").addEventListener("click", close);

    // 模式切换
    modeBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        modeBtns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        currentMode = btn.dataset.mode;
        if (currentMode === "forward") {
          timeGroup.style.display = "none";
        } else {
          timeGroup.style.display = "";
        }
      });
    });

    // 快捷时长
    $$(".quick-btn").forEach((q) => {
      q.addEventListener("click", () => {
        const total = parseInt(q.dataset.s, 10);
        h.value = Math.floor(total / 3600);
        m.value = Math.floor((total % 3600) / 60);
        s.value = total % 60;
      });
    });

    // 确认按钮
    $("#confirmBtn").addEventListener("click", () => {
      const name = nameInput.value.trim() || (currentMode === "forward" ? "正计时" : "倒计时");
      let totalSeconds = 0;
      if (currentMode === "reverse") {
        totalSeconds =
          (parseInt(h.value, 10) || 0) * 3600 +
          (parseInt(m.value, 10) || 0) * 60 +
          (parseInt(s.value, 10) || 0);
        if (totalSeconds <= 0) {
          showToast("请设置大于 0 的时间");
          return;
        }
      }
      const sound = document.querySelector('input[name="sound"]:checked');
      createTask({
        name,
        mode: currentMode,
        totalSeconds,
        soundType: sound ? sound.value : "beep",
      });
      close();
      showToast("✅ 已创建并开始");
    });

    // Enter 提交
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") $("#confirmBtn").click();
    });
  }

  return { bind };
})();

// ========== 恢复运行中的计时器 ==========
function resumeRunningTasks() {
  tasks.forEach((t) => {
    if (t.status === "running") {
      // 不重置 startedAt！让它继续从上次保存的时间点算 delta
      // tick() 会自动补上页面关闭期间流逝的时间
      startLoop(t);
      tick(t); // 立即 tick 刷新显示，并触发可能的"补响铃"
      // 原生环境：为仍在运行的倒计时重新调度通知
      // （APP 被杀后通知可能已被消费，或还没触发——重新调度保证一定能收到）
      if (t.mode === "reverse" && t.remaining > 0) {
        NativeTimer.schedule(t);
      }
    }
  });
}

// ========== 初始化 ==========
function init() {
  loadFromStorage();
  AddModal.bind();
  renderList();
  updateHeaderCount();
  // 原生环境：初始化通知（申请权限 + 建渠道）
  NativeTimer.init().then(() => {
    resumeRunningTasks();
  });

  // 页面关闭前保存当前精确进度到 _pausedAccum
  const flushProgress = () => {
    tasks.forEach((t) => {
      if (t.status === "running") {
        const delta = (Date.now() - t.startedAt) / 1000;
        t._pausedAccum = (t._pausedAccum || 0) + delta;
        t.startedAt = Date.now();
        if (t.mode === "reverse") {
          t.remaining = Math.max(0, t.totalSeconds - t._pausedAccum);
          if (t.remaining <= 0) {
            t.status = "ended";
            onTaskEnded(t);
          }
        } else {
          t.elapsed = t._pausedAccum;
        }
      }
    });
    saveToStorage();
  };

  // 离开页面前保存
  window.addEventListener("beforeunload", flushProgress);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushProgress();
      // 后台时停止 UI 刷新循环（省电），但 startedAt 保持不变
      // 这样回到前台时 tick() 会自动用 Date.now() - startedAt 算出真实流逝
      tasks.forEach((t) => {
        if (t.status === "running") stopLoop(t.id);
      });
    } else {
      // 回到前台：不重置 startedAt！让 tick() 自动补上后台流逝的时间
      tasks.forEach((t) => {
        if (t.status === "running") {
          startLoop(t);
          tick(t); // 立即 tick 一次，马上刷新显示
        }
      });
      // 系统在后台会自动释放 WakeLock，回前台需要重新申请
      WakeLock.sync();
    }
  });
}

// 注册 Service Worker（只在网页环境，原生 APP 不需要）
if ("serviceWorker" in navigator && !NativeTimer.isNative) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./service-worker.js")
      .then(() => console.log("[SW] 注册成功"))
      .catch((err) => console.warn("[SW] 注册失败", err));
  });
}

document.addEventListener("DOMContentLoaded", init);
