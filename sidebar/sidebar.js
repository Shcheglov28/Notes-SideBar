"use strict";

/* =========================================================
   Константы и модель данных
   ========================================================= */
const STORAGE_KEY = "notes";
const SETTINGS_KEY = "settings";
const ACCENT_KEY = "settings_accentColor";
const AUTOSAVE_DELAY = 499;   // мс
const TOOLTIP_DELAY = 250;    // мс

const COLORS = ["gray", "red", "yellow", "green", "blue", "purple"];
const DEFAULT_COLOR = "gray";

const SORT_LABELS = {
  newest: "Сначала новые",
  oldest: "Сначала старые"
};

const MODE_LABELS = {
  auto: "Ручная сортировка: выкл",
  manual: "Ручная сортировка: вкл"
};

// Акцентные цвета интерфейса: светлая и тёмная палитры
// color / hover / soft — для светлой темы, dark.* — для тёмной
const ACCENTS = [
  { id: "blue",   name: "Синий",
    color: "#4F6BED", hover: "#3E58D4", soft: "#EAEEFF",
    dark: { color: "#8DA2FF", hover: "#A6B7FF", soft: "#232C4A", contrast: "#0F1424" } },
  { id: "green",  name: "Зелёный",
    color: "#30A46C", hover: "#278A59", soft: "#E6F6EC",
    dark: { color: "#4CC38A", hover: "#63D49B", soft: "#173326", contrast: "#06130C" } },
  { id: "purple", name: "Фиолетовый",
    color: "#8E4EC6", hover: "#7A3FAE", soft: "#F3EAFB",
    dark: { color: "#B27CE6", hover: "#C493F0", soft: "#2B2138", contrast: "#120A1A" } },
  { id: "orange", name: "Оранжевый",
    color: "#F76B15", hover: "#D95A0B", soft: "#FEEFE3",
    dark: { color: "#FF8A4C", hover: "#FFA06B", soft: "#392517", contrast: "#1A0C04" } },
  { id: "red",    name: "Красный",
    color: "#E5484D", hover: "#C93A3F", soft: "#FDECEC",
    dark: { color: "#FF6E73", hover: "#FF8A8E", soft: "#3A1F21", contrast: "#1A0708" } },
  { id: "black",  name: "Чёрный",
    color: "#1C2330", hover: "#3A4354", soft: "#EEF0F4",
    dark: { color: "#D9DEE7", hover: "#F0F2F6", soft: "#2A303C", contrast: "#0E1117" } }
];
const DEFAULT_ACCENT = "blue";

function createNote({ title = "", content = "", url = "" } = {}) {
  const now = Date.now();
  return {
    id: (crypto.randomUUID && crypto.randomUUID()) || String(now) + Math.random().toString(16).slice(2),
    title,
    content,
    url,
    createdAt: now,
    updatedAt: now,
    color: DEFAULT_COLOR,   // цветовая метка
    orderIndex: null,       // позиция при ручной сортировке
    links: []               // задел на будущее: id связанных заметок (граф)
  };
}

// Приводит заметки из хранилища (Фаза 1/2) к актуальной схеме
function normalizeNote(n) {
  const { order, ...rest } = n;   // старое поле `order` → `orderIndex`
  const idx = Number.isFinite(n.orderIndex) ? n.orderIndex : (Number.isFinite(order) ? order : null);
  return {
    ...rest,
    title: n.title || "",
    content: n.content || "",
    url: n.url || "",
    color: COLORS.includes(n.color) ? n.color : DEFAULT_COLOR,
    orderIndex: idx,
    links: Array.isArray(n.links) ? n.links : []
  };
}

/* =========================================================
   Хранилище
   ========================================================= */
let notes = [];
let settings = { sort: "newest", mode: "auto", theme: "light" };   // sort: направление по дате, mode: auto | manual, theme: light | dark
let accentId = DEFAULT_ACCENT;

async function loadAll() {
  const data = await browser.storage.local.get([STORAGE_KEY, SETTINGS_KEY, ACCENT_KEY]);

  notes = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY].map(normalizeNote) : [];

  const s = data[SETTINGS_KEY];
  if (s) {
    if (SORT_LABELS[s.sort]) settings.sort = s.sort;
    if (MODE_LABELS[s.mode]) settings.mode = s.mode;
    if (s.theme === "dark" || s.theme === "light") settings.theme = s.theme;
  }

  if (ACCENTS.some((a) => a.id === data[ACCENT_KEY])) accentId = data[ACCENT_KEY];
}

function persist() {
  return browser.storage.local.set({ [STORAGE_KEY]: notes });
}

function persistSettings() {
  return browser.storage.local.set({ [SETTINGS_KEY]: settings });
}

/* =========================================================
   DOM
   ========================================================= */
const $ = (id) => document.getElementById(id);
const screens = {
  list: $("screen-list"),
  editor: $("screen-editor"),
  settings: $("screen-settings")
};
const els = {
  list: $("note-list"),
  empty: $("empty-state"),
  title: $("editor-title"),
  body: $("editor-body"),
  source: $("editor-source"),
  sourceText: $("editor-source-text"),
  status: $("save-status"),
  exportHint: $("export-hint"),
  sortBtn: $("btn-sort"),
  modeBtn: $("btn-mode"),
  colorPicker: $("color-picker"),
  palette: $("accent-palette"),
  themeSwitch: $("theme-switch"),
  themeState: $("theme-state")
};

/* =========================================================
   Иконки
   ========================================================= */
const ICON_TRASH =
  '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M6 6l1 14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-14M10 11v6M14 11v6"/></svg>';

/* =========================================================
   Навигация между экранами (fade-in через CSS transition)
   ========================================================= */
let currentScreen = null;

function showScreen(name) {
  for (const [key, el] of Object.entries(screens)) {
    if (key === name) {
      el.classList.add("mounted");
      void el.offsetWidth;            // reflow, чтобы transition сработал
      el.classList.add("active");
    } else {
      el.classList.remove("active", "mounted");
    }
  }
  currentScreen = name;
  hideTooltip();
}

/* =========================================================
   Тема: светлая / тёмная
   ========================================================= */
function applyTheme(theme) {
  const dark = theme === "dark";
  settings.theme = dark ? "dark" : "light";
  document.documentElement.dataset.theme = settings.theme;

  els.themeSwitch.setAttribute("aria-checked", String(dark));
  els.themeSwitch.dataset.tip = dark ? "Включить светлую тему" : "Включить тёмную тему";
  els.themeState.textContent = dark ? "Тёмная" : "Светлая";

  // Мягкие фоны и контраст акцента зависят от темы
  applyAccent(accentId);
}

function toggleTheme() {
  applyTheme(settings.theme === "dark" ? "light" : "dark");
  persistSettings();
}

/* =========================================================
   Акцентный цвет
   ========================================================= */
function applyAccent(id) {
  const a = ACCENTS.find((x) => x.id === id) || ACCENTS[0];
  const dark = settings.theme === "dark";
  const vars = dark ? a.dark : { color: a.color, hover: a.hover, soft: a.soft, contrast: "#FFFFFF" };
  const root = document.documentElement.style;
  root.setProperty("--accent-color", vars.color);
  root.setProperty("--accent-hover", vars.hover);
  root.setProperty("--accent-soft", vars.soft);
  root.setProperty("--accent-contrast", vars.contrast);
  accentId = a.id;
  els.palette.querySelectorAll(".swatch").forEach((sw) => {
    sw.setAttribute("aria-checked", String(sw.dataset.accent === a.id));
  });
}

function buildPalette() {
  for (const a of ACCENTS) {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "swatch";
    sw.dataset.accent = a.id;
    sw.dataset.tip = a.name;
    sw.style.setProperty("--swatch-color", a.color);
    sw.style.setProperty("--swatch-color-dark", a.dark.color);
    sw.setAttribute("role", "radio");
    sw.setAttribute("aria-label", a.name);
    els.palette.appendChild(sw);
  }
}

function setAccent(id) {
  applyAccent(id);
  browser.storage.local.set({ [ACCENT_KEY]: accentId });
}

function resetAccent() {
  applyAccent(DEFAULT_ACCENT);
  browser.storage.local.remove(ACCENT_KEY);
}

/* =========================================================
   Сортировка: по дате (auto) / ручная (manual)
   ========================================================= */
let sortable = null;

function isManual() {
  return settings.mode === "manual";
}

function updateSortUI() {
  const label = SORT_LABELS[settings.sort];
  els.sortBtn.dataset.tip = label;
  els.sortBtn.setAttribute("aria-label", `Сортировка: ${label}`);
  els.sortBtn.classList.toggle("asc", settings.sort === "oldest");
  els.sortBtn.hidden = isManual();   // в ручном режиме сортировка по дате не нужна

  els.modeBtn.dataset.tip = MODE_LABELS[settings.mode];
  els.modeBtn.setAttribute("aria-pressed", String(isManual()));

  els.list.classList.toggle("manual", isManual());
  if (sortable) sortable.option("disabled", !isManual());
}

function toggleSort() {
  settings.sort = settings.sort === "newest" ? "oldest" : "newest";
  updateSortUI();
  persistSettings();
  renderList();
}

function toggleMode() {
  settings.mode = isManual() ? "auto" : "manual";
  updateSortUI();
  persistSettings();
  renderList();
}

// Сравнение для ручного режима: без индекса — наверх (новые первыми), затем по orderIndex
function compareManual(a, b) {
  const ai = Number.isFinite(a.orderIndex), bi = Number.isFinite(b.orderIndex);
  if (ai && bi) return a.orderIndex - b.orderIndex;
  if (!ai && !bi) return b.createdAt - a.createdAt;
  return ai ? 1 : -1;
}

// Приводит индексы к 0..n-1 без пропусков; сохраняет, если что-то изменилось
function ensureOrder() {
  const ordered = [...notes].sort(compareManual);
  let changed = false;
  ordered.forEach((n, i) => {
    if (n.orderIndex !== i) { n.orderIndex = i; changed = true; }
  });
  if (changed) persist();
}

function topOrderIndex() {
  const idx = notes.map((n) => n.orderIndex).filter(Number.isFinite);
  return idx.length ? Math.min(...idx) - 1 : 0;
}

function sortedNotes() {
  if (isManual()) {
    ensureOrder();
    return [...notes].sort((a, b) => a.orderIndex - b.orderIndex);
  }
  const dir = settings.sort === "newest" ? -1 : 1;
  return [...notes].sort((a, b) => (a.createdAt - b.createdAt) * dir);
}

function initSortable() {
  if (typeof Sortable === "undefined") return;   // библиотека не найдена — ручной режим недоступен
  sortable = new Sortable(els.list, {
    animation: 150,
    draggable: ".note-item:not(.removing)",
    filter: ".note-delete",
    preventOnFilter: false,
    ghostClass: "drag-ghost",
    disabled: !isManual(),
    onEnd: saveManualOrder
  });
}

function saveManualOrder() {
  const ids = [...els.list.querySelectorAll(".note-item:not(.removing)")].map((li) => li.dataset.id);
  notes.forEach((n) => {
    const i = ids.indexOf(n.id);
    if (i !== -1) n.orderIndex = i;
  });
  persist();
}

/* =========================================================
   Список
   ========================================================= */
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return ""; }
}

function formatDate(ts) {
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit"
  });
}

function buildNoteItem(note) {
  const li = document.createElement("li");
  li.className = "note-item";
  li.dataset.id = note.id;
  li.dataset.color = note.color;

  const main = document.createElement("div");
  main.className = "note-main";

  const title = document.createElement("div");
  title.className = "note-title";
  if (note.title.trim()) title.textContent = note.title;
  else { title.textContent = "Без названия"; title.classList.add("untitled"); }
  main.appendChild(title);

  if (note.content.trim()) {
    const preview = document.createElement("div");
    preview.className = "note-preview";
    preview.textContent = note.content.trim().slice(0, 200);
    main.appendChild(preview);
  }

  const meta = document.createElement("div");
  meta.className = "note-meta";
  const date = document.createElement("span");
  date.textContent = formatDate(note.updatedAt);
  meta.appendChild(date);
  const host = hostOf(note.url);
  if (host) {
    const h = document.createElement("span");
    h.className = "host";
    h.textContent = host;
    meta.appendChild(h);
  }
  main.appendChild(meta);

  const del = document.createElement("button");
  del.className = "note-delete";
  del.type = "button";
  del.dataset.tip = "Удалить";
  del.setAttribute("aria-label", "Удалить заметку");
  del.innerHTML = ICON_TRASH;

  li.append(main, del);
  return li;
}

function renderList() {
  els.list.textContent = "";
  const sorted = sortedNotes();
  els.empty.hidden = sorted.length > 0;

  const items = sorted.map((note, i) => {
    const li = buildNoteItem(note);
    li.style.transitionDelay = `${Math.min(i, 8) * 25}ms`;   // лёгкий каскад
    els.list.appendChild(li);
    return li;
  });

  // двойной rAF: стартовое состояние (opacity 0) должно успеть отрисоваться
  requestAnimationFrame(() => requestAnimationFrame(() => {
    items.forEach((li) => li.classList.add("in"));
  }));
  // после появления сбрасываем задержку, чтобы hover не «тормозил»
  setTimeout(() => items.forEach((li) => (li.style.transitionDelay = "")), 500);
}

function openList() {
  renderList();
  showScreen("list");
}

function removeNoteFromList(li) {
  if (li.classList.contains("removing")) return;
  const id = li.dataset.id;

  hideTooltip();
  li.style.transitionDelay = "0ms";
  li.style.height = `${li.offsetHeight}px`;   // фиксируем высоту, чтобы схлопнуть её плавно
  void li.offsetHeight;
  li.classList.add("removing");

  notes = notes.filter((n) => n.id !== id);
  persist();

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    li.remove();
    if (!notes.length) els.empty.hidden = false;
  };
  li.addEventListener("transitionend", (e) => {
    if (e.target === li && e.propertyName === "height") finish();
  });
  setTimeout(finish, 350);   // запасной вариант
}

/* =========================================================
   Редактор + автосохранение
   ========================================================= */
let editingId = null;
let saveTimer = null;
let dirty = false;

function setColorUI(color) {
  els.colorPicker.querySelectorAll(".color-dot").forEach((dot) => {
    dot.setAttribute("aria-checked", String(dot.dataset.color === color));
  });
}

function openEditor(id, { focusTitle = false } = {}) {
  const note = notes.find((n) => n.id === id);
  if (!note) return openList();

  editingId = id;
  dirty = false;
  els.title.value = note.title;
  els.body.value = note.content;
  els.status.textContent = "";
  setColorUI(note.color);

  if (note.url) {
    els.source.hidden = false;
    els.source.href = note.url;
    els.source.title = note.url;
    els.sourceText.textContent = hostOf(note.url) || note.url;
  } else {
    els.source.hidden = true;
  }

  showScreen("editor");
  setTimeout(() => (focusTitle ? els.title : els.body).focus(), 50);
}

function scheduleSave() {
  dirty = true;
  els.status.textContent = "Изменения…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, AUTOSAVE_DELAY);
}

async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!dirty || !editingId) return;
  const note = notes.find((n) => n.id === editingId);
  if (!note) return;

  note.title = els.title.value;
  note.content = els.body.value;
  note.updatedAt = Date.now();
  dirty = false;

  await persist();
  if (currentScreen === "editor") els.status.textContent = "Сохранено";
}

function setNoteColor(color) {
  if (!editingId || !COLORS.includes(color)) return;
  const note = notes.find((n) => n.id === editingId);
  if (!note || note.color === color) return;
  note.color = color;
  setColorUI(color);
  scheduleSave();
}

async function closeEditor() {
  await flushSave();
  editingId = null;
  openList();
}

async function deleteCurrent() {
  if (!editingId) return;
  if (!confirm("Удалить эту заметку?")) return;
  clearTimeout(saveTimer);
  dirty = false;
  notes = notes.filter((n) => n.id !== editingId);
  editingId = null;
  await persist();
  openList();
}

/* =========================================================
   Создание заметки (URL + заголовок активной вкладки)
   ========================================================= */
async function getActiveTab() {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch {
    return null;
  }
}

async function createFromActiveTab() {
  const tab = await getActiveTab();
  const hasUrl = tab && /^(https?|file|ftp):/i.test(tab.url || "");
  const note = createNote({
    title: tab && tab.title ? tab.title : "",
    url: hasUrl ? tab.url : ""
  });
  note.orderIndex = topOrderIndex();   // в ручном режиме новая заметка встаёт наверх
  notes.push(note);
  await persist();
  openEditor(note.id);
}

/* =========================================================
   Экспорт в JSON
   ========================================================= */
async function exportJson() {
  await flushSave();
  const payload = {
    app: "notes-sidebar",
    version: 1,
    exportedAt: new Date().toISOString(),
    notes
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `notes-${stamp}.json`;

  try {
    await browser.downloads.download({ url, filename, saveAs: false });
  } catch (err) {
    // запасной вариант: ссылка с атрибутом download
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  els.exportHint.textContent = `Экспортировано заметок: ${notes.length}`;
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/* =========================================================
   Тултипы
   ========================================================= */
const tooltip = $("tooltip");
let tipTimer = null;

function showTooltip(target) {
  tooltip.textContent = target.dataset.tip;
  const r = target.getBoundingClientRect();
  const tw = tooltip.offsetWidth;
  const left = Math.min(Math.max(r.left + r.width / 2 - tw / 2, 4), window.innerWidth - tw - 4);
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${r.bottom + 6}px`;
  tooltip.classList.add("show");
}

function hideTooltip() {
  clearTimeout(tipTimer);
  tooltip.classList.remove("show");
}

document.addEventListener("mouseover", (e) => {
  const target = e.target.closest("[data-tip]");
  if (!target) return;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => showTooltip(target), TOOLTIP_DELAY);
});
document.addEventListener("mouseout", (e) => {
  if (e.target.closest("[data-tip]")) hideTooltip();
});
document.addEventListener("mousedown", hideTooltip);
document.addEventListener("dragstart", hideTooltip);

/* =========================================================
   События
   ========================================================= */
$("btn-new").addEventListener("click", createFromActiveTab);
els.sortBtn.addEventListener("click", toggleSort);
els.modeBtn.addEventListener("click", toggleMode);
$("btn-settings").addEventListener("click", () => {
  els.exportHint.textContent = "";
  showScreen("settings");
});
$("btn-back-editor").addEventListener("click", closeEditor);
$("btn-back-settings").addEventListener("click", openList);
$("btn-delete").addEventListener("click", deleteCurrent);
$("btn-export").addEventListener("click", exportJson);
$("btn-reset").addEventListener("click", resetAccent);
els.themeSwitch.addEventListener("click", toggleTheme);

els.palette.addEventListener("click", (e) => {
  const sw = e.target.closest(".swatch");
  if (sw) setAccent(sw.dataset.accent);
});

els.list.addEventListener("click", (e) => {
  const item = e.target.closest(".note-item");
  if (!item || item.classList.contains("removing")) return;
  if (e.target.closest(".note-delete")) {
    e.stopPropagation();
    removeNoteFromList(item);
  } else {
    openEditor(item.dataset.id);
  }
});

els.colorPicker.addEventListener("click", (e) => {
  const dot = e.target.closest(".color-dot");
  if (dot) setNoteColor(dot.dataset.color);
});

els.title.addEventListener("input", scheduleSave);
els.body.addEventListener("input", scheduleSave);
els.title.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); els.body.focus(); }
});

els.source.addEventListener("click", (e) => {
  e.preventDefault();
  const url = els.source.href;
  if (url && url !== "#") browser.tabs.create({ url });
});

// Сохранить несохранённое при закрытии панели
window.addEventListener("pagehide", flushSave);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) flushSave();
});

// Синхронизация, если данные изменились в другом окне
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  // акцентный цвет применяем всегда (в т.ч. при сбросе из другого окна)
  if (changes[ACCENT_KEY]) {
    const next = changes[ACCENT_KEY].newValue || DEFAULT_ACCENT;
    if (next !== accentId) applyAccent(next);
  }

  // настройки (тема, сортировка, режим), изменённые в другом окне
  if (changes[SETTINGS_KEY]) {
    const next = changes[SETTINGS_KEY].newValue || {};
    let changed = false;

    if (SORT_LABELS[next.sort] && next.sort !== settings.sort) {
      settings.sort = next.sort;
      changed = true;
    }
    if (MODE_LABELS[next.mode] && next.mode !== settings.mode) {
      settings.mode = next.mode;
      changed = true;
    }

    const nextTheme = next.theme === "dark" ? "dark" : "light";
    if (nextTheme !== settings.theme) {
      applyTheme(nextTheme);
      changed = true;
    }

    if (changed) {
      updateSortUI();
      if (currentScreen === "list") renderList();
    }
  }

  if (!changes[STORAGE_KEY]) return;
  if (currentScreen === "editor") return;      // не мешаем редактированию

  const incoming = (changes[STORAGE_KEY].newValue || []).map(normalizeNote);
  // собственные записи не перерисовываем, иначе прервётся анимация
  if (JSON.stringify(incoming) === JSON.stringify(notes)) return;

  notes = incoming;
  if (currentScreen === "list") renderList();
});

/* =========================================================
   Старт
   ========================================================= */
(async function init() {
  buildPalette();
  await loadAll();
  applyTheme(settings.theme);   // тема + сохранённый акцентный цвет
  initSortable();
  updateSortUI();
  openList();
})();