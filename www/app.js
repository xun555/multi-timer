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
        // 上次会话遗留的响铃状态：重新打开时不再响铃，倒计时恢复原时间
        if (t.alarming) {
          t.alarming = false;
          if (t.mode === "reverse" && t.status === "ended") {
            t.remaining = t.totalSeconds || 0;
          }
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
  task.alarming = true;
  SoundEngine.playEndSound(task.soundType || "beep");
  showNotificationBanner(task.name + " 时间到！");
  showToast("✅ " + task.name + " 已结束");

  // 尝试系统通知（需要权限）
  trySendNotification(task);

  renderTask(task); // 立即渲染为红色警示
  focusTaskCard(task); // 自动定位到该计时项

  saveToStorage();
  updateHeaderCount();
  WakeLock.sync();
}

/** 把指定任务的卡片滚动到可视区域中央（必要时切回计时页） */
function focusTaskCard(task) {
  // 如果当前停留在游戏次数页，先切回计时页
  if (Pages.current() !== 0) {
    Pages.go(0);
    // 等页面切换动画后再滚动
    setTimeout(() => scrollCardIntoView(task), 320);
  } else {
    scrollCardIntoView(task);
  }
}

function scrollCardIntoView(task) {
  const card = document.querySelector(`.timer-card[data-id="${task.id}"]`);
  if (!card) return;
  const list = $("#timerList");
  if (!list) return;

  const listRect = list.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const fullyVisible = cardRect.top >= listRect.top && cardRect.bottom <= listRect.bottom;
  if (fullyVisible) return;

  card.scrollIntoView({ behavior: "smooth", block: "center" });
}

/** 停止响铃：关闭声音与横幅，并让已结束的倒计时恢复显示原始设定时间 */
function stopAlarm() {
  SoundEngine.stopEndSound();
  const banner = $(".notification-banner");
  if (banner) banner.classList.remove("show");

  tasks.forEach((t) => {
    if (t.alarming) {
      t.alarming = false;
      if (t.mode === "reverse" && t.status === "ended") {
        // 恢复到原倒计时时间
        t.remaining = t.totalSeconds;
      }
      renderTask(t);
    }
  });
  saveToStorage();
}

function showNotificationBanner(text) {
  let banner = $(".notification-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.className = "notification-banner";
    banner.innerHTML = `
      <span class="nb-icon">⏰</span>
      <span class="nb-text"></span>
      <button class="nb-bell" type="button" aria-label="停止响铃">🔔</button>
    `;
    banner.querySelector(".nb-bell").addEventListener("click", stopAlarm);
    document.body.appendChild(banner);
  }
  banner.querySelector(".nb-text").textContent = text;
  banner.classList.add("show");
  // 不自动停止，用户点铃铛（或操作计时器）才停
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

  // 不自动开始，保持 idle 状态，由用户手动点"开始"

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
  task.alarming = false;
  stopLoop(task.id);
  stopAlarm();
  // 结束时正计时归零，倒计时恢复显示原设定时间
  if (task.mode === "reverse") {
    task.remaining = task.totalSeconds;
  } else {
    task.elapsed = 0;
  }
  task._pausedAccum = 0;
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
  task.alarming = false;
  stopAlarm();
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

/** 编辑任务（名称/模式/总时长/声音） */
function updateTask(taskId, data) {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return;
  task.name = data.name || task.name;
  task.soundType = data.soundType || task.soundType;
  // 模式或总时长变了 → 重置进度，回到 idle
  if (data.mode !== task.mode || data.totalSeconds !== task.totalSeconds) {
    NativeTimer.cancel(task);
    stopLoop(task.id);
    task.mode = data.mode;
    task.totalSeconds = data.totalSeconds || 0;
    task.remaining = data.totalSeconds || 0;
    task.elapsed = 0;
    task._pausedAccum = 0;
    task.status = "idle";
    task.startedAt = 0;
  }
  renderTask(task);
  saveToStorage();
  updateHeaderCount();
  WakeLock.sync();
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
      <div class="card-tools">
        <button class="card-edit" data-act="edit" type="button" aria-label="编辑">✏️</button>
        <button class="card-delete" data-act="delete" type="button" aria-label="删除">🗑️</button>
      </div>
    </div>
    <div class="card-time">--:--</div>
    <div class="card-progress">
      <div class="card-progress-bar"></div>
    </div>
    <div class="card-actions"></div>
  `;
  card.querySelector(".card-title").textContent = task.name;

  card.querySelector("[data-act=edit]").addEventListener("click", (e) => {
    e.stopPropagation();
    AddModal.open(task);
  });

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
  card.classList.remove("active", "ended", "urgent", "alarm");
  if (task.status === "running") card.classList.add("active");
  if (task.status === "ended") card.classList.add("ended");
  if (task.alarming) card.classList.add("alarm");

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

// ========== 新建/编辑弹窗 ==========
const AddModal = (() => {
  const modal = $("#addModal");
  const nameInput = $("#taskName");
  const modeBtns = $$(".mode-btn");
  const timeGroup = $("#timeInputGroup");
  const soundGroup = $("#soundGroup");
  const h = $("#inputHours");
  const m = $("#inputMinutes");
  const s = $("#inputSeconds");
  const titleEl = $("#modalTitle");
  const confirmBtn = $("#confirmBtn");

  let currentMode = "reverse";
  let editingTaskId = null; // null = 新建模式

  function applyModeUI() {
    modeBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === currentMode));
    if (currentMode === "forward") {
      timeGroup.style.display = "none";
      soundGroup.style.display = "none"; // 正计时不需要提示音
    } else {
      timeGroup.style.display = "";
      soundGroup.style.display = "";
    }
  }

  function open(task) {
    editingTaskId = task ? task.id : null;
    titleEl.textContent = task ? "编辑计时事项" : "新建计时事项";
    confirmBtn.textContent = task ? "保存" : "创建";

    if (task) {
      // 编辑模式：回填数据
      nameInput.value = task.name;
      currentMode = task.mode;
      h.value = Math.floor(task.totalSeconds / 3600);
      m.value = Math.floor((task.totalSeconds % 3600) / 60);
      s.value = task.totalSeconds % 60;
      const radio = document.querySelector(`input[name="sound"][value="${task.soundType || "beep"}"]`);
      if (radio) radio.checked = true;
    } else {
      // 新建模式：默认值
      nameInput.value = "";
      currentMode = "reverse";
      h.value = 0;
      m.value = 0;
      s.value = 0;
      const defaultSound = document.querySelector('input[name="sound"][value="beep"]');
      if (defaultSound) defaultSound.checked = true;
    }

    applyModeUI();
    modal.classList.add("open");
    setTimeout(() => nameInput.focus(), 200);
  }

  function close() {
    modal.classList.remove("open");
    editingTaskId = null;
  }

  function bind() {
    $("#addBtn").addEventListener("click", () => {
      SoundEngine.ensureCtx();
      open(null);
    });
    $("#cancelBtn").addEventListener("click", close);
    $(".modal-backdrop").addEventListener("click", close);

    modeBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        currentMode = btn.dataset.mode;
        applyModeUI();
      });
    });

    $$(".quick-btn").forEach((q) => {
      q.addEventListener("click", () => {
        const total = parseInt(q.dataset.s, 10);
        h.value = Math.floor(total / 3600);
        m.value = Math.floor((total % 3600) / 60);
        s.value = total % 60;
      });
    });

    confirmBtn.addEventListener("click", () => {
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
      const soundType = sound ? sound.value : "beep";

      if (editingTaskId) {
        updateTask(editingTaskId, { name, mode: currentMode, totalSeconds, soundType });
        showToast("✅ 已保存修改");
      } else {
        createTask({ name, mode: currentMode, totalSeconds, soundType });
        showToast("✅ 已创建");
      }
      close();
    });

    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") confirmBtn.click();
    });
  }

  return { bind, open };
})();

// ========== 长按拖动排序 ==========
function initDragSort() {
  const list = $("#timerList");
  if (!list) return;

  let dragging = null;
  let startY = 0;
  let longPressTimer = null;
  let isDragging = false;

  list.addEventListener(
    "touchstart",
    (e) => {
      const card = e.target.closest(".timer-card");
      if (!card) return;
      // 不要在按钮上触发拖动
      if (e.target.closest("button")) return;

      dragging = card;
      startY = e.touches[0].clientY;
      isDragging = false;

      longPressTimer = setTimeout(() => {
        isDragging = true;
        card.classList.add("dragging");
        if (navigator.vibrate) navigator.vibrate(30);
      }, 400);
    },
    { passive: true }
  );

  list.addEventListener(
    "touchmove",
    (e) => {
      if (!dragging) return;
      if (!isDragging) {
        if (Math.abs(e.touches[0].clientY - startY) > 10) {
          clearTimeout(longPressTimer);
        }
        return;
      }
      e.preventDefault();

      const touchY = e.touches[0].clientY;
      const cards = Array.from(list.querySelectorAll(".timer-card"));
      let insertBefore = null;
      for (const c of cards) {
        if (c === dragging) continue;
        const rect = c.getBoundingClientRect();
        if (touchY < rect.top + rect.height / 2) {
          insertBefore = c;
          break;
        }
      }
      if (insertBefore) list.insertBefore(dragging, insertBefore);
      else list.appendChild(dragging);
    },
    { passive: false }
  );

  const endDrag = () => {
    clearTimeout(longPressTimer);
    if (dragging && isDragging) {
      dragging.classList.remove("dragging");
      syncTaskOrderFromDOM();
    }
    dragging = null;
    isDragging = false;
  };
  list.addEventListener("touchend", endDrag);
  list.addEventListener("touchcancel", endDrag);
}

function syncTaskOrderFromDOM() {
  const cards = $$(".timer-card");
  const newOrder = cards
    .map((c) => tasks.find((t) => t.id === c.dataset.id))
    .filter(Boolean);
  if (newOrder.length === tasks.length && newOrder.length > 0) {
    tasks = newOrder;
    saveToStorage();
  }
}

// ========== 横向页面切换（滑轨 + 手势） ==========
const Pages = (() => {
  const wrap = $("#pages");
  const track = $("#pagesTrack");
  const tabs = $$(".page-tab");
  const MAX = 1; // 共两页
  let currentIndex = 0;

  // 手势状态
  let startX = 0;
  let startY = 0;
  let offsetX = 0;
  let tracking = false;
  let horizontal = false;

  function syncUI(idx) {
    tabs.forEach((t) => t.classList.toggle("active", Number(t.dataset.page) === idx));
    const fab = $("#addBtn");
    if (fab) fab.style.display = idx === 0 ? "" : "none";
  }

  function apply(px, animated) {
    if (!track) return;
    track.style.transition = animated ? "" : "none";
    track.style.transform = `translateX(calc(${-currentIndex * 100}% + ${px}px))`;
  }

  function go(idx, animated = true) {
    currentIndex = Math.max(0, Math.min(MAX, idx));
    offsetX = 0;
    apply(0, animated);
    syncUI(currentIndex);
  }

  function onTouchStart(e) {
    if (e.touches.length !== 1) return;
    // 正在拖动排序卡片时不响应翻页
    if (document.querySelector(".timer-card.dragging")) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    offsetX = 0;
    tracking = true;
    horizontal = false;
  }

  function onTouchMove(e) {
    if (!tracking || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;

    if (!horizontal) {
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 12) {
        horizontal = true;
      } else if (Math.abs(dy) > 12) {
        // 判定为纵向滚动，放弃翻页
        tracking = false;
        return;
      } else {
        return;
      }
    }

    // 边界阻尼
    let px = dx;
    if ((currentIndex === 0 && dx > 0) || (currentIndex === MAX && dx < 0)) px *= 0.32;
    offsetX = px;
    apply(px, false);
  }

  function onTouchEnd() {
    if (!tracking) {
      horizontal = false;
      return;
    }
    if (horizontal) {
      const threshold = (wrap.clientWidth || 320) * 0.22;
      if (offsetX < -threshold) go(currentIndex + 1);
      else if (offsetX > threshold) go(currentIndex - 1);
      else go(currentIndex);
    }
    tracking = false;
    horizontal = false;
  }

  function bind() {
    tabs.forEach((t) => t.addEventListener("click", () => go(Number(t.dataset.page))));
    wrap.addEventListener("touchstart", onTouchStart, { passive: true });
    wrap.addEventListener("touchmove", onTouchMove, { passive: true });
    wrap.addEventListener("touchend", onTouchEnd);
    wrap.addEventListener("touchcancel", onTouchEnd);
    go(0, false);
  }

  return { bind, go, current: () => currentIndex };
})();

// ========== 王者荣耀游戏次数计算 ==========
const GameCalc = (() => {
  const KEY = "multi_timer_game_v1";
  const DEFAULTS = [
    { name: "学习时间", d1: 2, d2: 20 },
    { name: "获取信息时间", d1: 3, d2: 20 },
    { name: "健身锻炼时间", d1: 2, d2: 25 },
  ];

  let items = [];

  function uid() {
    return "g_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        items = JSON.parse(raw);
      }
    } catch (e) {
      items = [];
    }
    if (!Array.isArray(items) || items.length === 0) {
      items = DEFAULTS.map((d) => ({ id: uid(), name: d.name, d1: d.d1, d2: d.d2, minutes: 0 }));
    }
    items.forEach((it) => {
      if (typeof it.minutes !== "number") it.minutes = 0;
      if (typeof it.d1 !== "number") it.d1 = 1;
      if (typeof it.d2 !== "number") it.d2 = 1;
    });
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(items));
    } catch (e) {}
  }

  /** 单项贡献次数 */
  function itemValue(it) {
    const d1 = it.d1 > 0 ? it.d1 : 0;
    const d2 = it.d2 > 0 ? it.d2 : 0;
    if (!d1 || !d2) return 0;
    return it.minutes / d1 / d2;
  }

  function total() {
    return items.reduce((sum, it) => sum + itemValue(it), 0);
  }

  function fmt(n) {
    return n.toFixed(2);
  }

  function refreshTotals() {
    const totalEl = $("#gameTotal");
    if (totalEl) totalEl.textContent = fmt(total());
    $$(".game-item").forEach((el) => {
      const it = items.find((x) => x.id === el.dataset.id);
      if (!it) return;
      const res = el.querySelector(".game-item-result b");
      if (res) res.textContent = fmt(itemValue(it));
    });
  }

  function buildItem(it) {
    const el = document.createElement("div");
    el.className = "game-item";
    el.dataset.id = it.id;
    el.innerHTML = `
      <div class="game-item-head">
        <input class="game-item-name" type="text" maxlength="12" />
        <button class="game-item-del" type="button" aria-label="删除">✕</button>
      </div>
      <div class="game-item-body">
        <div class="game-field">
          <span>时间</span>
          <input class="game-num minutes" type="number" min="0" step="1" />
          <span>分钟</span>
        </div>
        <div class="game-field">
          <span>÷</span>
          <input class="game-num divisor d1" type="number" min="0" step="0.1" />
        </div>
        <div class="game-field">
          <span>÷</span>
          <input class="game-num divisor d2" type="number" min="0" step="0.1" />
        </div>
      </div>
      <div class="game-item-result">本项目 = <b>0.00</b> 次</div>
    `;

    const nameEl = el.querySelector(".game-item-name");
    const minutesEl = el.querySelector(".minutes");
    const d1El = el.querySelector(".d1");
    const d2El = el.querySelector(".d2");

    nameEl.value = it.name;
    minutesEl.value = it.minutes;
    d1El.value = it.d1;
    d2El.value = it.d2;

    nameEl.addEventListener("input", () => {
      it.name = nameEl.value;
      save();
    });

    minutesEl.addEventListener("input", () => {
      it.minutes = parseFloat(minutesEl.value) || 0;
      save();
      refreshTotals();
    });

    [d1El, d2El].forEach((input) => {
      input.addEventListener("input", () => {
        it.d1 = parseFloat(d1El.value) || 0;
        it.d2 = parseFloat(d2El.value) || 0;
        save();
        refreshTotals();
      });
    });

    el.querySelector(".game-item-del").addEventListener("click", () => {
      items = items.filter((x) => x.id !== it.id);
      save();
      renderAll();
    });

    return el;
  }

  function renderAll() {
    const box = $("#gameItems");
    if (!box) return;
    box.innerHTML = "";
    items.forEach((it) => box.appendChild(buildItem(it)));
    refreshTotals();
  }

  function addItem() {
    items.push({ id: uid(), name: "新时间项目", d1: 2, d2: 20, minutes: 0 });
    save();
    renderAll();
  }

  function init() {
    load();
    renderAll();
    const btn = $("#gameAddBtn");
    if (btn) btn.addEventListener("click", addItem);
  }

  return { init };
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
  initDragSort();
  Pages.bind();
  GameCalc.init();
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
