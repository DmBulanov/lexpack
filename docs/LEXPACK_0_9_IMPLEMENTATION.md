# LexPack 0.9: техническая реализация

## Состояние до 0.9

Аудит выполнен по ветке `main` версии 0.8.4. Общий исходный код находится в
`extension/`, а Chrome и Chromium-Gost собираются из него с отдельными
`variants/*/config.json`. Manifest V3 service worker владеет поиском, временными
вкладками, очередью и сопоставлением нативных загрузок. Отдельного backend,
телеметрии и внешних runtime-зависимостей нет.

До 0.9 постоянные настройки находились в `chrome.storage.local` под ключами
`lastScope`, `lastFormat`, `downloadFolder`, `lastInstances` и
`settingsSchemaVersion`. Подборка (`searchCollection`), задача (`exportJob`) и
проекция прогресса (`exportProgress`) находились в `chrome.storage.session`.
Очередь имела версию 1 и создавала имя непосредственно перед загрузкой через
`consSafeFilename(title, index, format)`. Popup позволял выгрузить только первые
N документов. Постоянной истории не было.

JSON-отчёт уже объявлял `schemaVersion: 2`, однако был минимальной проекцией
задачи: запрос, scope, adapter, format, summary и несколько полей позиции. CSV-
реестра в актуальной ветке нет. Оба варианта передают подпапку и имя через
`downloads.download` и `downloads.onDeterminingFilename`. Последней защитой от
существующего локального файла остаётся ordered uniquify.

Сброс 0.8.4 удалял локальные настройки, session-подборку, очередь и прогресс,
но не затрагивал файлы на диске. Browser baseline до
изменений: manifest/build и 77 unit-тестов прошли; Playwright требует запуск
Chromium вне macOS sandbox из-за Mach-port ограничений среды.

## Архитектура 0.9

Поток данных:

```text
source adapter -> session collection -> metadata normalization -> export plan
-> явное подтверждение в planner -> существующий export runner
-> actual results -> report v2 -> ограниченная local history
```

Новые правила реализуются в независимых IIFE/UMD-модулях без bundler и без
фреймворка:

- `profile-storage` — модель, миграция и безопасные операции над профилями;
- `template-engine` — токены имён/папок и строгая проверка относительных путей;
- `metadata-parser` — консервативная нормализация русскоязычных метаданных;
- `export-plan` — выбор, экспортная нумерация, preview и внутренние коллизии;
- `report-schema` — единая проекция report schema v2;
- `history-storage` — privacy-aware записи `off` / `safe` / `detailed`;
- `planner/` — отдельная extension page для списка до 200 строк.

Planner передаёт готовый план service worker. Worker повторно валидирует его,
сохраняет snapshot профиля и все planned paths в задаче до первой загрузки.
Runner остаётся единственным. Его переходы состояния могут менять только
runtime-поля (`status`, `attempts`, actual result и error); planned path не
пересчитывается после перезапуска service worker.

Для безопасного нативного сопоставления destination filename отделён от
source-title filename: первый задаёт планируемый путь, второй используется
только существующим строгим fallback-сопоставлением загрузки КонсультантПлюс.

## Storage и миграции

Новые постоянные ключи:

- `exportProfileState` — schema 1, встроенный профиль, пользовательские профили
  и `selectedProfileId`;
- `historyMode` — `safe` по умолчанию, либо `off` / `detailed`;
- `exportHistory` — schema 1, максимум 50 завершённых задач и 4 MiB после
  нормализации; при достижении лимита удаляются самые старые записи.

При первом чтении профилей значения `lastFormat` и `downloadFolder` проходят
существующую миграцию и становятся format/folderTemplate встроенного профиля.
Его filenameTemplate равен `{index} - {title}`, а collisionPolicy —
`ordered-suffix`, поэтому обычное обновление сохраняет прежнее поведение.
Повреждённые пользовательские профили отбрасываются, встроенный профиль
восстанавливается, а отсутствующий/удалённый active id переключается на него.

Session-ключи `searchCollection`, `exportJob` и `exportProgress` сохраняются.
Версия новой job model — 2. Сброс удаляет старые и новые ключи, но не удаляет
уже скачанные документы и отчёты.

## Основные структуры

Профиль schema 1 содержит stable id, name, format, filenameTemplate,
folderTemplate, collisionPolicy и timestamps. Задача хранит immutable
`profileSnapshot`, collection metadata, history mode и для каждой выбранной
позиции: export/source indexes, original title, normalized metadata, planned
folder/name/path, expected filename, warnings, cleanup rules и internal
collision resolution.

Report schema v2 сохраняет совместимые `summary`, `index`, `title`, `filename`
и `sourceUrl`, а также version/variant, profile snapshot, collection metadata,
selected count, result counters, закрытые download diagnostics и полный planned
vs actual результат каждой позиции. Browser download ids, cookies, credentials
и raw referrer в отчёт не входят.

`safe` history не содержит query, titles, URLs, case/court и item list.
`detailed` хранит только данные, необходимые для просмотра и ручной подготовки
повтора; URL предварительно очищаются существующим allowlist. Ни один retry не
запускается автоматически: он сначала создаёт новый preview.

## Ограничения 0.9

- Метаданные предназначены только для организации файлов и не являются
  юридически подтверждёнными фактами.
- Пять сегментов относительной подпапки сохранены как общий лимит всех
  вариантов; абсолютные пути, traversal, URL, drive letters и UNC запрещены.
- Внутренние коллизии известны заранее; коллизия с уже существующим файлом
  разрешается browser uniquify и отражается как различие expected/actual.
- LexPack не редактирует DOCX, PDF или RTF, не выполняет OCR и не объединяет
  файлы.

## Автоматическая проверка инкремента

- unit tests покрывают профили/миграцию, шаблоны, metadata, коллизии,
  privacy-aware history с byte budget и report v2;
- browser tests покрывают сбор/переход в planner, выбор 2-й и 5-й строк,
  профили, preview, detailed retry, reset и полный virtualized list из 65 строк;
- отдельный lifecycle test останавливает и повторно запускает MV3 service worker,
  проверяет сохранение planned path/snapshot, читает фактический report v2 с
  диска и проверяет safe history в persistent storage;
- manifest/build checks выполняются для Chrome и Chromium-Gost.

## Ручная проверка

### Chrome

1. Обновить 0.8.4 с нестандартными format/folder и проверить миграцию default.
2. Собрать пять документов, выбрать 2-й и 5-й, сверить индексы и preview.
3. Проверить nested folder, внутреннюю и внешнюю коллизию для TXT и DOCX.
4. Перезапустить service worker во время нативной серии и сверить planned paths.
5. Проверить safe/detailed/off history, retry preview и полный reset.

### Chromium-Gost

Повторить Chrome-сценарии и отдельно проверить паузу, позднее обнаружение,
единственный `NM_RETRY`, отсутствие дубля и сохранение planned path после retry.
