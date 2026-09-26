// Claude Scheduler — content script (claude.ai)
// Отговаря на: ping, getPageInfo, executeTask. Моделите идват от settings.json (през background).
// Пази се от двойно зареждане (скриптът може да бъде инжектиран и ръчно).

(() => {
  if (window.__claudeSchedulerContentLoaded) return;
  window.__claudeSchedulerContentLoaded = true;

  // ---------- общи помощни ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeoutMs = 30000, pollMs = 250) {
    const start = Date.now();
    for (;;) {
      let v = null;
      try { v = fn(); } catch (_) {}
      if (v) return v;
      if (Date.now() - start >= timeoutMs) return null;
      await sleep(pollMs);
    }
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none";
  }

  function chatIdFromUrl(url = location.href) {
    const m = String(url).match(/claude\.ai\/chat\/([0-9a-f-]{8,})/i);
    return m ? m[1] : "";
  }

  function isNewChatPage() {
    return /claude\.ai\/(new|recents)?\/?$/i.test(location.href) && !chatIdFromUrl();
  }

  function pageTitle() {
    const t = document.title.replace(/\s*[-–—|·]\s*Claude\s*$/i, "").trim();
    return t && !/^claude$/i.test(t) ? t : "";
  }

  // ---------- намиране на елементи ----------

  function findEditor() {
    const selectors = [
      'div[contenteditable="true"][data-testid="chat-input"]',
      'div[contenteditable="true"][aria-label*="prompt" i]',
      'div.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea[data-testid="chat-input"]',
    ];
    for (const s of selectors) {
      for (const el of document.querySelectorAll(s)) {
        if (isVisible(el)) return el;
      }
    }
    return null;
  }

  function composerRoot(editor) {
    if (!editor) return document.body;
    return (
      editor.closest("form") ||
      editor.closest('[data-testid="composer"]') ||
      editor.parentElement?.parentElement?.parentElement ||
      document.body
    );
  }

  function findSendButton(editor) {
    const selectors = [
      'button[aria-label="Send message" i]',
      'button[data-testid="send-button"]',
      'button[aria-label*="send message" i]',
      'button[aria-label*="send" i]',
      'button[aria-label*="изпрати" i]',
    ];
    for (const s of selectors) {
      for (const el of document.querySelectorAll(s)) {
        if (isVisible(el)) return el;
      }
    }
    // Резервно: последният активен бутон в композера (без прикачване/модел/микрофон).
    const root = composerRoot(editor);
    const skip = /attach|upload|file|model|tool|research|style|voice|dictate|microphone|прикачи/i;
    const cands = [...root.querySelectorAll("button")].filter((b) => {
      if (!isVisible(b) || b.disabled) return false;
      const label = (b.getAttribute("aria-label") || "") + " " + (b.getAttribute("data-testid") || "");
      if (skip.test(label)) return false;
      return (b.textContent || "").trim().length === 0 && b.querySelector("svg");
    });
    return cands.length ? cands[cands.length - 1] : null;
  }

  // Клод пише в момента → има бутон „стоп" вместо „изпрати".
  function isGenerating() {
    const stop = document.querySelector(
      'button[aria-label*="stop" i], button[data-testid="stop-button"], button[aria-label*="спри" i]'
    );
    return Boolean(stop && isVisible(stop));
  }

  // ---------- настройки (идват от settings.json през background) ----------

  const BASE_WORDS = ["opus", "sonnet", "haiku", "fable", "mythos"];
  let cfg = {
    models: [],
    effort: ["Low", "Medium", "High", "Extra", "Max"],
    menuLabels: { moreModels: ["More models"], effort: ["Effort"] },
  };

  function applySettings(s) {
    if (!s || typeof s !== "object") return;
    cfg = {
      models: Array.isArray(s.models) ? s.models : cfg.models,
      effort: Array.isArray(s.effort) ? s.effort : cfg.effort,
      menuLabels: s.menuLabels || cfg.menuLabels,
    };
  }

  try {
    chrome.storage.local.get("settingsCache").then(({ settingsCache }) => applySettings(settingsCache));
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === "local" && ch.settingsCache) applySettings(ch.settingsCache.newValue);
    });
  } catch (_) {}

  // Семействата модели (opus, sonnet, …) + първата дума на всеки модел от settings.json.
  function modelWords() {
    const words = new Set([...BASE_WORDS, "claude"]);
    for (const m of cfg.models) {
      const w = String(m).trim().split(/\s+/)[0];
      if (w) words.add(w.toLowerCase());
    }
    return [...words];
  }

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function modelRe() {
    const fam = modelWords().filter((w) => w !== "claude").map(escapeRe).join("|");
    return new RegExp(`(?:^|\\s)((?:${fam})\\s*\\d+(?:\\.\\d+)?)(?![\\d.])`, "i");
  }

  // Целият видим текст на елемента, с интервали между отделните части.
  function leafText(el) {
    if (!el) return "";
    const parts = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) {
      const t = (w.currentNode.nodeValue || "").trim();
      if (t) parts.push(t);
    }
    return parts.join(" ").replace(/[\u200B-\u200D\u2060\uFEFF\uFFFD\uE000-\uF8FF]/g, "").replace(/\s+/g, " ").trim();
  }

  function norm(s) {
    return cleanModelName(s).toLowerCase().replace(/\s+/g, " ").trim();
  }

  // „Opus 5.5 Most capable…“ → „Opus 5.5“
  function extractModel(text) {
    const m = String(text || "").match(modelRe());
    return m ? m[1].replace(/\s+/g, " ").trim() : "";
  }

  // Точно сравнение: „Opus 5“ ≠ „Opus 5.5“, „Fable 5“ ≠ „Fable 5.1“.
  function sameModel(a, b) {
    const x = norm(extractModel(a) || a);
    const y = norm(extractModel(b) || b);
    return Boolean(x) && x === y;
  }

  // 2 = текстът започва с модела, 1 = съдържа го като цяла дума, 0 = не.
  function modelScore(text, wanted) {
    const t = norm(text);
    const w = norm(wanted);
    if (!t || !w) return 0;
    const tail = "(?![\\d.])";
    if (new RegExp(`^${escapeRe(w)}${tail}`).test(t)) return 2;
    if (new RegExp(`(?:^|\\s)${escapeRe(w)}${tail}`).test(t)) return 1;
    return 0;
  }

  function startsWithLabel(text, labels) {
    const t = norm(text);
    return (labels || []).some((l) => l && t.startsWith(norm(l)));
  }

  // ---------- бутонът за модел ----------

  function findModelTrigger() {
    const words = modelWords();
    const direct = document.querySelector('button[data-testid="model-selector-dropdown"]');
    if (direct && isVisible(direct)) return direct;

    const editor = findEditor();
    const root = composerRoot(editor);
    const scopes = [root, document.body];
    for (const scope of scopes) {
      for (const b of scope.querySelectorAll('button[aria-haspopup], button[id*="model" i], button[data-testid*="model" i]')) {
        const t = leafText(b).toLowerCase();
        if (isVisible(b) && t.length < 60 && words.some((w) => t.includes(w))) return b;
      }
    }
    for (const b of document.querySelectorAll("button")) {
      const t = leafText(b);
      if (!isVisible(b) || t.length === 0 || t.length > 40) continue;
      if (words.some((w) => t.toLowerCase().includes(w)) && b.querySelector("svg")) return b;
    }
    return null;
  }

  function cleanModelName(raw) {
    let s = String(raw || "")
      .replace(/[\u200B-\u200D\u2060\uFEFF\uFFFD\uE000-\uF8FF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    s = s.replace(/^claude\s+/i, "");
    s = s.replace(/\b(new|нов|beta|preview)\b\s*$/i, "").trim();
    s = s.replace(/[^\p{L}\p{N})\]]+$/gu, "").trim();
    return s;
  }

  function readCurrentModel() {
    const trigger = findModelTrigger();
    if (!trigger) return "";
    const text = leafText(trigger);
    const found = extractModel(text);
    if (found) return found;
    // Резерва за непознато име: най-краткият текст с дума за модел.
    const words = modelWords();
    const leaves = [...trigger.querySelectorAll("*")].filter((n) => n.children.length === 0);
    const texts = [trigger.textContent, ...leaves.map((n) => n.textContent)]
      .map((t) => cleanModelName(t))
      .filter((t) => t && t.length <= 40 && words.some((w) => t.toLowerCase().includes(w)));
    return texts.length ? texts.sort((a, b) => a.length - b.length)[0] : "";
  }

  // Усилието се показва до модела в бутона („Opus 5.5 High“). При „по подразбиране“ може да липсва.
  function readCurrentEffort() {
    const trigger = findModelTrigger();
    if (!trigger) return "";
    const tokens = leafText(trigger).toLowerCase().split(/\s+/);
    for (const lvl of cfg.effort) {
      if (tokens.includes(String(lvl).toLowerCase())) return lvl;
    }
    return "";
  }

  // ---------- работа с менюто ----------

  function menuItems() {
    const nodes = document.querySelectorAll(
      '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="menu"] button'
    );
    return [...nodes].filter(isVisible);
  }

  function isSubTrigger(el) {
    return (
      el.getAttribute("aria-haspopup") === "menu" ||
      el.getAttribute("aria-haspopup") === "true" ||
      startsWithLabel(leafText(el), cfg.menuLabels.moreModels) ||
      startsWithLabel(leafText(el), cfg.menuLabels.effort)
    );
  }

  function modelMenuOpen() {
    return menuItems().some((it) => extractModel(leafText(it)));
  }

  function findModelItem(wanted) {
    let best = null;
    let bestScore = 0;
    for (const it of menuItems()) {
      if (isSubTrigger(it)) continue;
      const s = modelScore(leafText(it), wanted);
      if (s > bestScore) {
        best = it;
        bestScore = s;
      }
    }
    return best;
  }

  function findLabeledItem(labels) {
    return menuItems().find((it) => startsWithLabel(leafText(it), labels)) || null;
  }

  function findEffortItem(level) {
    const w = String(level).toLowerCase();
    const re = new RegExp(`^${escapeRe(w)}(?![a-zа-я])`, "i");
    return (
      menuItems().find((it) => !isSubTrigger(it) && re.test(leafText(it).toLowerCase())) || null
    );
  }

  function anyEffortItem() {
    return cfg.effort.some((l) => findEffortItem(l));
  }

  function pointerAt(el, type, extra = {}) {
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      button: 0,
      buttons: type.includes("down") ? 1 : 0,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      ...extra,
    };
    const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, opts));
  }

  function hover(el) {
    for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) {
      pointerAt(el, t);
    }
  }

  function press(el) {
    for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup"]) pointerAt(el, t);
  }

  function key(el, k) {
    const codes = { Enter: 13, Escape: 27, ArrowRight: 39, ArrowDown: 40, " ": 32 };
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, code: k === " " ? "Space" : k, keyCode: codes[k], which: codes[k], bubbles: true, cancelable: true })
    );
  }

  // Отваря главното меню. Пробва няколко начина, защото claude.ai сменя поведението.
  async function openModelMenu() {
    const trigger = await waitFor(findModelTrigger, 15000);
    if (!trigger) throw new Error("Не намерих бутона за избор на модел.");
    if (modelMenuOpen()) return trigger;

    const ways = [
      () => trigger.click(),
      () => press(trigger),
      () => { trigger.focus(); key(trigger, "Enter"); },
      () => { trigger.focus(); key(trigger, "ArrowDown"); },
    ];
    for (const way of ways) {
      way();
      if (await waitFor(() => (modelMenuOpen() ? true : null), 1500, 150)) return trigger;
    }
    throw new Error("Менюто за модели не се отвори.");
  }

  // Отваря подменю („More models“, „Effort“) и чака да се появи съдържанието му.
  async function openSubmenu(item, ready) {
    const ways = [
      () => { item.scrollIntoView({ block: "nearest" }); hover(item); },
      () => item.click(),
      () => { item.focus(); key(item, "ArrowRight"); },
      () => { item.focus(); key(item, "Enter"); },
    ];
    for (const way of ways) {
      way();
      const ok = await waitFor(() => (ready() ? true : null), 1300, 150);
      if (ok) return true;
    }
    return false;
  }

  async function closeMenus(trigger) {
    for (let i = 0; i < 3 && menuItems().length; i++) {
      for (const target of [document.activeElement || document.body, document.body]) {
        target.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true })
        );
      }
      await sleep(250);
    }
    if (menuItems().length && trigger) {
      trigger.click();
      await sleep(250);
    }
  }

  async function activate(item) {
    item.click();
    await sleep(700);
    if (isVisible(item)) {
      // Някои менюта реагират само на pointer/Enter.
      press(item);
      await sleep(400);
      if (isVisible(item)) {
        item.focus();
        key(item, "Enter");
        await sleep(400);
      }
    }
  }

  async function selectModel(modelName) {
    const wanted = cleanModelName(modelName);
    if (!wanted) return { changed: false };

    await waitFor(findModelTrigger, 15000);
    const before = readCurrentModel();
    if (before && sameModel(before, wanted)) return { changed: false, current: before };

    const trigger = await openModelMenu();
    let pick = await waitFor(() => findModelItem(wanted), 1200, 150);

    // Няма го в основното меню → „More models“.
    if (!pick) {
      const more = findLabeledItem(cfg.menuLabels.moreModels);
      if (more) {
        await openSubmenu(more, () => findModelItem(wanted));
        pick = await waitFor(() => findModelItem(wanted), 1500, 150);
      }
    }

    if (!pick) {
      await closeMenus(trigger);
      throw new Error(`Моделът „${modelName}" не е намерен в менюто (нито в „More models"). Проверете името в settings.json.`);
    }

    await activate(pick);
    await closeMenus(trigger);

    const now = readCurrentModel();
    if (now && !sameModel(now, wanted)) {
      throw new Error(`Моделът не беше сменен (остана „${now}"). Ако е модел с кредити, може да изисква покупка.`);
    }
    return { changed: true, current: now };
  }

  async function selectEffort(level) {
    const wanted = String(level || "").trim();
    if (!wanted) return { changed: false };

    const before = readCurrentEffort();
    if (before && before.toLowerCase() === wanted.toLowerCase()) return { changed: false };

    const trigger = await openModelMenu();
    const effortItem = await waitFor(() => findLabeledItem(cfg.menuLabels.effort), 1500, 150);
    if (!effortItem) {
      await closeMenus(trigger);
      throw new Error("Този модел няма настройка за усилие (Effort).");
    }

    await openSubmenu(effortItem, anyEffortItem);
    const pick = await waitFor(() => findEffortItem(wanted), 1500, 150);
    if (!pick) {
      await closeMenus(trigger);
      throw new Error(`Нивото „${wanted}" не е намерено в менюто за усилие.`);
    }

    await activate(pick);
    await closeMenus(trigger);

    const now = readCurrentEffort();
    if (now && now.toLowerCase() !== wanted.toLowerCase()) {
      throw new Error(`Усилието не беше сменено (остана „${now}").`);
    }
    return { changed: true };
  }

  // ---------- въвеждане и изпращане ----------

  function editorText(editor) {
    if (!editor) return "";
    if (editor.tagName === "TEXTAREA") return editor.value;
    return editor.innerText || editor.textContent || "";
  }

  async function typeMessage(editor, text) {
    editor.scrollIntoView({ block: "center" });
    editor.focus();
    await sleep(150);
    editor.click();
    await sleep(150);

    if (editor.tagName === "TEXTAREA") {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
      setter.call(editor, text);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(200);
      if (editorText(editor).trim()) return;
      throw new Error("Не успях да въведа текста.");
    }

    // 1) Изчисти старото съдържание
    selectAll(editor);
    try { document.execCommand("delete", false); } catch (_) {}
    await sleep(100);

    // 2) execCommand insertText (ProseMirror го прихваща като beforeinput)
    selectAll(editor);
    try { document.execCommand("insertText", false, text); } catch (_) {}
    await sleep(250);
    if (matches(editor, text)) return;

    // 3) Симулиран paste
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      editor.focus();
      editor.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })
      );
    } catch (_) {}
    await sleep(350);
    if (matches(editor, text)) return;

    // 4) beforeinput + директна DOM промяна (последен вариант)
    try {
      editor.focus();
      editor.dispatchEvent(
        new InputEvent("beforeinput", {
          inputType: "insertText",
          data: text,
          bubbles: true,
          cancelable: true,
        })
      );
      await sleep(250);
      if (matches(editor, text)) return;

      editor.innerHTML = "";
      for (const line of text.split("\n")) {
        const p = document.createElement("p");
        p.textContent = line;
        editor.appendChild(p);
      }
      placeCaretAtEnd(editor);
      editor.dispatchEvent(new InputEvent("input", { inputType: "insertText", bubbles: true }));
    } catch (_) {}
    await sleep(300);

    if (!editorText(editor).trim()) {
      throw new Error("Не успях да въведа текста в полето за писане.");
    }
  }

  function matches(editor, text) {
    const a = editorText(editor).replace(/\s+/g, " ").trim();
    const b = text.replace(/\s+/g, " ").trim();
    return a.length > 0 && (a === b || a.includes(b.slice(0, Math.min(40, b.length))));
  }

  function selectAll(editor) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function placeCaretAtEnd(editor) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  async function clickSend(editor, text) {
    // Изчакай, ако Клод още пише отговор на предишно съобщение.
    await waitFor(() => (isGenerating() ? null : true), 120000, 1000);

    const btn = await waitFor(() => {
      const b = findSendButton(editor);
      if (!b) return null;
      const disabled = b.disabled || b.getAttribute("aria-disabled") === "true";
      return disabled ? null : b;
    }, 12000);

    if (btn) {
      btn.click();
      if (await sentOk(editor, text, 9000)) return;
    }

    // Резервно: Enter в редактора
    editor.focus();
    for (const type of ["keydown", "keypress", "keyup"]) {
      editor.dispatchEvent(
        new KeyboardEvent(type, {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        })
      );
    }
    if (await sentOk(editor, text, 9000)) return;

    throw new Error("Съобщението не беше изпратено (бутонът не реагира).");
  }

  // Успех = полето се е изпразнило (или текстът е изчезнал от него).
  async function sentOk(editor, text, timeoutMs) {
    const ok = await waitFor(() => {
      const cur = editorText(editor).replace(/\s+/g, " ").trim();
      if (!cur) return true;
      return cur.includes(text.replace(/\s+/g, " ").trim().slice(0, 20)) ? null : true;
    }, timeoutMs, 300);
    return Boolean(ok);
  }

  // Последното изпратено от потребителя съобщение в разговора.
  function lastUserMessage() {
    const nodes = document.querySelectorAll(
      '[data-testid="user-message"], [data-test-render-count] [data-testid="user-message"]'
    );
    if (!nodes.length) return "";
    return (nodes[nodes.length - 1].innerText || "").replace(/\s+/g, " ").trim();
  }

  function alreadySent(text) {
    const last = lastUserMessage();
    if (!last) return false;
    const wanted = String(text).replace(/\s+/g, " ").trim();
    return last === wanted || last.startsWith(wanted.slice(0, 60));
  }

  async function executeTask(task) {
    // При повторен опит първо проверяваме дали съобщението вече не е стигнало.
    if (task.attempt > 0 && alreadySent(task.message)) {
      return { skipped: true, model: readCurrentModel(), chatId: chatIdFromUrl() };
    }

    const editor = await waitFor(findEditor, 60000, 400);
    if (!editor) {
      throw new Error("Не намерих полето за писане (влезли ли сте в claude.ai?).");
    }

    if (task.settings) applySettings(task.settings);

    const warnings = [];
    if (task.model) {
      try {
        await selectModel(task.model);
      } catch (e) {
        warnings.push(String(e.message || e));
      }
    }
    if (task.effort) {
      try {
        await selectEffort(task.effort);
      } catch (e) {
        warnings.push(String(e.message || e));
      }
    }
    await closeMenus(findModelTrigger());
    const modelWarning = warnings.length ? warnings.join(" ") : null;

    await typeMessage(editor, task.message);
    await clickSend(editor, task.message);

    return {
      modelWarning,
      model: readCurrentModel(),
      chatId: chatIdFromUrl(),
    };
  }

  // ---------- съобщения от background/popup ----------

  // Пази какво вече е изпълнено в тази страница, за да не се изпрати два пъти,
  // ако отговорът до background-а се загуби (пренасочване, заспал worker).
  const taskState = new Map();

  function handleExecute(msg, sendResponse) {
    const key = msg.task.taskId || msg.task.message;
    const prev = taskState.get(key);

    if (prev) {
      if (prev.status === "done") {
        sendResponse({ ok: true, ...prev.result, deduped: true });
        return;
      }
      if (prev.status === "running") {
        prev.promise
          .then((r) => sendResponse({ ok: true, ...r, deduped: true }))
          .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
        return;
      }
    }

    const promise = executeTask(msg.task);
    taskState.set(key, { status: "running", promise });
    promise
      .then((r) => {
        taskState.set(key, { status: "done", result: r });
        sendResponse({ ok: true, ...r });
      })
      .catch((e) => {
        taskState.delete(key); // позволи нов опит
        sendResponse({ ok: false, error: String(e.message || e) });
      });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === "ping") {
      sendResponse({ ok: true });
      return; // синхронно
    }

    if (msg.type === "getPageInfo") {
      if (msg.settings) applySettings(msg.settings);
      sendResponse({
        ok: true,
        url: location.href,
        chatId: chatIdFromUrl(),
        isNew: isNewChatPage(),
        title: pageTitle(),
        model: readCurrentModel(),
        effort: readCurrentEffort(),
        hasEditor: Boolean(findEditor()),
      });
      return;
    }

    if (msg.type === "executeTask") {
      handleExecute(msg, sendResponse);
      return true;
    }
  });

  // При зареждане запомни текущия модел (за показване в popup-а).
  setTimeout(async () => {
    const model = readCurrentModel();
    if (!model) return;
    try {
      const key = isNewChatPage() ? "defaultModel" : "lastModel";
      await chrome.storage.local.set({ [key]: model, lastModel: model });
    } catch (_) {}
  }, 2500);
})();
