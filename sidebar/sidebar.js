"use strict";

/* =========================================================
   Константы и модель данных
   ========================================================= */
const STORAGE_KEY = "notes";
const TRASH_KEY = "notes_trash";   // удалённые заметки, ожидающие подтверждения (Корзина)
const SETTINGS_KEY = "settings";
const ACCENT_KEY = "settings_accentColor";
const AUTOSAVE_DELAY = 499;   // мс
const TOOLTIP_DELAY = 250;    // мс
const UNDO_DELAY = 3000;      // мс — сколько доступна отмена удаления
const NOTICE_DELAY = 4000;    // мс — обычные уведомления

const COLORS = ["gray", "red", "yellow", "green", "blue", "purple"];
const DEFAULT_COLOR = "gray";

const SUPPORT_EMAIL = "m.k.shcheglov@gmail.com";

// Напоминание о бэкапе: показываем только при заметках > порога и не чаще,
// чем раз за сессию браузера (storage.session) либо раз в 24 часа (fallback).
const BACKUP_REMINDER_KEY = "backupReminderShown";         // ключ в browser.storage.session
const BACKUP_REMINDER_TIME_KEY = "lastBackupReminderTime"; // ключ в browser.storage.local (fallback)
const BACKUP_NOTES_THRESHOLD = 10;                         // показывать, если заметок строго больше
const BACKUP_REMINDER_INTERVAL = 24 * 60 * 60 * 1000;      // 24 часа — fallback-интервал

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
    links: [],              // задел на будущее: id связанных заметок (граф)
    isPinned: false         // закреплена ли заметка (всегда сверху списка)
  };
}

// Допустимые схемы URL (совпадает с проверкой при создании заметки)
const URL_SCHEMES = /^(https?|file|ftp):/i;

// Возвращает строку как есть либо "" для любого нестрокового значения
function strOrEmpty(value) {
  return typeof value === "string" ? value : "";
}

// Оставляет только URL с допустимой схемой (http/https/file/ftp), иначе ""
function safeUrl(value) {
  const url = strOrEmpty(value);
  return url === "" || URL_SCHEMES.test(url) ? url : "";
}

// Строгая проверка поля: должно быть строкой либо отсутствовать (null/undefined)
function assertStringField(value, field, label) {
  if (value != null && typeof value !== "string") {
    throw new Error(`${label}: поле ${field} должно быть строкой`);
  }
}

// Приводит заметки из хранилища (Фаза 1/2) к актуальной схеме.
// Для некорректных записей возвращает null — вызывающий код отфильтровывает их.
function normalizeNote(n) {
  if (!n || typeof n !== "object" || Array.isArray(n)) return null;
  const { order, ...rest } = n;   // старое поле `order` → `orderIndex`
  const idx = Number.isFinite(n.orderIndex) ? n.orderIndex : (Number.isFinite(order) ? order : null);
  return {
    ...rest,
    title: strOrEmpty(n.title),
    content: strOrEmpty(n.content),
    url: strOrEmpty(n.url),
    color: COLORS.includes(n.color) ? n.color : DEFAULT_COLOR,
    orderIndex: idx,
    links: Array.isArray(n.links) ? n.links : [],
    isPinned: n.isPinned === true
  };
}

/* =========================================================
   Хранилище
   ========================================================= */
let notes = [];
let trash = [];   // очередь удалённых заметок: { note, index, at } — физически ещё в хранилище
let settings = { sort: "newest", mode: "auto", theme: "light" };   // sort: направление по дате, mode: auto | manual, theme: light | dark
let accentId = DEFAULT_ACCENT;

async function loadAll() {
  const data = await browser.storage.local.get([STORAGE_KEY, SETTINGS_KEY, ACCENT_KEY, TRASH_KEY]);

  notes = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY].map(normalizeNote).filter(Boolean) : [];

  trash = Array.isArray(data[TRASH_KEY])
    ? data[TRASH_KEY]
        .map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
          const note = normalizeNote(entry.note);
          if (!note) return null;
          return {
            note,
            index: Number.isFinite(entry.index) ? entry.index : null,
            at: Number.isFinite(entry.at) ? entry.at : Date.now()
          };
        })
        .filter(Boolean)
    : [];

  const s = data[SETTINGS_KEY];
  if (s) {
    if (SORT_LABELS[s.sort]) settings.sort = s.sort;
    if (MODE_LABELS[s.mode]) settings.mode = s.mode;
    if (s.theme === "dark" || s.theme === "light") settings.theme = s.theme;
  }

  if (ACCENTS.some((a) => a.id === data[ACCENT_KEY])) accentId = data[ACCENT_KEY];
}

// Атомарно сохраняет и заметки, и корзину — исключает рассинхрон между ними
function persist() {
  return browser.storage.local.set({ [STORAGE_KEY]: notes, [TRASH_KEY]: trash });
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
  emptySearch: $("empty-search"),
  emptyFilter: $("empty-filter"),
  searchBar: $("search-bar"),
  searchInput: $("search-input"),
  searchClear: $("btn-search-clear"),
  searchBtn: $("btn-search"),
  filterBtn: $("btn-filter"),
  title: $("editor-title"),
  body: $("editor-body"),
  preview: $("editor-preview"),
  viewBtn: $("btn-view"),
  source: $("editor-source"),
  sourceText: $("editor-source-text"),
  status: $("save-status"),
  exportHint: $("export-hint"),
  importFile: $("import-file"),
  sortBtn: $("btn-sort"),
  modeBtn: $("btn-mode"),
  colorPicker: $("color-picker"),
  palette: $("accent-palette"),
  themeSwitch: $("theme-switch"),
  themeState: $("theme-state"),
  supportBtn: $("btn-support"),
  toast: $("toast"),
  toastText: $("toast-text"),
  toastAction: $("toast-action"),
  toastProgress: $("toast-progress")
};

/* =========================================================
   Иконки
   ========================================================= */
const ICON_TRASH =
  '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M6 6l1 14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-14M10 11v6M14 11v6"/></svg>';

const ICON_PIN =
  '<svg viewBox="0 0 24 24"><path d="M9 3h6l-1 6 4 3v2H6v-2l4-3-1-6zM12 14v7"/></svg>';

const ICON_COPY =
  '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';

/* =========================================================
   Markdown-рендер и Wiki-ссылки
   =========================================================
   renderMarkdown превращает Markdown в безопасный HTML:
   marked.parse → DOMPurify.sanitize. Wiki-ссылки [[Название]]
   размечаются как <a class="wiki-link" data-wiki="…"> до парсинга. */
const WIKI_RE = /\[\[([^\[\]]+?)\]\]/g;

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Заменяет [[Название]] на ссылку, чтобы marked не «съел» скобки.
// Текст экранируем, чтобы исключить инъекцию через содержимое ссылки.
function wikiToLinks(text) {
  return text.replace(WIKI_RE, (m, title) => {
    const t = title.trim();
    if (!t) return m;
    return `<a class="wiki-link" data-wiki="${escapeHtml(t)}" href="#">${escapeHtml(t)}</a>`;
  });
}

function renderMarkdown(text) {
  if (typeof marked === "undefined") return "";
  const prepared = wikiToLinks(text || "");
  const html = marked.parse(prepared, { breaks: true, gfm: true });
  return typeof DOMPurify !== "undefined" ? DOMPurify.sanitize(html) : html;
}

// Клик по Wiki-ссылке: ищем заметку по title и открываем её в редакторе
function onWikiLinkClick(e) {
  const link = e.target.closest(".wiki-link");
  if (!link) return;
  e.preventDefault();
  e.stopPropagation();
  const title = link.dataset.wiki || "";
  const target = notes.find((n) => n.title.trim().toLowerCase() === title.trim().toLowerCase());
  if (target) {
    openEditor(target.id);
  } else {
    showToast({ text: `Заметка «${title}» не найдена`, variant: "error", duration: 5000 });
  }
}

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
   Поддержка и напоминание о бэкапе
   ========================================================= */
async function copySupportEmail() {
  try {
    await navigator.clipboard.writeText(SUPPORT_EMAIL);
    showToast({ text: "Email скопирован", variant: "success" });
  } catch {
    showToast({ text: `Напишите нам: ${SUPPORT_EMAIL}`, duration: 6000 });
  }
}

// Есть ли доступ к browser.storage.session (MV3, Firefox 115+)
function hasSessionStorage() {
  return !!(browser.storage && browser.storage.session);
}

// Сбрасывает флаг напоминания: после экспорта бэкап считаем сделанным
async function resetBackupReminder() {
  try {
    if (hasSessionStorage()) await browser.storage.session.remove(BACKUP_REMINDER_KEY);
  } catch { /* session-хранилище может быть недоступно — не критично */ }
  try {
    await browser.storage.local.remove(BACKUP_REMINDER_TIME_KEY);
  } catch { /* ignore */ }
}

// Напоминаем о резервной копии, если заметок много и напоминания не было
// в текущей сессии браузера (storage.session) либо последние 24 часа (fallback).
async function maybeShowBackupReminder() {
  if (notes.length <= BACKUP_NOTES_THRESHOLD) return;   // мало заметок — не беспокоим

  if (hasSessionStorage()) {
    let shown = false;
    try {
      const data = await browser.storage.session.get(BACKUP_REMINDER_KEY);
      shown = !!data[BACKUP_REMINDER_KEY];
    } catch {
      // session-хранилище недоступно — уходим на fallback ниже
      return maybeShowBackupReminderLocal();
    }
    if (shown) return;
    try {
      await browser.storage.session.set({ [BACKUP_REMINDER_KEY]: true });
    } catch { /* ignore */ }
    showToast({ text: "Не забудьте сделать резервную копию в настройках!" });
    return;
  }

  return maybeShowBackupReminderLocal();
}

// Fallback: напоминание не чаще одного раза в 24 часа (browser.storage.local)
async function maybeShowBackupReminderLocal() {
  let last = 0;
  try {
    const data = await browser.storage.local.get(BACKUP_REMINDER_TIME_KEY);
    last = Number(data[BACKUP_REMINDER_TIME_KEY]) || 0;
  } catch {
    last = 0;
  }
  if (Date.now() - last < BACKUP_REMINDER_INTERVAL) return;
  try {
    await browser.storage.local.set({ [BACKUP_REMINDER_TIME_KEY]: Date.now() });
  } catch { /* ignore */ }
  showToast({ text: "Не забудьте сделать резервную копию в настройках!" });
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

  // Во время поиска/фильтра перетаскивание отключено: скрытые заметки не должны менять порядок
  const listFiltered = !els.searchBar.hidden || !!filterHost;
  els.list.classList.toggle("manual", isManual() && !listFiltered);
  if (sortable) sortable.option("disabled", !isManual() || listFiltered);
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
  let list;
  if (isManual()) {
    ensureOrder();
    list = [...notes].sort((a, b) => a.orderIndex - b.orderIndex);
  } else {
    const dir = settings.sort === "newest" ? -1 : 1;
    list = [...notes].sort((a, b) => (a.createdAt - b.createdAt) * dir);
  }
  // Закреплённые заметки всегда вверху, независимо от текущей сортировки
  const pinned = list.filter((n) => n.isPinned);
  const rest = list.filter((n) => !n.isPinned);
  return pinned.concat(rest);
}

function initSortable() {
  if (typeof Sortable === "undefined") return;   // библиотека не найдена — ручной режим недоступен
  sortable = new Sortable(els.list, {
    animation: 150,
    draggable: ".note-item:not(.removing)",
    filter: ".note-action",
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
  if (note.isPinned) li.classList.add("pinned");

  const main = document.createElement("div");
  main.className = "note-main";

  const title = document.createElement("div");
  title.className = "note-title";
  if (note.title.trim()) title.textContent = note.title;
  else { title.textContent = "Без названия"; title.classList.add("untitled"); }
  main.appendChild(title);

  if (note.content.trim()) {
    const preview = document.createElement("div");
    preview.className = "note-preview markdown-body";
    // Превью рендерим как Markdown; HTML очищен через DOMPurify
    preview.innerHTML = renderMarkdown(note.content.trim().slice(0, 300));
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

  const actions = document.createElement("div");
  actions.className = "note-actions";

  const pin = document.createElement("button");
  pin.className = "note-action note-pin";
  pin.type = "button";
  pin.dataset.tip = note.isPinned ? "Открепить" : "Закрепить";
  pin.setAttribute("aria-label", note.isPinned ? "Открепить заметку" : "Закрепить заметку");
  pin.setAttribute("aria-pressed", String(!!note.isPinned));
  pin.innerHTML = ICON_PIN;

  const copy = document.createElement("button");
  copy.className = "note-action note-copy";
  copy.type = "button";
  copy.dataset.tip = "Копировать текст";
  copy.setAttribute("aria-label", "Копировать текст заметки");
  copy.innerHTML = ICON_COPY;

  const del = document.createElement("button");
  del.className = "note-action note-delete";
  del.type = "button";
  del.dataset.tip = "Удалить";
  del.setAttribute("aria-label", "Удалить заметку");
  del.innerHTML = ICON_TRASH;

  actions.append(pin, copy, del);
  li.append(main, actions);
  return li;
}

function searchQuery() {
  return els.searchBar.hidden ? "" : els.searchInput.value.trim();
}

function noteMatches(note, needle) {
  return note.title.toLowerCase().includes(needle) ||
    note.content.toLowerCase().includes(needle);
}

// Активный домен для фильтра; null — фильтр выключен
let filterHost = null;

// Домен текущей активной вкладки (для фильтра списка)
async function activeTabHost() {
  const tab = await getActiveTab();
  const url = tab && tab.url ? tab.url : "";
  return hostOf(url);
}

async function toggleFilter() {
  if (filterHost) {
    filterHost = null;
  } else {
    const host = await activeTabHost();
    if (!host) {
      showToast({ text: "Не удалось определить домен страницы", variant: "error", duration: 5000 });
      return;
    }
    filterHost = host;
  }
  updateFilterUI();
  renderList();
}

function updateFilterUI() {
  const on = !!filterHost;
  els.filterBtn.setAttribute("aria-pressed", String(on));
  els.filterBtn.dataset.tip = on ? `Фильтр: ${filterHost} (нажмите, чтобы выключить)` : "Фильтр по домену страницы";
}

function updateEmptyStates() {
  const q = searchQuery();
  const visible = els.list.querySelectorAll(".note-item:not(.removing)").length;
  const filtering = !!filterHost;
  els.empty.hidden = !(visible === 0 && notes.length === 0 && !q && !filtering);
  els.emptySearch.hidden = !(visible === 0 && !!q);
  els.emptyFilter.hidden = !(visible === 0 && filtering && !q);
}

function openSearch() {
  els.searchBar.hidden = false;
  els.searchBtn.setAttribute("aria-pressed", "true");
  els.searchBtn.setAttribute("aria-expanded", "true");
  els.searchBtn.dataset.tip = "Закрыть поиск";
  els.searchBtn.setAttribute("aria-label", "Закрыть поиск");
  updateSortUI();
  els.searchInput.focus();
}

function closeSearch({ clear = true } = {}) {
  els.searchBar.hidden = true;
  els.searchBtn.setAttribute("aria-pressed", "false");
  els.searchBtn.setAttribute("aria-expanded", "false");
  els.searchBtn.dataset.tip = "Поиск";
  els.searchBtn.setAttribute("aria-label", "Поиск по заметкам");
  if (clear) {
    els.searchInput.value = "";
    els.searchClear.hidden = true;
  }
  updateSortUI();
  renderList();
}

function toggleSearch() {
  if (els.searchBar.hidden) openSearch();
  else closeSearch();
}

let searchDebounceTimer = null;
const SEARCH_DEBOUNCE = 180;   // мс

function onSearchInput() {
  els.searchClear.hidden = !els.searchInput.value;
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(renderList, SEARCH_DEBOUNCE);
}

function clearSearchInput() {
  els.searchInput.value = "";
  els.searchClear.hidden = true;
  els.searchInput.focus();
  clearTimeout(searchDebounceTimer);
  renderList();
}

function renderList() {
  const q = searchQuery();
  const needle = q.toLowerCase();
  const sorted = sortedNotes();
  let visible = needle ? sorted.filter((note) => noteMatches(note, needle)) : sorted;
  // Фильтр по домену текущей вкладки
  if (filterHost) visible = visible.filter((note) => hostOf(note.url) === filterHost);

  const prevScroll = els.list.scrollTop;   // сохраняем позицию до перерисовки
  els.list.textContent = "";

  const instant = !!needle;   // при поиске список обновляется без каскадной анимации
  const items = visible.map((note, i) => {
    const li = buildNoteItem(note);
    if (instant) {
      li.classList.add("in");
    } else {
      li.style.transitionDelay = `${Math.min(i, 8) * 25}ms`;   // лёгкий каскад
    }
    els.list.appendChild(li);
    return li;
  });

  els.list.scrollTop = prevScroll;   // возвращаем прокрутку, чтобы список не «прыгал»
  updateEmptyStates();

  if (!instant) {
    // двойной rAF: стартовое состояние (opacity 0) должно успеть отрисоваться
    requestAnimationFrame(() => requestAnimationFrame(() => {
      items.forEach((li) => li.classList.add("in"));
    }));
    // после появления сбрасываем задержку, чтобы hover не «тормозил»
    setTimeout(() => items.forEach((li) => (li.style.transitionDelay = "")), 500);
  }
}

// Переключает закрепление заметки и перерисовывает список
function togglePin(id) {
  const note = notes.find((n) => n.id === id);
  if (!note) return;
  note.isPinned = !note.isPinned;
  persist();
  renderList();
}

// Копирует содержимое заметки в буфер обмена (не открывая редактор)
async function copyNoteContent(id) {
  const note = notes.find((n) => n.id === id);
  if (!note) return;
  try {
    await navigator.clipboard.writeText(note.content);
    showToast({ text: "Текст скопирован", variant: "success" });
  } catch {
    showToast({ text: "Не удалось скопировать", variant: "error", duration: 5000 });
  }
}

function openList() {
  renderList();
  showScreen("list");
}

/* =========================================================
   Корзина удалений
   =========================================================
   Удалённая заметка не стирается из хранилища сразу: она уезжает
   в очередь `trash` и живёт там до истечения таймаута тоста. Undo
   возвращает её обратно, таймаут — физически удаляет. */
// Единый таймер на всю очередь: пока тост Undo доступен, ни одна
// из подряд удалённых заметок не теряется. Каждое новое удаление
// перезапускает таймер, поэтому все записи живут до истечения тоста.
let trashCommitTimer = null;

function scheduleTrashCommit() {
  clearTrashCommit();
  trashCommitTimer = setTimeout(commitTrash, UNDO_DELAY);
}

function clearTrashCommit() {
  if (trashCommitTimer) clearTimeout(trashCommitTimer);
  trashCommitTimer = null;
}

// Фиксирует удаление: очищает всю очередь корзины и сохраняет хранилище
async function commitTrash() {
  clearTrashCommit();
  if (!trash.length) return;
  const pending = trash;
  trash = [];
  try {
    await persist();
  } catch (err) {
    trash = pending;   // не смогли — возвращаем очередь как была
  }
}

// Удаляет заметку из памяти и кладёт в корзину; при сбое persist — откат
async function stageDeletion(note, index) {
  notes.splice(index, 1);
  const entry = { note, index, at: Date.now() };
  trash.push(entry);
  try {
    await persist();
  } catch (err) {
    trash.pop();
    notes.splice(index, 0, note);
    throw err;
  }
  scheduleTrashCommit();
  return entry;
}

// Финализирует «подвисшие» записи корзины после перезагрузки панели:
// тост уже не показан, отменить нельзя — доводим удаление до конца
async function finalizeStaleTrash() {
  if (!trash.length) return;
  trash = [];
  try {
    await persist();
  } catch (err) {
    // не критично: записи останутся в хранилище и будут дочищены позже
  }
}

// Восстанавливает последнюю удалённую заметку (LIFO)
function undoLastDeletion() {
  const entry = trash[trash.length - 1];
  if (!entry) return;
  trash.pop();
  restoreDeletedNote(entry.note, entry.index);
  // Остались ещё удалённые заметки — держим тост и таймер живыми
  if (trash.length) {
    scheduleTrashCommit();
    showUndoToast();
  } else {
    clearTrashCommit();
  }
}

async function removeNoteFromList(li) {
  if (li.classList.contains("removing")) return;
  const id = li.dataset.id;
  const note = notes.find((n) => n.id === id);
  if (!note) return;
  const index = notes.indexOf(note);

  hideTooltip();
  li.style.transitionDelay = "0ms";
  li.style.height = `${li.offsetHeight}px`;   // фиксируем высоту, чтобы схлопнуть её плавно
  void li.offsetHeight;
  li.classList.add("removing");

  try {
    await stageDeletion(note, index);
  } catch (err) {
    // рассинхрон памяти и хранилища недопустим — возвращаем заметку в список
    li.classList.remove("removing");
    li.style.height = "";
    renderList();
    showToast({
      text: `Не удалось удалить заметку: ${err && err.message ? err.message : "ошибка записи"}`,
      variant: "error",
      duration: 5000
    });
    return;
  }

  showUndoToast();

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    li.remove();
    updateEmptyStates();
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
let viewMode = false;   // true — режим просмотра (HTML), false — режим редактирования

function setColorUI(color) {
  els.colorPicker.querySelectorAll(".color-dot").forEach((dot) => {
    dot.setAttribute("aria-checked", String(dot.dataset.color === color));
  });
}

// Применяет текущий режим к DOM: либо textarea-редактор, либо Markdown-просмотр
function applyViewMode() {
  els.viewBtn.setAttribute("aria-pressed", String(viewMode));
  els.viewBtn.dataset.tip = viewMode ? "Режим: просмотр" : "Режим: редактирование";
  els.viewBtn.setAttribute("aria-label", viewMode ? "Переключить на редактирование" : "Переключить на просмотр");

  els.body.hidden = viewMode;
  els.preview.hidden = !viewMode;

  if (viewMode) {
    const text = els.body.value.trim();
    els.preview.innerHTML = text
      ? renderMarkdown(text)
      : '<p class="editor-preview-empty">Заметка пуста</p>';
  }
}

function setViewMode(next) {
  if (viewMode === next) return;
  // Уходим из редактирования с правками — фиксируем их, чтобы просмотр был актуален
  if (next && !viewMode && dirty) scheduleSave();
  viewMode = next;
  applyViewMode();
  if (!viewMode) setTimeout(() => els.body.focus(), 0);
}

function toggleViewMode() {
  setViewMode(!viewMode);
}

function openEditor(id, { focusTitle = false, edit = false } = {}) {
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

  viewMode = !edit;          // по умолчанию открываем просмотр
  applyViewMode();

  showScreen("editor");
  setTimeout(() => {
    if (viewMode) return;
    (focusTitle ? els.title : els.body).focus();
  }, 50);
}

function scheduleSave() {
  dirty = true;
  els.status.textContent = "Изменения…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, AUTOSAVE_DELAY);
}

// Переносит значения из полей редактора в заметку; возвращает false,
// если сохранять нечего или заметку удалили в другом окне (защита от «воскрешения»)
function commitEditorFields() {
  if (!dirty || !editingId) return false;
  const note = notes.find((n) => n.id === editingId);
  if (!note) {           // заметки уже нет в актуальном массиве — не сохраняем
    dirty = false;
    return false;
  }
  note.title = els.title.value;
  note.content = els.body.value;
  note.updatedAt = Date.now();
  dirty = false;
  return true;
}

async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  // Заметку могли удалить в другом окне — сохранение «воскресило» бы её
  if (editingId && !notes.some((n) => n.id === editingId)) {
    dirty = false;
    showToast({
      text: "Заметка была удалена в другом окне",
      variant: "error",
      duration: 5000
    });
    editingId = null;
    openList();
    return;
  }
  if (!commitEditorFields()) return;
  await persist();
  if (currentScreen === "editor") els.status.textContent = "Сохранено";
}

// Синхронный вариант для pagehide: не ждём промис, чтобы не потерять правки
function flushSaveSync() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!commitEditorFields()) return;
  browser.storage.local.set({ [STORAGE_KEY]: notes, [TRASH_KEY]: trash });
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
  const note = notes.find((n) => n.id === editingId);
  if (!note) {
    editingId = null;
    openList();
    return;
  }

  clearTimeout(saveTimer);
  saveTimer = null;
  dirty = false;

  // Фиксируем актуальные значения из полей, чтобы Undo вернул последнюю версию
  note.title = els.title.value;
  note.content = els.body.value;
  note.updatedAt = Date.now();

  const index = notes.indexOf(note);
  editingId = null;
  showScreen("list");
  try {
    await stageDeletion(note, index);
  } catch (err) {
    renderList();
    showToast({
      text: `Не удалось удалить заметку: ${err && err.message ? err.message : "ошибка записи"}`,
      variant: "error",
      duration: 5000
    });
    return;
  }
  openList();
  showUndoToast();
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
  openEditor(note.id, { edit: true });   // новую заметку открываем сразу в редактировании
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
  await resetBackupReminder();   // бэкап сделан — сбрасываем напоминание
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/* =========================================================
   Импорт из JSON
   ========================================================= */
function extractImportedList(data) {
  const list = Array.isArray(data)
    ? data
    : (data && typeof data === "object" && Array.isArray(data.notes) ? data.notes : null);
  if (!list) throw new Error("ожидается массив заметок");
  if (!list.length) throw new Error("в файле нет заметок");
  return list;
}

function toImportedNote(raw, index) {
  const label = `заметка №${index + 1}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label}: ожидается объект`);
  }
  if (!("title" in raw) && !("content" in raw) && !("body" in raw) && !("url" in raw)) {
    throw new Error(`${label}: нет полей title/content/url`);
  }
  assertStringField(raw.title, "title", label);
  assertStringField(raw.content, "content", label);
  assertStringField(raw.body, "body", label);
  assertStringField(raw.url, "url", label);

  const note = normalizeNote({
    id: raw.id,
    title: strOrEmpty(raw.title),
    content: strOrEmpty(raw.content) || strOrEmpty(raw.body),
    url: strOrEmpty(raw.url),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    color: raw.color,
    orderIndex: raw.orderIndex,
    order: raw.order,
    links: raw.links,
    isPinned: raw.isPinned
  });
  if (!note) throw new Error(`${label}: некорректная структура заметки`);

  // Отбрасываем URL с недопустимой схемой — как при создании заметки
  note.url = safeUrl(note.url);

  if (typeof note.id !== "string" || !note.id) note.id = createNote().id;
  const now = Date.now();
  if (!Number.isFinite(note.createdAt)) note.createdAt = now;
  if (!Number.isFinite(note.updatedAt)) note.updatedAt = note.createdAt;
  return note;
}

async function importJson(file) {
  try {
    let data;
    let text;
    try {
      text = await file.text();
    } catch {
      throw new Error("не удалось прочитать файл");
    }
    try {
      data = JSON.parse(text.replace(/^\uFEFF/, ""));   // срезаем BOM, если файл сохранён на Windows
    } catch {
      throw new Error("файл не является корректным JSON");
    }

    const rawList = extractImportedList(data);
    const existingIds = new Set(notes.map((n) => n.id));
    const imported = [];
    let skipped = 0;

    rawList.forEach((raw, i) => {
      const note = toImportedNote(raw, i);
      if (existingIds.has(note.id)) {
        skipped += 1;
        return;
      }
      existingIds.add(note.id);
      imported.push(note);
    });

    if (!imported.length) {
      const message = skipped ? `Все заметки уже есть в хранилище (${skipped})` : "Нечего импортировать";
      els.exportHint.textContent = message;
      showToast({ text: message });
      return;
    }

    const previousNotes = notes;
    notes = notes.concat(imported);
    try {
      await persist();
    } catch (err) {
      notes = previousNotes;
      throw err;
    }
    if (isManual()) ensureOrder();
    if (currentScreen === "list") renderList();

    const summary = `Импортировано заметок: ${imported.length}${skipped ? `, пропущено: ${skipped}` : ""}`;
    els.exportHint.textContent = summary;
    showToast({
      text: summary,
      variant: "success"
    });
  } catch (err) {
    els.exportHint.textContent = "Импорт не выполнен";
    showToast({
      text: `Ошибка импорта: ${err && err.message ? err.message : "не удалось прочитать файл"}`,
      variant: "error",
      duration: 5000
    });
  }
}

/* =========================================================
   Тост: уведомления и отмена удаления
   ========================================================= */
let toastTimer = null;
let toastActionHandler = null;

function dismissToast() {
  clearTimeout(toastTimer);
  toastTimer = null;
  toastActionHandler = null;
  els.toast.classList.remove("show", "success", "error");
  els.toast.hidden = true;
  els.toastAction.hidden = true;
  els.toastProgress.hidden = true;
  els.toastProgress.style.animation = "none";
}

function showToast({
  text,
  actionLabel = "",
  onAction = null,
  duration = NOTICE_DELAY,
  variant = ""
}) {
  dismissToast();

  els.toast.hidden = false;
  if (variant) els.toast.classList.add(variant);
  els.toast.setAttribute("role", variant === "error" ? "alert" : "status");
  els.toast.setAttribute("aria-live", variant === "error" ? "assertive" : "polite");

  els.toastText.textContent = text;
  els.toastAction.textContent = actionLabel;
  els.toastAction.hidden = !actionLabel;
  toastActionHandler = onAction;

  if (actionLabel) {
    els.toastProgress.hidden = false;
    els.toastProgress.style.animation = "none";
    void els.toastProgress.offsetWidth;
    els.toastProgress.style.animation = `toast-progress ${duration}ms linear forwards`;
  }

  void els.toast.offsetWidth;   // reflow, чтобы transition сработал
  els.toast.classList.add("show");

  toastTimer = setTimeout(dismissToast, duration);
}

function restoreDeletedNote(note, index) {
  if (notes.some((n) => n.id === note.id)) return;
  const at = Number.isFinite(index) ? Math.min(Math.max(index, 0), notes.length) : notes.length;
  notes.splice(at, 0, note);
  persist();
  // Сбрасываем фильтр поиска, чтобы восстановленная заметка была видна
  if (!els.searchBar.hidden) closeSearch({ clear: true });
  else renderList();
}

function showUndoToast() {
  const count = trash.length;
  showToast({
    text: count > 1 ? `Удалено заметок: ${count}` : "Заметка удалена",
    actionLabel: "Отменить",
    duration: UNDO_DELAY,
    onAction: undoLastDeletion
  });
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
  const th = tooltip.offsetHeight;
  const left = Math.min(Math.max(r.left + r.width / 2 - tw / 2, 4), window.innerWidth - tw - 4);
  let top = r.bottom + 6;
  if (top + th > window.innerHeight - 4) top = r.top - th - 6;   // не помещается снизу — показываем сверху
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${Math.max(4, top)}px`;
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
els.searchBtn.addEventListener("click", toggleSearch);
els.filterBtn.addEventListener("click", toggleFilter);
els.searchInput.addEventListener("input", onSearchInput);
els.searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    closeSearch();
    els.searchBtn.focus();
  }
});
els.searchClear.addEventListener("click", clearSearchInput);
els.sortBtn.addEventListener("click", toggleSort);
els.modeBtn.addEventListener("click", toggleMode);
$("btn-settings").addEventListener("click", () => {
  els.exportHint.textContent = "";
  showScreen("settings");
});
$("btn-back-editor").addEventListener("click", closeEditor);
$("btn-back-settings").addEventListener("click", openList);
$("btn-delete").addEventListener("click", deleteCurrent);
els.viewBtn.addEventListener("click", toggleViewMode);
els.preview.addEventListener("click", onWikiLinkClick);
$("btn-export").addEventListener("click", exportJson);
$("btn-import").addEventListener("click", () => {
  els.importFile.value = "";
  els.importFile.click();
});
els.importFile.addEventListener("change", async () => {
  const file = els.importFile.files && els.importFile.files[0];
  if (!file) return;
  await importJson(file);
  els.importFile.value = "";
});
els.toastAction.addEventListener("click", () => {
  const action = toastActionHandler;
  dismissToast();
  if (action) action();
});
$("btn-reset").addEventListener("click", resetAccent);
els.themeSwitch.addEventListener("click", toggleTheme);
els.supportBtn.addEventListener("click", copySupportEmail);

els.palette.addEventListener("click", (e) => {
  const sw = e.target.closest(".swatch");
  if (sw) setAccent(sw.dataset.accent);
});

els.list.addEventListener("click", (e) => {
  const item = e.target.closest(".note-item");
  if (!item || item.classList.contains("removing")) return;
  if (e.target.closest(".wiki-link")) {
    onWikiLinkClick(e);          // Wiki-ссылка в превью открывает целевую заметку
  } else if (e.target.closest(".note-delete")) {
    e.stopPropagation();
    removeNoteFromList(item);
  } else if (e.target.closest(".note-pin")) {
    e.stopPropagation();
    togglePin(item.dataset.id);
  } else if (e.target.closest(".note-copy")) {
    e.stopPropagation();
    copyNoteContent(item.dataset.id);
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

// Сохранить несохранённое при закрытии панели (синхронно, без await)
window.addEventListener("pagehide", flushSaveSync);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) flushSaveSync();
});

// При смене активной вкладки обновляем фильтр по домену (если он включён)
if (browser.tabs && browser.tabs.onActivated) {
  browser.tabs.onActivated.addListener(async () => {
    if (!filterHost || currentScreen !== "list") return;
    filterHost = await activeTabHost();
    updateFilterUI();
    renderList();
  });
}

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

  const incoming = (changes[STORAGE_KEY].newValue || []).map(normalizeNote).filter(Boolean);
  // собственные записи не перерисовываем, иначе прервётся анимация
  if (JSON.stringify(incoming) === JSON.stringify(notes)) return;

  notes = incoming;
  // В редакторе список не перерисовываем, но массив notes держим актуальным,
  // чтобы проверка editingId замечала удаление заметки в другом окне.
  if (currentScreen === "list") renderList();
});

/* =========================================================
   Старт
   ========================================================= */
(async function init() {
  buildPalette();
  await loadAll();
  await finalizeStaleTrash();   // доводим до конца удаления, начатые до перезагрузки
  applyTheme(settings.theme);   // тема + сохранённый акцентный цвет
  initSortable();
  updateSortUI();
  updateFilterUI();
  openList();
  await maybeShowBackupReminder();   // напоминание о резервной копии (с учётом условий)
})();