// Claude Scheduler — service worker
// Задачите се пазят в chrome.storage.local; изпълняват се чрез chrome.alarms
// + периодичен „пазач", който хваща пропуснати аларми (MV3 приспива worker-а).

const ALARM_PREFIX = "cs-task-";
const WATCHDOG = "cs-watchdog";
const WATCHDOG_MINUTES = 0.5;      // проверка на всеки ~30 сек.
const LATE_GRACE_MS = 5 * 60 * 1000; // закъснение, което още се изпълнява
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 45 * 1000;

// ---------- settings.json ----------

const DEFAULT_SETTINGS = {
  models: ["Opus 5.5", "Sonnet 5", "Haiku 4.5"],
  effort: ["Low", "Medium", "High", "Extra", "Max"],
  quickHours: [3, 5, 10, 15],
  menuLabels: { moreModels: ["More models"], effort: ["Effort"] },
};

function asList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

// Чете settings.json при всяко извикване (така промените се виждат без презареждане).
async function loadSettings() {
  let s = { ...DEFAULT_SETTINGS };
  let error = null;
  try {
    const res = await fetch(chrome.runtime.getURL("settings.json"), { cache: "no-store" });
    const raw = JSON.parse(await res.text());
    const models = asList(raw.models);
    const effort = asList(raw.effort);
    const hours = Array.isArray(raw.quickHours)
      ? raw.quickHours.map(Number).filter((n) => Number.isFinite(n) && n > 0)
      : [];
    const labels = raw.menuLabels || {};
    s = {
      models: models.length ? models : DEFAULT_SETTINGS.models,
      effort: effort.length ? effort : DEFAULT_SETTINGS.effort,
      quickHours: hours.length ? hours : DEFAULT_SETTINGS.quickHours,
      menuLabels: {
        moreModels: asList(labels.moreModels).length ? asList(labels.moreModels) : DEFAULT_SETTINGS.menuLabels.moreModels,
        effort: asList(labels.effort).length ? asList(labels.effort) : DEFAULT_SETTINGS.menuLabels.effort,
      },
    };
  } catch (e) {
    error = `settings.json има грешка: ${String(e.message || e)}`;
  }
  try {
    await chrome.storage.local.set({ settingsCache: s });
  } catch (_) {}
  return { ...s, error };
}

// ---------- storage ----------

async function getTasks() {
  const { tasks = [] } = await chrome.storage.local.get("tasks");
  return tasks;
}

async function setTasks(tasks) {
  await chrome.storage.local.set({ tasks });
  await updateBadge(tasks);
}

async function patchTask(id, patch) {
  const tasks = await getTasks();
  const t = tasks.find((x) => x.id === id);
  if (!t) return null;
  Object.assign(t, patch);
  await setTasks(tasks);
  return t;
}

async function updateBadge(tasks) {
  const list = tasks || (await getTasks());
  const n = list.filter((t) => t.status === "pending" || t.status === "missed").length;
  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#b85f20" });
    await chrome.action.setBadgeText({ text: n ? String(n) : "" });
  } catch (_) {}
}

// ---------- аларми ----------

async function scheduleAlarm(task) {
  await chrome.alarms.create(ALARM_PREFIX + task.id, { when: Math.max(task.when, Date.now() + 500) });
}

async function clearAlarm(taskId) {
  await chrome.alarms.clear(ALARM_PREFIX + taskId);
}

async function ensureWatchdog() {
  const existing = await chrome.alarms.get(WATCHDOG);
  if (!existing) await chrome.alarms.create(WATCHDOG, { periodInMinutes: WATCHDOG_MINUTES });
}

// Пресъздава алармите; закъснелите се маркират според това дали браузърът е бил затворен.
async function rehydrate({ afterBrowserStart = false } = {}) {
  await ensureWatchdog();
  const tasks = await getTasks();
  const now = Date.now();
  let changed = false;

  for (const t of tasks) {
    if (t.status === "running") {
      // Прекъснато изпълнение (рестарт по средата) — върни в опашката.
      t.status = "pending";
      changed = true;
    }
    if (t.status !== "pending") continue;

    if (t.when <= now) {
      if (afterBrowserStart || now - t.when > LATE_GRACE_MS) {
        t.status = "missed";
        changed = true;
      } else {
        runTask(t.id);
      }
    } else {
      await scheduleAlarm(t);
    }
  }
  if (changed) await setTasks(tasks);
  await updateBadge(tasks);
}

chrome.runtime.onInstalled.addListener(async () => {
  try { await chrome.storage.local.remove("knownModels"); } catch (_) {}
  await loadSettings();
  await rehydrate();
});
chrome.runtime.onStartup.addListener(() => rehydrate({ afterBrowserStart: true }));

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === WATCHDOG) {
    await watchdogSweep();
    return;
  }
  if (alarm.name.startsWith(ALARM_PREFIX)) {
    runTask(alarm.name.slice(ALARM_PREFIX.length));
  }
});

// Хваща задачи, чиято аларма не е сработила (заспал worker, приспиване на машината).
async function watchdogSweep() {
  const tasks = await getTasks();
  const now = Date.now();
  let changed = false;

  for (const t of tasks) {
    if (t.status !== "pending" || t.when > now) continue;
    if (now - t.when <= LATE_GRACE_MS) {
      runTask(t.id);
    } else {
      t.status = "missed";
      changed = true;
    }
  }
  if (changed) await setTasks(tasks);
}

// ---------- съобщения от popup ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "addTask") {
        const tasks = await getTasks();
        tasks.push(msg.task);
        await setTasks(tasks);
        await scheduleAlarm(msg.task);
        await ensureWatchdog();
        sendResponse({ ok: true });
      } else if (msg.type === "updateTask") {
        const tasks = await getTasks();
        const idx = tasks.findIndex((t) => t.id === msg.task.id);
        if (idx !== -1) {
          await clearAlarm(msg.task.id);
          tasks[idx] = {
            ...tasks[idx],
            ...msg.task,
            status: "pending",
            error: null,
            attempts: 0,
            finishedAt: null,
          };
          await setTasks(tasks);
          await scheduleAlarm(tasks[idx]);
        }
        sendResponse({ ok: true });
      } else if (msg.type === "deleteTask") {
        const tasks = (await getTasks()).filter((t) => t.id !== msg.id);
        await setTasks(tasks);
        await clearAlarm(msg.id);
        sendResponse({ ok: true });
      } else if (msg.type === "clearDone") {
        const tasks = (await getTasks()).filter(
          (t) => t.status === "pending" || t.status === "missed" || t.status === "running"
        );
        await setTasks(tasks);
        sendResponse({ ok: true });
      } else if (msg.type === "runNow") {
        await clearAlarm(msg.id);
        await patchTask(msg.id, { attempts: 0, force: Date.now() });
        runTask(msg.id);
        sendResponse({ ok: true });
      } else if (msg.type === "getPageInfo") {
        sendResponse(await getPageInfo());
      } else if (msg.type === "getSettings") {
        sendResponse({ ok: true, ...(await loadSettings()) });
      } else {
        sendResponse({ ok: false, error: "Непозната команда." });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e.message || e) });
    }
  })();
  return true;
});

// ---------- информация за текущата страница ----------

// 1) активният раздел, ако е claude.ai; 2) последно ползваният раздел с claude.ai
async function activeClaudeTab() {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && /^https:\/\/claude\.ai\//i.test(active.url || "")) {
    return { tab: active, fallback: false };
  }
  const all = await chrome.tabs.query({ url: "https://claude.ai/*" });
  if (!all.length) return { tab: null, fallback: false };
  all.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  const chat = all.find((t) => /claude\.ai\/chat\//i.test(t.url || "")) || all[0];
  return { tab: chat, fallback: true };
}

async function getPageInfo() {
  const store = await chrome.storage.local.get(["defaultModel", "lastModel"]);
  const settings = await loadSettings();
  const { tab, fallback } = await activeClaudeTab();
  const base = {
    ok: true,
    onClaude: Boolean(tab),
    fallback,
    chatId: "",
    title: "",
    model: "",
    effort: "",
    isNew: false,
    defaultModel: store.defaultModel || "",
    lastModel: store.lastModel || "",
  };
  if (!tab) return base;

  const urlId = (tab.url.match(/claude\.ai\/chat\/([0-9a-f-]{8,})/i) || [])[1] || "";
  base.chatId = urlId;
  base.title = (tab.title || "").replace(/\s*[-–—|·]\s*Claude\s*$/i, "").trim();

  await ensureContentScript(tab.id, 4);
  const res = await askTab(tab.id, { type: "getPageInfo", settings }, 2, 400);
  if (res && res.ok) {
    base.chatId = res.chatId || urlId;
    base.title = res.title || base.title;
    base.model = res.model || "";
    base.effort = res.effort || "";
    base.isNew = Boolean(res.isNew);
  }
  return base;
}

// ---------- изпълнение ----------

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message,
    });
  } catch (_) {}
}

async function runTask(id) {
  const tasks = await getTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  if (task.status !== "pending" && task.status !== "missed") return;

  task.status = "running";
  task.error = null;
  await setTasks(tasks);

  let previousTab = null;
  try {
    previousTab = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0] || null;
  } catch (_) {}

  try {
    const tab = await openTarget(task);
    await waitForTabReady(tab.id);
    const injected = await ensureContentScript(tab.id);
    if (!injected) throw new Error("Скриптът не можа да се зареди в страницата.");

    const settings = await loadSettings();
    const res = await askTab(
      tab.id,
      {
        type: "executeTask",
        task: {
          taskId: `${task.id}#${task.force || 0}`,
          attempt: task.attempts || 0,
          message: task.message,
          model: task.model || "",
          effort: task.effort || "",
          settings,
          chatMode: task.chatMode,
        },
      },
      3
    );

    if (!res) throw new Error("Страницата не отговори навреме.");
    if (!res.ok) throw new Error(res.error || "Неизвестна грешка в страницата.");

    await patchTask(id, {
      status: "done",
      finishedAt: Date.now(),
      error: null,
      warning: res.modelWarning || null,
      usedModel: res.model || task.model || "",
      chatId: res.chatId || task.chatId || "",
    });

    notify(
      "Claude Scheduler ✓",
      res.skipped
        ? `Съобщението вече беше в разговора (${task.time}).`
        : res.modelWarning
        ? `Изпратено (${task.time}), но: ${res.modelWarning}`
        : `Изпратено в ${task.time}${res.model ? " · " + res.model : ""}.`
    );

    // Върни фокуса там, където е бил потребителят.
    if (previousTab && previousTab.id !== tab.id) {
      try {
        await chrome.tabs.update(previousTab.id, { active: true });
        await chrome.windows.update(previousTab.windowId, { focused: true });
      } catch (_) {}
    }
  } catch (e) {
    const attempts = (task.attempts || 0) + 1;
    const message = String(e.message || e);

    if (attempts < MAX_ATTEMPTS) {
      const next = Date.now() + RETRY_DELAY_MS;
      const updated = await patchTask(id, {
        status: "pending",
        attempts,
        when: next,
        error: `Опит ${attempts}/${MAX_ATTEMPTS} неуспешен: ${message}`,
      });
      if (updated) await scheduleAlarm(updated);
    } else {
      await patchTask(id, {
        status: "failed",
        attempts,
        finishedAt: Date.now(),
        error: message,
      });
      notify("Claude Scheduler ✗", `Неуспешно след ${attempts} опита: ${message}`);
    }
  }
}

async function openTarget(task) {
  if (task.chatMode === "existing" && task.chatId) {
    const found = await chrome.tabs.query({ url: `https://claude.ai/chat/${task.chatId}*` });
    if (found.length) {
      const tab = found[0];
      await chrome.tabs.update(tab.id, { active: true });
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
      return await chrome.tabs.get(tab.id);
    }
    return await chrome.tabs.create({ url: `https://claude.ai/chat/${task.chatId}`, active: true });
  }
  return await chrome.tabs.create({ url: "https://claude.ai/new", active: true });
}

function waitForTabReady(tabId, timeoutMs = 40000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      if (!chrome.runtime.lastError && tab && tab.status === "complete") finish();
    });
    setTimeout(finish, timeoutMs);
  });
}

// Ако скриптът липсва (стар раздел, презаредена добавка) — инжектира го.
async function ensureContentScript(tabId, tries = 20) {
  const ping = await askTab(tabId, { type: "ping" }, 1, 1200);
  if (ping && ping.ok) return true;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (_) {
    return false;
  }
  for (let i = 0; i < tries; i++) {
    const p = await askTab(tabId, { type: "ping" }, 1, 1200);
    if (p && p.ok) return true;
    await sleep(700);
  }
  return false;
}

// Изпраща съобщение с повторения (SPA-то може още да не е готово).
async function askTab(tabId, payload, attempts = 3, gapMs = 2500) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, payload);
      if (res !== undefined) return res;
    } catch (_) {}
    if (i < attempts - 1) await sleep(gapMs);
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ако worker-ът се събуди по друга причина — увери се, че пазачът е жив.
ensureWatchdog();
