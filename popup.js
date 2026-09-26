// Claude Scheduler — popup

const form = document.getElementById("task-form");
const timeHoursInput = document.getElementById("time-hours");
const timeMinutesInput = document.getElementById("time-minutes");
const dateDayInput = document.getElementById("date-day");
const dateMonthInput = document.getElementById("date-month");
const dateYearInput = document.getElementById("date-year");
const timeField = document.getElementById("time-field");
const dateField = document.getElementById("date-field");
const fillNowBtn = document.getElementById("fill-now");
const chatIdInput = document.getElementById("chatId");
const chatIdRow = document.getElementById("chat-id-row");
const modelSelect = document.getElementById("model");
const modelNote = document.getElementById("model-note");
const pageNote = document.getElementById("page-note");
const useCurrentBtn = document.getElementById("use-current");
const effortSelect = document.getElementById("effort");
const quickHoursEl = document.getElementById("quick-hours");
const relativeNote = document.getElementById("relative-note");
const messageInput = document.getElementById("message");
const formError = document.getElementById("form-error");
const listEl = document.getElementById("task-list");
const emptyEl = document.getElementById("empty");
const nextTimeEl = document.getElementById("next-time");
const clearDoneBtn = document.getElementById("clear-done");
const submitBtn = document.getElementById("submit-btn");
const cancelEditBtn = document.getElementById("cancel-edit");
const formCard = form.closest(".card");

const DRAFT_KEY = "schedulerFormDraftV1";

let tasks = [];
let editingId = null;
let nowMode = false;
let chatIdManual = false;   // потребителят е писал ръчно в полето за чат
let pageInfo = null;        // последна информация за отворената страница
let pendingModelValue = "";  // модел от черновата, преди списъкът да е зареден
let pendingEffortValue = "";
let storeCache = { lastModel: "", defaultModel: "" };
let settings = { models: [], effort: [], quickHours: [3, 5, 10, 15], error: null };
let restoringDraft = false;
let lastFocus = { id: null, start: null, end: null };

// ---------- init ----------

(async function init() {
  prepareMaskedInputs();
  prepareDraftPersistence();
  preparePageControls();
  await restoreDraft();

  // Моделите, усилието и бързите бутони идват от settings.json.
  try {
    storeCache = {
      ...storeCache,
      ...(await chrome.storage.local.get(["lastModel", "defaultModel"])),
    };
  } catch (_) {}
  await loadSettings();
  renderQuickHours();
  populateModels(settings.models);
  populateEffort();
  updateModelNote();

  await loadTasks();

  // Информацията за отворената страница (чат + модел) се чете при всяко отваряне.
  refreshPageInfo();

  if (editingId && !tasks.some((task) => task.id === editingId)) {
    editingId = null;
    syncEditModeUi();
    await persistDraft();
  }

  restoreLastFocus();
  setInterval(tick, 1000);
  tick();
})();

// ---------- режим на разговора ----------

function chatMode() {
  const checked = form.querySelector('input[name="chatMode"]:checked');
  return checked ? checked.value : "existing";
}

function setChatMode(value) {
  const target = form.querySelector(
    `input[name="chatMode"][value="${value === "new" ? "new" : "existing"}"]`
  );
  if (target) target.checked = true;
}

// ---------- текуща страница и модели ----------

function preparePageControls() {
  chatIdInput.addEventListener("input", () => {
    chatIdManual = true;
  });

  useCurrentBtn.addEventListener("click", async () => {
    chatIdManual = false;
    await refreshPageInfo({ force: true });
    await persistDraft();
  });

  for (const r of form.querySelectorAll('input[name="chatMode"]')) {
    r.addEventListener("change", () => {
      populateEffort();
      updatePageNote();
      updateModelNote();
    });
  }
}

async function refreshPageInfo({ force = false } = {}) {
  try {
    const info = await chrome.runtime.sendMessage({ type: "getPageInfo" });
    if (!info || !info.ok) return;
    pageInfo = info;
    storeCache = {
      lastModel: info.lastModel || storeCache.lastModel,
      defaultModel: info.defaultModel || storeCache.defaultModel,
    };

    // Попълва ID-то от отворената страница, ако полето не е пипано ръчно.
    if ((!chatIdManual || force) && !editingId && info.chatId) {
      chatIdInput.value = info.chatId;
      await persistDraft();
    }

    populateModels(settings.models);
    populateEffort();
    updatePageNote();
    updateModelNote();
  } catch (_) {}
}

function updatePageNote() {
  if (!pageInfo) {
    pageNote.textContent = "Проверявам текущата страница…";
    pageNote.classList.remove("warn");
    return;
  }
  if (!pageInfo.onClaude) {
    pageNote.textContent = "Няма отворен раздел с claude.ai.";
    pageNote.classList.add("warn");
    return;
  }
  if (!pageInfo.chatId) {
    pageNote.textContent = "Отворената страница не е разговор (нов чат).";
    pageNote.classList.add("warn");
    return;
  }
  const title = pageInfo.title ? `„${pageInfo.title}"` : "разговор";
  const label = pageInfo.fallback ? "Последно отворен разговор" : "Текуща страница";
  const same = chatIdInput.value.trim().includes(pageInfo.chatId);
  pageNote.classList.remove("warn");
  pageNote.textContent = same
    ? `${label}: ${title}`
    : `${label}: ${title} · натиснете „От текущата страница", за да я използвате`;
}

async function loadSettings() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "getSettings" });
    if (res && res.ok) settings = res;
  } catch (e) {
    settings = { ...settings, error: "Не успях да прочета settings.json." };
  }
}

// Първата опция винаги е активният модел и означава „без промяна".
function populateModels(models) {
  const list = Array.isArray(models) ? models.filter(Boolean) : [];
  const wanted = pendingModelValue || modelSelect.value || "";
  const current = currentModelName();

  modelSelect.innerHTML = "";
  const keep = document.createElement("option");
  keep.value = "";
  keep.textContent = current ? `${current} · вече избран` : "Текущият на страницата";
  modelSelect.appendChild(keep);

  const seen = new Set();
  for (const name of list) {
    if (!name || seen.has(name)) continue;
    if (current && name.toLowerCase() === current.toLowerCase()) continue;
    seen.add(name);
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    modelSelect.appendChild(opt);
  }

  if (wanted && !seen.has(wanted)) {
    const opt = document.createElement("option");
    opt.value = wanted;
    opt.textContent = wanted;
    modelSelect.appendChild(opt);
  }

  modelSelect.value = wanted && [...modelSelect.options].some((o) => o.value === wanted) ? wanted : "";
  pendingModelValue = "";
}

// Усилие: първата опция = без промяна (показва текущото, ако се вижда).
function populateEffort() {
  const wanted = pendingEffortValue || effortSelect.value || "";
  const current = chatMode() === "existing" && pageInfo ? pageInfo.effort || "" : "";

  effortSelect.innerHTML = "";
  const keep = document.createElement("option");
  keep.value = "";
  keep.textContent = current ? `${current} ✓` : "Без промяна";
  effortSelect.appendChild(keep);

  const levels = [...(settings.effort || [])];
  if (wanted && !levels.includes(wanted)) levels.push(wanted);
  for (const lvl of levels) {
    if (current && lvl.toLowerCase() === current.toLowerCase()) continue;
    const opt = document.createElement("option");
    opt.value = lvl;
    opt.textContent = lvl;
    effortSelect.appendChild(opt);
  }

  effortSelect.value = [...effortSelect.options].some((o) => o.value === wanted) ? wanted : "";
  pendingEffortValue = "";
}

function currentModelName() {
  const src = pageInfo || storeCache;
  if (chatMode() === "new") {
    return src.defaultModel || storeCache.defaultModel || src.model || src.lastModel || storeCache.lastModel || "";
  }
  return src.model || src.lastModel || storeCache.lastModel || "";
}

function updateModelNote() {
  const current = currentModelName();
  const chosen = modelSelect.value;
  const effort = effortSelect.value;
  modelNote.classList.remove("warn");

  if (settings.error) {
    modelNote.textContent = settings.error;
    modelNote.classList.add("warn");
    return;
  }
  if (chosen || effort) {
    const parts = [];
    if (chosen) parts.push(`модел „${chosen}"`);
    if (effort) parts.push(`усилие „${effort}"`);
    modelNote.textContent = `Преди изпращане ще се превключи на ${parts.join(" и ")}.`;
    return;
  }
  if (chatMode() === "new") {
    modelNote.textContent = current
      ? `Нов разговор · по подразбиране: ${current}`
      : "Нов разговор · ще се използва моделът по подразбиране.";
    return;
  }
  const sameChat = pageInfo && pageInfo.chatId && chatIdInput.value.trim().includes(pageInfo.chatId);
  modelNote.textContent = current
    ? sameChat
      ? `В този разговор сега е избран: ${current}`
      : `Последно видян модел: ${current} · моделът на другия разговор ще се запази`
    : "Ще се използва моделът, избран в самия разговор.";
}

// ---------- draft persistence ----------

function prepareDraftPersistence() {
  form.addEventListener("input", persistDraft);
  form.addEventListener("change", persistDraft);

  form.addEventListener("focusin", (event) => {
    captureFocus(event.target);
    persistDraft();
  });

  form.addEventListener("keyup", (event) => captureFocus(event.target));
  form.addEventListener("click", (event) => captureFocus(event.target));
  form.addEventListener("select", (event) => captureFocus(event.target));

  // Последен опит за запис при затваряне на popup прозореца.
  window.addEventListener("pagehide", persistDraft);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persistDraft();
  });
}

function captureFocus(target) {
  if (
    !target ||
    !target.id ||
    !form.contains(target) ||
    !target.matches('input[type="text"], textarea')
  ) {
    return;
  }
  const supportsSelection =
    typeof target.selectionStart === "number" &&
    typeof target.selectionEnd === "number";
  lastFocus = {
    id: target.id,
    start: supportsSelection ? target.selectionStart : null,
    end: supportsSelection ? target.selectionEnd : null,
  };
}

function getDraftData() {
  const active = document.activeElement;
  if (active && form.contains(active)) captureFocus(active);

  return {
    version: 1,
    updatedAt: Date.now(),
    editingId,
    nowMode,
    chatIdManual,
    focus: lastFocus,
    timeHours: timeHoursInput.value,
    timeMinutes: timeMinutesInput.value,
    dateDay: dateDayInput.value,
    dateMonth: dateMonthInput.value,
    dateYear: dateYearInput.value,
    chatMode: chatMode(),
    chatId: chatIdInput.value,
    model: modelSelect.value,
    effort: effortSelect.value,
    message: messageInput.value,
  };
}

async function persistDraft() {
  if (restoringDraft) return;
  try {
    await chrome.storage.local.set({ [DRAFT_KEY]: getDraftData() });
  } catch (_) {}
}

async function restoreDraft() {
  let draft;
  try {
    ({ [DRAFT_KEY]: draft } = await chrome.storage.local.get(DRAFT_KEY));
  } catch (_) {
    return;
  }
  if (!draft || draft.version !== 1) return;

  restoringDraft = true;
  try {
    timeHoursInput.value = cleanPart(draft.timeHours, 2);
    timeMinutesInput.value = cleanPart(draft.timeMinutes, 2);
    dateDayInput.value = cleanPart(draft.dateDay, 2);
    dateMonthInput.value = cleanPart(draft.dateMonth, 2);
    dateYearInput.value = cleanPart(draft.dateYear, 4);
    chatIdInput.value = String(draft.chatId || "");
    const draftAge = Date.now() - Number(draft.updatedAt || 0);
    chatIdManual = Boolean(draft.chatIdManual) && draftAge < 6 * 60 * 60 * 1000;
    pendingModelValue = String(draft.model || "");
    pendingEffortValue = String(draft.effort || "");
    messageInput.value = String(draft.message || "");

    setChatMode(draft.chatMode === "new" ? "new" : "existing");

    editingId = typeof draft.editingId === "string" ? draft.editingId : null;
    nowMode = Boolean(draft.nowMode);
    if (nowMode) {
      // „Сега“ означава текущия момент, затова го освежаваме при отваряне.
      setDateTimeInputs(new Date());
      fillNowBtn.classList.add("active");
      fillNowBtn.setAttribute("aria-pressed", "true");
    } else {
      fillNowBtn.classList.remove("active");
      fillNowBtn.setAttribute("aria-pressed", "false");
    }

    if (draft.focus && typeof draft.focus.id === "string") {
      lastFocus = {
        id: draft.focus.id,
        start: Number.isInteger(draft.focus.start) ? draft.focus.start : null,
        end: Number.isInteger(draft.focus.end) ? draft.focus.end : null,
      };
    }

    updateChatRow();
    syncEditModeUi();
  } finally {
    restoringDraft = false;
  }

  if (nowMode) await persistDraft();
}

function restoreLastFocus() {
  requestAnimationFrame(() => {
    if (!lastFocus.id) return;
    const target = document.getElementById(lastFocus.id);
    if (
      !target ||
      !form.contains(target) ||
      target.hidden ||
      target.getClientRects().length === 0
    ) {
      return;
    }
    target.focus();
    if (
      typeof target.setSelectionRange === "function" &&
      lastFocus.start !== null &&
      lastFocus.end !== null
    ) {
      const max = String(target.value || "").length;
      target.setSelectionRange(
        Math.min(lastFocus.start, max),
        Math.min(lastFocus.end, max)
      );
    }
  });
}

function cleanPart(value, maxLength) {
  return onlyDigits(value || "").slice(0, maxLength);
}

function prepareMaskedInputs() {
  const parts = [
    { input: timeHoursInput, next: timeMinutesInput, prev: null, max: 2, singleDigitLimit: 2 },
    { input: timeMinutesInput, next: dateDayInput, prev: timeHoursInput, max: 2, singleDigitLimit: 5 },
    { input: dateDayInput, next: dateMonthInput, prev: timeMinutesInput, max: 2, singleDigitLimit: 3 },
    { input: dateMonthInput, next: dateYearInput, prev: dateDayInput, max: 2, singleDigitLimit: 1 },
    { input: dateYearInput, next: null, prev: dateMonthInput, max: 4, singleDigitLimit: null },
  ];

  for (const part of parts) {
    part.input.addEventListener("input", () => {
      deactivateNowMode();
      part.input.value = onlyDigits(part.input.value).slice(0, part.max);

      // При еднозначна стойност, която не може да е начало на двуцифрена,
      // автоматично добавяме водеща нула и продължаваме нататък.
      if (
        part.max === 2 &&
        part.input.value.length === 1 &&
        Number(part.input.value) > part.singleDigitLimit
      ) {
        part.input.value = `0${part.input.value}`;
      }

      if (part.input.value.length === part.max && part.next) {
        focusAndSelect(part.next);
      }
    });

    part.input.addEventListener("keydown", (event) => {
      if (event.key === "Backspace" && !part.input.value && part.prev) {
        event.preventDefault();
        part.prev.focus();
        part.prev.setSelectionRange(part.prev.value.length, part.prev.value.length);
        return;
      }

      if (
        event.key === "ArrowLeft" &&
        part.prev &&
        part.input.selectionStart === 0 &&
        part.input.selectionEnd === 0
      ) {
        event.preventDefault();
        part.prev.focus();
        part.prev.setSelectionRange(part.prev.value.length, part.prev.value.length);
        return;
      }

      if (
        event.key === "ArrowRight" &&
        part.next &&
        part.input.selectionStart === part.input.value.length &&
        part.input.selectionEnd === part.input.value.length
      ) {
        event.preventDefault();
        part.next.focus();
        part.next.setSelectionRange(0, 0);
      }
    });

    // Не допълваме едноцифрена стойност при blur. Така, ако popup-ът
    // се затвори по средата на въвеждането, например след „1“, при
    // следващото отваряне потребителят може да продължи с „2“ за „12“.
  }

  timeField.addEventListener("click", (event) => {
    if (event.target === timeField) focusFirstEmpty([timeHoursInput, timeMinutesInput]);
  });
  dateField.addEventListener("click", (event) => {
    if (event.target === dateField) {
      focusFirstEmpty([dateDayInput, dateMonthInput, dateYearInput]);
    }
  });

  timeField.addEventListener("paste", (event) => {
    const digits = onlyDigits(event.clipboardData.getData("text"));
    if (digits.length < 3) return;
    event.preventDefault();
    deactivateNowMode();
    timeHoursInput.value = digits.slice(0, 2);
    timeMinutesInput.value = digits.slice(2, 4);
    focusAndSelect(dateDayInput);
    persistDraft();
  });

  dateField.addEventListener("paste", (event) => {
    const digits = onlyDigits(event.clipboardData.getData("text"));
    if (digits.length < 4) return;
    event.preventDefault();
    deactivateNowMode();
    dateDayInput.value = digits.slice(0, 2);
    dateMonthInput.value = digits.slice(2, 4);
    dateYearInput.value = digits.slice(4, 8);
    focusAndSelect(dateYearInput);
    persistDraft();
  });

  fillNowBtn.addEventListener("click", () => {
    const now = new Date();
    setDateTimeInputs(now);
    nowMode = true;
    fillNowBtn.classList.add("active");
    fillNowBtn.setAttribute("aria-pressed", "true");
    focusAndSelect(timeHoursInput);
    formError.hidden = true;
    persistDraft();
  });
}

// ---------- бързи бутони +Ч ----------

function renderQuickHours() {
  quickHoursEl.innerHTML = "";
  for (const h of settings.quickHours || []) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "quick-btn";
    b.textContent = `+${h} ч`;
    b.title = `Добави ${h} ч (към попълнения час, или от сега, ако няма)`;
    b.addEventListener("click", () => addHours(h));
    quickHoursEl.appendChild(b);
  }
}

// Добавя към вече попълнения момент (ако е в бъдещето), иначе към сега.
// Така +3 и после +5 дава +8. „Сега" връща към текущия момент.
function addHours(h) {
  let base = Date.now();
  if (!nowMode) {
    const peek = peekWhen();
    if (peek && peek > Date.now()) base = peek;
  }
  const target = new Date(base + h * 3600 * 1000);
  deactivateNowMode();
  setDateTimeInputs(target);
  formError.hidden = true;
  updateRelativeNote();
  persistDraft();
}

// Чете часа/датата от полетата, без да ги променя (за да не пречи при писане).
function peekWhen() {
  const hh = timeHoursInput.value.trim();
  const mm = timeMinutesInput.value.trim();
  if (hh.length !== 2 || mm.length !== 2) return null;
  const hours = Number(hh);
  const minutes = Number(mm);
  if (hours > 23 || minutes > 59) return null;

  const dd = dateDayInput.value.trim();
  const mo = dateMonthInput.value.trim();
  const yy = dateYearInput.value.trim();
  if (!dd && !mo && !yy) return computeWhen({ hours, minutes }, null);
  if (dd.length < 1 || mo.length < 1 || yy.length !== 4) return null;
  const d = new Date(Number(yy), Number(mo) - 1, Number(dd), hours, minutes, 0, 0);
  if (d.getDate() !== Number(dd) || d.getMonth() !== Number(mo) - 1) return null;
  return d.getTime();
}

function updateRelativeNote() {
  if (nowMode) {
    relativeNote.textContent = "веднага";
    relativeNote.classList.remove("warn");
    return;
  }
  const when = peekWhen();
  if (!when) {
    relativeNote.textContent = "";
    return;
  }
  const ms = when - Date.now();
  if (ms <= 0) {
    relativeNote.textContent = "моментът е минал";
    relativeNote.classList.add("warn");
    return;
  }
  relativeNote.classList.remove("warn");
  const totalMin = Math.ceil(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  relativeNote.textContent = "след " + (d ? `${d} д ` : "") + `${h} ч ${pad2(m)} мин`;
}

function focusFirstEmpty(inputs) {
  focusAndSelect(inputs.find((input) => !input.value) || inputs[0]);
}

function focusAndSelect(input) {
  input.focus();
  input.select();
}

function onlyDigits(value) {
  return String(value).replace(/\D/g, "");
}

function deactivateNowMode() {
  nowMode = false;
  fillNowBtn.classList.remove("active");
  fillNowBtn.setAttribute("aria-pressed", "false");
}

function setDateTimeInputs(date) {
  timeHoursInput.value = pad2(date.getHours());
  timeMinutesInput.value = pad2(date.getMinutes());
  dateDayInput.value = pad2(date.getDate());
  dateMonthInput.value = pad2(date.getMonth() + 1);
  dateYearInput.value = String(date.getFullYear());
}

function clearDateInputs() {
  dateDayInput.value = "";
  dateMonthInput.value = "";
  dateYearInput.value = "";
}

async function loadTasks() {
  const { tasks: stored = [] } = await chrome.storage.local.get("tasks");
  tasks = stored;
  render();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.tasks) {
    tasks = changes.tasks.newValue || [];
    render();
  }
});

// ---------- form ----------

for (const r of form.querySelectorAll('input[name="chatMode"]')) {
  r.addEventListener("change", updateChatRow);
}
function updateChatRow() {
  chatIdRow.style.display = chatMode() === "new" ? "none" : "";
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  formError.hidden = true;

  if (nowMode) setDateTimeInputs(new Date());

  const parsedTime = readTimeParts();
  const parsedDate = readDateParts();
  const message = messageInput.value.trim();
  const mode = chatMode();
  const model = modelSelect.value.trim();
  const effort = effortSelect.value.trim();

  if (!parsedTime && !message) {
    return showError("Попълнете час и съобщение.");
  }
  if (!parsedTime) {
    return showError("Попълнете часа и минутите.");
  }
  if (!message) {
    return showError("Въведете съобщение.");
  }
  if (parsedTime.invalid) {
    return showError("Въведете валиден час от 00:00 до 23:59.");
  }
  if (parsedDate && parsedDate.invalid) {
    return showError("Попълнете валидни ден, месец и четирицифрена година.");
  }

  let chatId = "";
  if (mode === "existing") {
    const raw = chatIdInput.value.trim();
    const m = raw.match(/chat\/([a-f0-9-]+)/i);
    chatId = m ? m[1] : raw;
    if (!chatId) return showError("Въведете линк или ID на чата.");
  }

  const timeVal = `${pad2(parsedTime.hours)}:${pad2(parsedTime.minutes)}`;
  const when = nowMode
    ? Date.now() + 1500
    : computeWhen(parsedTime, parsedDate);

  if (when <= Date.now()) {
    return showError("Избраният момент вече е минал.");
  }

  if (editingId) {
    await chrome.runtime.sendMessage({
      type: "updateTask",
      task: { id: editingId, when, time: timeVal, chatMode: mode, chatId, model, effort, message },
    });
    exitEditMode();
  } else {
    const task = {
      id: crypto.randomUUID(),
      when,
      time: timeVal,
      chatMode: mode,
      chatId,
      model,
      effort,
      message,
      status: "pending",
      createdAt: Date.now(),
    };
    await chrome.runtime.sendMessage({ type: "addTask", task });
    await resetForm();
  }
  formError.hidden = true;
});

// Пълно нулиране след изпращане: празни полета и наново прочетена страница.
async function resetForm() {
  editingId = null;
  syncEditModeUi();
  messageInput.value = "";
  timeHoursInput.value = "";
  timeMinutesInput.value = "";
  clearDateInputs();
  deactivateNowMode();
  modelSelect.value = "";
  pendingModelValue = "";
  effortSelect.value = "";
  pendingEffortValue = "";
  chatIdManual = false;
  chatIdInput.value = "";
  formError.hidden = true;
  lastFocus = { id: null, start: null, end: null };
  try {
    await chrome.storage.local.remove(DRAFT_KEY);
  } catch (_) {}
  await refreshPageInfo({ force: true });
  updateModelNote();
  render();
}

cancelEditBtn.addEventListener("click", exitEditMode);
modelSelect.addEventListener("change", updateModelNote);
effortSelect.addEventListener("change", updateModelNote);
chatIdInput.addEventListener("input", () => {
  updatePageNote();
  updateModelNote();
});

function enterEditMode(task) {
  editingId = task.id;
  const d = new Date(task.when);
  setDateTimeInputs(d);
  deactivateNowMode();
  setChatMode(task.chatMode);
  chatIdInput.value = task.chatId || "";
  chatIdManual = true;
  pendingModelValue = task.model || "";
  pendingEffortValue = task.effort || "";
  populateModels(settings.models);
  populateEffort();
  messageInput.value = task.message;
  updateChatRow();
  updatePageNote();
  updateModelNote();
  syncEditModeUi();
  persistDraft();
  formCard.scrollIntoView({ behavior: "smooth", block: "start" });
  render();
}

function exitEditMode() {
  resetForm();
}

function syncEditModeUi() {
  const editing = Boolean(editingId);
  submitBtn.textContent = editing ? "Запази промените" : "Добави в опашката";
  cancelEditBtn.hidden = !editing;
  formCard.classList.toggle("editing", editing);
}

function readTimeParts() {
  const hourText = timeHoursInput.value.trim();
  const minuteText = timeMinutesInput.value.trim();
  if (!hourText && !minuteText) return null;
  if (!hourText || !minuteText) return { invalid: true };

  const hours = Number(hourText);
  const minutes = Number(minuteText);
  if (
    !/^\d{1,2}$/.test(hourText) ||
    !/^\d{1,2}$/.test(minuteText) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return { invalid: true };
  }

  timeHoursInput.value = pad2(hours);
  timeMinutesInput.value = pad2(minutes);
  return { hours, minutes };
}

function readDateParts() {
  const dayText = dateDayInput.value.trim();
  const monthText = dateMonthInput.value.trim();
  const yearText = dateYearInput.value.trim();
  if (!dayText && !monthText && !yearText) return null;
  if (!dayText || !monthText || !yearText || yearText.length !== 4) {
    return { invalid: true };
  }

  const day = Number(dayText);
  const month = Number(monthText);
  const year = Number(yearText);
  const test = new Date(year, month - 1, day);

  if (
    !/^\d{1,2}$/.test(dayText) ||
    !/^\d{1,2}$/.test(monthText) ||
    !/^\d{4}$/.test(yearText) ||
    test.getFullYear() !== year ||
    test.getMonth() !== month - 1 ||
    test.getDate() !== day
  ) {
    return { invalid: true };
  }

  dateDayInput.value = pad2(day);
  dateMonthInput.value = pad2(month);
  return { day, month, year };
}

function computeWhen(timeParts, dateParts) {
  const { hours: h, minutes: m } = timeParts;
  let d;
  if (dateParts) {
    d = new Date(dateParts.year, dateParts.month - 1, dateParts.day, h, m, 0, 0);
  } else {
    d = new Date();
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  }
  return d.getTime();
}

function showError(text) {
  formError.textContent = text;
  formError.hidden = false;
}

// ---------- list ----------

const STATUS_LABEL = {
  running: "изпълнява се…",
  done: "изпратено ✓",
  failed: "неуспешно ✗",
  missed: "пропусната",
};

function render() {
  listEl.innerHTML = "";
  // Най-новите добавени заявки стоят отгоре.
  const sorted = [...tasks].sort(
    (a, b) => (b.createdAt || b.when) - (a.createdAt || a.when)
  );
  emptyEl.style.display = sorted.length ? "none" : "";
  clearDoneBtn.hidden = !sorted.some(
    (t) => t.status === "done" || t.status === "failed"
  );

  for (const t of sorted) {
    const li = document.createElement("li");
    li.className = `task ${t.status}` + (t.id === editingId ? " editing" : "");
    li.dataset.id = t.id;

    const whenStr = formatWhen(t.when);
    const target =
      t.chatMode === "new" ? "нов разговор" : `чат ${String(t.chatId).slice(0, 8)}…`;
    const modelStr = t.model
      ? ` · ${t.model}`
      : t.usedModel
      ? ` · ${t.usedModel}`
      : " · текущият модел";
    const effortStr = t.effort ? ` · ${t.effort}` : "";
    const canRun = t.status === "pending" || t.status === "missed";
    const retryStr =
      t.status === "pending" && t.attempts
        ? `<div class="task-err">Повторен опит ${t.attempts + 1}/3 след предишна грешка.</div>`
        : "";

    li.innerHTML = `
      <div class="task-top">
        <span class="task-when">${whenStr}</span>
        <span class="task-count" data-when="${t.when}" data-status="${t.status}"></span>
      </div>
      <div class="task-meta">${escapeHtml(target)}${escapeHtml(modelStr)}${escapeHtml(effortStr)}</div>
      <div class="task-msg" title="${escapeHtml(t.message)}">${escapeHtml(t.message)}</div>
      ${t.status === "missed" ? `<div class="task-err">Браузърът е бил затворен в зададения час. Редактирайте часа или я пуснете ръчно.</div>` : ""}
      ${retryStr}
      ${t.error && t.status !== "pending" ? `<div class="task-err">${escapeHtml(t.error)}</div>` : ""}
      ${t.warning ? `<div class="task-err">${escapeHtml(t.warning)}</div>` : ""}
      <div class="task-actions">
        <button class="ghost act-edit">Редактирай</button>
        ${canRun ? '<button class="ghost act-run">Изпълни сега</button>' : ""}
        <button class="ghost act-del">Изтрий</button>
      </div>
    `;

    li.querySelector(".act-edit").addEventListener("click", () => enterEditMode(t));
    li.querySelector(".act-del").addEventListener("click", () => {
      if (t.id === editingId) exitEditMode();
      chrome.runtime.sendMessage({ type: "deleteTask", id: t.id });
    });
    const runBtn = li.querySelector(".act-run");
    if (runBtn) {
      runBtn.addEventListener("click", () =>
        chrome.runtime.sendMessage({ type: "runNow", id: t.id })
      );
    }

    listEl.appendChild(li);
  }
  tick();
}

clearDoneBtn.addEventListener("click", () =>
  chrome.runtime.sendMessage({ type: "clearDone" })
);

// ---------- countdown ----------

function tick() {
  const now = Date.now();
  updateRelativeNote();

  const pending = tasks
    .filter((t) => t.status === "pending")
    .sort((a, b) => a.when - b.when);
  if (pending.length) {
    nextTimeEl.textContent = formatCountdown(pending[0].when - now);
    nextTimeEl.classList.remove("idle");
  } else {
    nextTimeEl.textContent = "--:--:--";
    nextTimeEl.classList.add("idle");
  }

  for (const el of listEl.querySelectorAll(".task-count")) {
    const status = el.dataset.status;
    if (status === "pending") {
      const ms = Number(el.dataset.when) - now;
      el.textContent = ms > 0 ? formatCountdown(ms) : "сега…";
    } else {
      el.textContent = STATUS_LABEL[status] || status;
    }
  }
}

function formatCountdown(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return (days ? `${days}д ` : "") + `${hh}:${mm}:${ss}`;
}

function formatWhen(when) {
  const d = new Date(when);
  const today = new Date();
  const time = formatTime(d);
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return time;
  return `${formatDate(d)} · ${time}`;
}

function formatDate(date) {
  return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()}`;
}

function formatTime(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
