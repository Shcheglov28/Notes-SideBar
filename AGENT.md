# AGENT.md — системный промт для ИИ-агентов

> Этот файл — точка входа для любого ИИ-агента, который начинает работу с кодовой базой
> расширения **Notes Sidebar**. Прочитай его полностью перед любыми изменениями.

## 1. Общие правила (обязательно к соблюдению)

1. **Строго Vanilla JS (ES6+).** Без фреймворков (React/Vue/Svelte) и без сборщиков
   (webpack/vite/rollup). Код — обычные модули/скрипты, подключаемые через `<script>`.
2. **Хранилище — только `browser.storage.local` и `browser.storage.session`.**
   Никаких `localStorage`/`sessionStorage`. Пользовательские данные — в `storage.local`;
   одноразовые флаги на сессию браузера (например, напоминание о бэкапе
   `backupReminderShown`) — в `storage.session`, а при его недоступности — в
   `storage.local` с ключом времени (`lastBackupReminderTime`).
   Все записи идут через слой `persist()` / `persistSettings()`.
3. **Запрещён `innerHTML` для сырых данных.** Пользовательский текст (title, content, url)
   выводится через `textContent`. `innerHTML` допустим **только** для:
   - статичной SVG-разметки иконок из констант (`ICON_*`);
   - HTML, очищенного через `DOMPurify.sanitize()` (Markdown-рендер).
4. **Строго сплошные цвета в CSS.** Запрещены градиенты (`linear-gradient`, `radial-gradient`),
   `background-image` с цветами, тени-«свечения». Только `background: var(--…)` и сплошные
   значения. Все цвета — через CSS-переменные, чтобы работали обе темы.
5. **Темы.** Светлая/тёмная реализованы через `data-theme` на `<html>` и CSS-переменные
   (`:root` / `[data-theme="dark"]`). Любой новый элемент UI обязан иметь корректные цвета
   в обеих темах.
6. **Язык интерфейса — русский.** Комментарии в коде — на русском (следуем существующему стилю).

## 2. Карта файлов

| Файл | Ответственность |
|------|-----------------|
| `manifest.json` | Манифест MV3. Версия, разрешения (`storage`, `tabs`, `downloads`), `sidebar_action`, горячая клавиша `Alt+Shift+N`. |
| `sidebar/sidebar.html` | Разметка панели: три экрана (`#screen-list`, `#screen-editor`, `#screen-settings`), тост, тултип. Подключение библиотек и `sidebar.js`. |
| `sidebar/sidebar.css` | Все стили и CSS-переменные тем/акцентов. Сплошные цвета. |
| `sidebar/sidebar.js` | Вся логика: модель данных, хранилище, рендер списка, редактор, автосохранение, Undo, темы, Drag & Drop, Markdown, Pin, фильтр, копирование, Support. |
| `sidebar/lib/Sortable.min.js` | SortableJS — ручная сортировка (Drag & Drop). |
| `sidebar/lib/marked.min.js` | marked — парсинг Markdown. |
| `sidebar/lib/purify.min.js` | DOMPurify — очистка HTML после `marked.parse()`. |
| `AGENT.md` | Этот файл. |
| `Structure.md` | Журнал изменений версий (Changelog). |

## 3. Архитектура

### Модель данных
Заметка (`createNote` / `normalizeNote`):
```js
{
  id: string,            // crypto.randomUUID()
  title: string,
  content: string,       // Markdown
  url: string,           // источник (sourceUrl); может быть ""
  createdAt: number,     // timestamp
  updatedAt: number,     // timestamp
  color: "gray" | "red" | "yellow" | "green" | "blue" | "purple",
  orderIndex: number|null, // позиция в ручной сортировке
  links: string[],       // задел на будущее (граф связей)
  isPinned: boolean      // закреплена ли заметка (всегда сверху списка)
}
```
`normalizeNote` приводит старые/битые записи к актуальной схеме и возвращает `null` для
некорректных. Всегда нормализуй данные из хранилища и при импорте.

### Хранилище
- Ключи: `notes`, `notes_trash`, `settings`, `settings_accentColor`.
  Флаги напоминания о бэкапе: `backupReminderShown` (`storage.session`) и
  `lastBackupReminderTime` (`storage.local`, fallback).
- `persist()` атомарно пишет `notes` + `trash`; `persistSettings()` — настройки.
- `browser.storage.onChanged` синхронизирует несколько открытых панелей.

### Undo (Корзина удалений)
- Удаление не стирает заметку сразу: она уходит в очередь `trash` (`{note, index, at}`)
  и физически ещё лежит в хранилище.
- Пока показан тост Undo (`UNDO_DELAY = 3000мс`), `undoLastDeletion()` (LIFO) возвращает
  заметку. По истечении таймера `commitTrash()` удаляет окончательно.
- Единый таймер `trashCommitTimer` перезапускается на каждое удаление.
- `finalizeStaleTrash()` при старте доводит до конца удаления, начатые до перезагрузки.

### Темы
- `applyTheme(theme)` ставит `data-theme` на `<html>` и вызывает `applyAccent`.
- `applyAccent(id)` выставляет `--accent-*` из палитры `ACCENTS` (светлый/тёмный вариант).
- Настройки темы/сортировки/режима хранятся в `settings`.

### Drag & Drop
- Инициализируется `initSortable()` (SortableJS) только в ручном режиме (`settings.mode === "manual"`).
- `saveManualOrder()` пересчитывает `orderIndex` по DOM после перетаскивания.
- Во время поиска перетаскивание отключено.

### Экраны
`showScreen(name)` переключает `#screen-list` / `#screen-editor` / `#screen-settings`
с fade-анимацией через классы `.mounted` / `.active`.

### Markdown и Wiki-ссылки (v1.2.0)
- `renderMarkdown(text)` → `DOMPurify.sanitize(marked.parse(text))`.
- Wiki-ссылки `[[Название заметки]]` превращаются в кликабельные элементы;
  клик ищет заметку по `title` и открывает её в редакторе, иначе — Error Toast.

## 4. ЖЕЛЕЗНОЕ ПРАВИЛО (Changelog)

> **При любом изменении кода (по запросу пользователя в чате) ты ОБЯЗАН обновить файл
> `Structure.md`**, добавив запись о том:
> - **что** изменилось,
> - в какой **версии**,
> - какого **числа** (формат `ГГГГ-ММ-ДД`).
>
> Без обновления `Structure.md` задача не считается выполненной. Также синхронизируй
> версию в `manifest.json` при выпуске новой версии.

## 5. Чек-лист перед завершением задачи
- [ ] Нет `innerHTML` для пользовательских данных (только `textContent` / DOMPurify).
- [ ] Новые элементы UI корректны в светлой и тёмной темах (сплошные цвета).
- [ ] Версия в `manifest.json` соответствует записи в `Structure.md`.
- [ ] `Structure.md` обновлён.
