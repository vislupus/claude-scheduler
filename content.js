// Claude Scheduler — content script (claude.ai)
// Отговаря на: ping, getPageInfo, scanModels, executeTask.
// Пази се от двойно зареждане (скриптът може да бъде инжектиран и ръчно).

(() => {
  if (window.__claudeSchedulerContentLoaded) return;
  window.__claudeSchedulerContentLoaded = true;

  const MODEL_WORDS = ["opus", "sonnet", "haiku", "fable", "mythos", "claude"];

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

  function findModelTrigger() {
    const direct = document.querySelector('button[data-testid="model-selector-dropdown"]');
    if (direct && isVisible(direct)) return direct;

    const editor = findEditor();
    const root = composerRoot(editor);
    const scopes = [root, document.body];
    for (const scope of scopes) {
      for (const b of scope.querySelectorAll('button[aria-haspopup], button[id*="model" i], button[data-testid*="model" i]')) {
        const t = (b.textContent || "").toLowerCase();
        if (isVisible(b) && t.length < 60 && MODEL_WORDS.some((w) => t.includes(w))) return b;
      }
    }
    for (const b of document.querySelectorAll("button")) {
      const t = (b.textContent || "").trim();
      if (!isVisible(b) || t.length === 0 || t.length > 40) continue;
      if (MODEL_WORDS.some((w) => t.toLowerCase().includes(w)) && b.querySelector("svg")) return b;
    }
    return null;
  }

  function cleanModelName(raw) {
    let s = String(raw || "")
      // Махва скрити, private-use и повредени Unicode символи
      .replace(/[\u200B-\u200D\u2060\uFEFF\uFFFD\uE000-\uF8FF]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    s = s.replace(/^claude\s+/i, "");
    s = s.replace(/\b(new|нов|beta|preview)\b\s*$/i, "").trim();

    // Махва останали квадратчета/иконки в края на името
    s = s.replace(/[^\p{L}\p{N})\]]+$/gu, "").trim();

    return s;
  }

  function readCurrentModel() {
    const trigger = findModelTrigger();
    if (!trigger) return "";
    // Взимаме най-краткия смислен текст в бутона (за да отрежем описания).
    const leaves = [...trigger.querySelectorAll("*")].filter((n) => n.children.length === 0);
    const texts = [trigger.textContent, ...leaves.map((n) => n.textContent)]
      .map((t) => cleanModelName(t))
      .filter((t) => t && t.length <= 40 && MODEL_WORDS.some((w) => t.toLowerCase().includes(w)));
    if (!texts.length) return "";
    return texts.sort((a, b) => a.length - b.length)[0];
  }

  // ---------- списък с модели ----------

  function menuItems() {
    const nodes = document.querySelectorAll(
      '[role="menuitem"], [role="menuitemradio"], [role="option"], [role="menu"] button, [role="listbox"] [role="option"]'
    );
    return [...nodes].filter(isVisible);
  }

  function labelOfItem(item) {
    const leaves = [...item.querySelectorAll("*")].filter((n) => n.children.length === 0);
    const texts = [...leaves.map((n) => n.textContent), item.textContent]
      .map((t) => cleanModelName(t))
      .filter((t) => t && t.length <= 40 && MODEL_WORDS.some((w) => t.toLowerCase().includes(w)));
    if (!texts.length) return "";
    return texts.sort((a, b) => a.length - b.length)[0];
  }

  function readOpenMenuModels() {
    const out = [];
    for (const it of menuItems()) {
      const label = labelOfItem(it);
      if (label && !out.includes(label)) out.push(label);
    }
    return out;
  }

  async function cacheModels(models) {
    if (!models || models.length < 2) return;
    try {
      const { knownModels = [] } = await chrome.storage.local.get("knownModels");
      const merged = [...models];
      for (const m of knownModels) if (!merged.includes(m)) merged.push(m);
      await chrome.storage.local.set({ knownModels: merged.slice(0, 15) });
    } catch (_) {}
  }

  // Учим списъка тихо: когато потребителят сам отвори менюто за модели.
  let observeTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(observeTimer);
    observeTimer = setTimeout(() => {
      const models = readOpenMenuModels();
      if (models.length >= 2) cacheModels(models);
    }, 350);
  });
  try {
    observer.observe(document.body, { childList: true, subtree: true });
  } catch (_) {}

  // Явно сканиране (по заявка от popup-а): отваря и веднага затваря менюто.
  async function scanModels() {
    const trigger = await waitFor(findModelTrigger, 8000);
    if (!trigger) return { models: [], current: "" };
    const before = readCurrentModel();
    trigger.click();
    const models = (await waitFor(() => {
      const m = readOpenMenuModels();
      return m.length >= 2 ? m : null;
    }, 4000)) || [];
    closeMenu(trigger);
    await cacheModels(models);
    return { models, current: before };
  }

  function closeMenu(trigger) {
    for (const target of [document.activeElement || document.body, document.body]) {
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true })
      );
    }
    setTimeout(() => {
      if (menuItems().length && trigger) trigger.click();
    }, 250);
  }

  async function selectModel(modelName) {
    const wanted = cleanModelName(modelName).toLowerCase();
    if (!wanted) return { changed: false };

    const trigger = await waitFor(findModelTrigger, 15000);
    if (!trigger) throw new Error("Не намерих менюто за избор на модел.");

    const current = readCurrentModel().toLowerCase();
    if (current && (current === wanted || current.includes(wanted) || wanted.includes(current))) {
      return { changed: false, current: readCurrentModel() };
    }

    trigger.click();
    await sleep(400);

    const pick = await waitFor(() => {
      const items = menuItems();
      // 1) точно съвпадение
      for (const it of items) {
        if (labelOfItem(it).toLowerCase() === wanted) return it;
      }
      // 2) частично съвпадение
      for (const it of items) {
        const l = labelOfItem(it).toLowerCase();
        if (l && (l.includes(wanted) || wanted.includes(l))) return it;
      }
      return null;
    }, 6000);

    if (!pick) {
      closeMenu(trigger);
      throw new Error(`Моделът „${modelName}" не е намерен в менюто.`);
    }

    pick.click();
    await sleep(700);

    // Провери дали смяната се е приложила
    const now = readCurrentModel().toLowerCase();
    if (now && !(now.includes(wanted) || wanted.includes(now))) {
      throw new Error(`Моделът не беше сменен (остана „${readCurrentModel()}").`);
    }
    return { changed: true, current: readCurrentModel() };
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

    let modelWarning = null;
    if (task.model) {
      try {
        await selectModel(task.model);
      } catch (e) {
        modelWarning = String(e.message || e);
      }
    }

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
      (async () => {
        const model = readCurrentModel();
        let known = [];
        try {
          ({ knownModels: known = [] } = await chrome.storage.local.get("knownModels"));
        } catch (_) {}
        sendResponse({
          ok: true,
          url: location.href,
          chatId: chatIdFromUrl(),
          isNew: isNewChatPage(),
          title: pageTitle(),
          model,
          models: known,
          hasEditor: Boolean(findEditor()),
        });
      })();
      return true;
    }

    if (msg.type === "scanModels") {
      scanModels()
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
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
