const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(
  path.resolve(__dirname, "../extension/popup/popup.js"),
  "utf8"
);
const html = fs.readFileSync(
  path.resolve(__dirname, "../extension/popup/popup.html"),
  "utf8"
);

test("popup retries Safari's empty cold-start response once", () => {
  assert.match(
    source,
    /response === undefined \|\| response === null[\s\S]{0,180}setTimeout\(resolve, 150\)[\s\S]{0,180}chrome\.runtime\.sendMessage\(message\)/
  );
  assert.match(source, /Фоновый процесс расширения не ответил/);
});

test("cached result provenance is exported with the cached list", () => {
  assert.match(source, /let cachedQuery = ""/);
  assert.match(source, /let cachedScope = "current-list"/);
  assert.match(source, /cachedQuery = String\(meta\.query \|\| ""\)/);
  assert.match(source, /cachedScope = String\(meta\.scope \|\| "current-list"\)/);
  assert.match(source, /query: cachedQuery,[\s\S]*scope: cachedScope/);
  assert.doesNotMatch(
    source,
    /type: "START_TAB_EXPORT",[\s\S]{0,400}query: els\.query\.value\.trim\(\)/
  );
});

test("copied diagnostics add only the version to the shared allowlist and omit the job log", () => {
  assert.match(source, /type: "GET_DOWNLOAD_DIAGNOSTICS"/);
  assert.match(source, /consBuildSafeDiagnosticsSnapshot/);
  assert.match(source, /version: extensionVersionLabel\(\)/);
  assert.match(source, /manifest\.version_name \|\| manifest\.version/);
  assert.doesNotMatch(
    source,
    /btnProbe[\s\S]{0,1200}(?:progress\.log|response\.progress|job\.log)/
  );
});

test("popup exposes instance selection and full collection of the user-selected category", () => {
  for (const value of [
    "higher-courts",
    "arbitration-circuit",
    "arbitration-first",
    "arbitration-rulings",
  ]) {
    assert.match(html, new RegExp(`name="instance" value="${value}"`));
  }
  assert.doesNotMatch(html, /Обновить список/);
  assert.match(source, /if \(ping\.capabilities\?\.collectList\)/);
  assert.match(source, /await prepareOpenCollection\(ping\)/);
  assert.match(source, /instances: selectedInstances\(\)/);
  assert.match(
    source,
    /type: "COLLECT_LIST",[\s\S]{0,120}allResults: true,[\s\S]{0,80}maxItems: 200/
  );
  assert.match(source, /lastInstances/);
  assert.match(source, /response\.categoryTotalKnown/);
  assert.match(source, /response\.truncatedByLimit/);
  assert.match(source, /собрано \$\{response\.count\} из/);
  assert.match(source, /if \(meta\.truncated\)[\s\S]{0,140}\$\{found\} не менее/);
  assert.doesNotMatch(source, /type: "COLLECT_LIST",[\s\S]{0,160}prevalidated: true/);
});

test("popup explains the result-sized quantity, report, and exceptional downloads", () => {
  assert.match(
    html,
    /id="limitInfo"[\s\S]*автоматически выбраны все найденные документы[\s\S]*не\s+более 200/i
  );
  assert.doesNotMatch(html, /rememberQuery|rememberInfo|Запомнить запрос/);
  assert.match(html, /JSON — текстовый файл, его можно открыть в текстовом редакторе/);
  assert.match(source, /unconfirmed = 0/);
  assert.match(source, /if \(unconfirmed > 0\)/);
  assert.match(source, /требует проверки \$\{unconfirmed\}/);
  assert.match(source, /setProgressInfo\(hints\)/);
  assert.doesNotMatch(source, /не подтверждено \$\{unconfirmed\}/);
});

test("every explanatory hint is an accessible on-demand info popover", () => {
  const targets = [
    "searchInfo",
    "scopeInfo",
    "limitInfo",
    "formatInfo",
    "folderInfo",
    "progressInfo",
    "diagnosticsInfo",
    "resetInfo",
  ];
  for (const target of targets) {
    assert.match(
      html,
      new RegExp(
        `aria-haspopup="dialog"[\\s\\S]{0,160}aria-expanded="false"[\\s\\S]{0,160}` +
          `aria-controls="${target}"[\\s\\S]{0,160}data-info-target="${target}"`
      )
    );
    assert.match(
      html,
      new RegExp(`id="${target}"[\\s\\S]{0,100}class="info-popover"[\\s\\S]{0,100}role="dialog"`)
    );
  }
  assert.doesNotMatch(html, /class="[^"]*\bhint\b/);
  assert.doesNotMatch(html, /searchSettingsHint|folderHint|progressHint/);
  assert.doesNotMatch(html, /placeholder=/);
  assert.doesNotMatch(html, /быстрее, без окон/);
  assert.match(source, /function setupInfoPopovers\(\)/);
  assert.match(source, /event\.key !== "Escape"/);
  assert.match(source, /document\.addEventListener\("click"/);
  assert.match(source, /document\.addEventListener\("focusin"/);
  assert.match(source, /closeInfoPopover\(\{ restoreFocus: true \}\)/);
});

test("popup uses concise user-facing actions and keeps support tools collapsed", () => {
  assert.match(html, />Найти<\/button>/);
  assert.doesNotMatch(html, /Найти и скачать/);
  assert.doesNotMatch(html, /id="btnFindSave"/);
  assert.doesNotMatch(source, /btnFindSave|autoExport/);
  assert.match(source, /btnFind\.addEventListener\("click", \(\) => runFind\(\)\)/);
  assert.match(source, /`Скачать \$\{selected\} \$\{documentWord\(selected\)\}`/);
  assert.match(html, /Скачать открытый документ/);
  assert.match(html, /<summary>Помощь при ошибке<\/summary>/);
  assert.match(html, /Скопировать диагностику/);
  assert.match(html, /Сбросить настройки и историю/);
  assert.match(html, /Подпапка для документов и отчёта/);
  assert.match(html, /Основную папку и запрос места задаёт\s+Chrome/);
  assert.match(html, /Настройки загрузок Chrome/);
  assert.doesNotMatch(html, /Адаптер:|Страница:|В списке:/);
  assert.doesNotMatch(html, /Можно выбрать несколько:/);
  assert.doesNotMatch(html, /для установки и обычной передачи актов/);
  assert.doesNotMatch(html, /Разведка UI|Очистить локальные данные/);
  assert.match(source, /Не удалось скопировать — скопируйте диагностику из журнала вручную/);
  assert.match(source, /const defaultScope =/);
  assert.match(source, /const defaultFormat =/);
  assert.match(source, /Скачанные файлы и вход не изменятся/);
  assert.doesNotMatch(source, /btnScan/);
  assert.match(
    source,
    /const hasDownloadableCollection =\s*collectionStatus === "ready" && collectionReady && cachedItems\.length > 0/
  );
  assert.match(source, /els\.resultActions\.hidden = collectionStatus === "idle"/);
  assert.match(source, /collectList: pageCapabilities\.collectList === true/);
  assert.match(source, /btnOne\.hidden = !documentPage/);
  assert.doesNotMatch(source, /els\.rememberQuery|rememberQuery\.checked/);
});

test("result quantity is hidden until collection and defaults to the collected count", () => {
  assert.match(
    html,
    /<section id="resultActions" class="block result-actions" hidden>/
  );
  assert.match(html, /<label class="label" for="maxItems">Количество документов<\/label>/);
  assert.match(source, /const available = Math\.min\(200, cachedItems\.length\)/);
  assert.match(source, /els\.maxItems\.max = String\(Math\.max\(1, available\)\)/);
  assert.match(
    source,
    /els\.maxItems\.value = String\(Math\.max\(1, cachedItems\.length\)\)/
  );
  assert.match(source, /els\.maxItems\.addEventListener\("input"/);
  assert.match(source, /els\.maxItems\.addEventListener\("change"/);
  assert.match(
    source,
    /els\.maxItems\.addEventListener\("keydown"[\s\S]{0,180}event\.metaKey[\s\S]{0,180}exportCachedItems\(\)/
  );
  assert.ok(
    html.indexOf('id="resultActions"') < html.indexOf('class="block search-block"'),
    "the already-open collection must appear before the new-search form"
  );
});

test("manual judicial results remain independent from the optional new-search form", () => {
  assert.match(source, /function manualCategoryIsSupported\(category\)/);
  assert.match(source, /CONS_JUDICIAL_INSTANCES\.includes/);
  assert.match(source, /Выберите слева уровень судебной инстанции, который нужно скачать/);
  assert.match(source, /source: "current-list"/);
  assert.match(
    source,
    /function invalidateSearchCollection\(\) \{\s*if \(collectionSource === "search"\)/
  );
  assert.match(source, /collectionStatus !== "error"/);
  assert.match(source, /Повторить чтение/);
});

test("new-search controls use a closed native disclosure", () => {
  assert.match(
    html,
    /<details id="searchPanel" class="block search-block">\s*<summary id="searchSummary">Найти практику<\/summary>/
  );
  assert.doesNotMatch(
    html,
    /<details id="searchPanel" class="block search-block"\s+open/
  );
  assert.ok(
    html.indexOf('id="searchPanel"') < html.indexOf('id="query"'),
    "all new-search controls must be inside the disclosure"
  );
  assert.match(source, /collectionStatus === "idle"[\s\S]{0,100}"Найти практику"/);
  assert.match(source, /"Найти другую практику"/);
  assert.match(source, /els\.searchPanel\.open = false/);
});

test("document quantity is not persisted as a local preference", () => {
  const storeSettingsBody = source.slice(
    source.indexOf("async function storeSettings()"),
    source.indexOf("async function init()")
  );
  const initReadStart = source.indexOf("const stored = await chrome.storage.local.get([");
  const initSettingsRead = source.slice(
    initReadStart,
    source.indexOf("]);", initReadStart) + 3
  );
  assert.doesNotMatch(storeSettingsBody, /maxItems/);
  assert.doesNotMatch(initSettingsRead, /"maxItems"/);
  assert.match(
    source,
    /await chrome\.storage\.local\.remove\(\["lastQuery", "rememberQuery", "maxItems"\]\)/
  );
});

test("search text is never persisted and legacy saved-query keys are removed", () => {
  const storeSettingsBody = source.slice(
    source.indexOf("async function storeSettings()"),
    source.indexOf("async function init()")
  );
  const initReadStart = source.indexOf("const stored = await chrome.storage.local.get([");
  const initSettingsRead = source.slice(
    initReadStart,
    source.indexOf("]);", initReadStart) + 3
  );
  assert.doesNotMatch(html, /rememberQuery|rememberInfo|Запомнить запрос/);
  assert.doesNotMatch(storeSettingsBody, /lastQuery|rememberQuery/);
  assert.doesNotMatch(initSettingsRead, /"lastQuery"|"rememberQuery"/);
  assert.match(
    source,
    /chrome\.storage\.local\.remove\(\["lastQuery", "rememberQuery", "maxItems"\]\)/
  );
});

test("popup caches and restores the current collection through session-backed messages", () => {
  assert.match(source, /type: "CACHE_SEARCH_COLLECTION"/);
  assert.match(source, /type: "GET_SEARCH_COLLECTION"/);
  assert.match(source, /async function restoreCollection\(ping\)/);
  assert.match(source, /cache\?\.status !== "ready"/);
  assert.match(source, /applyItems\(cache\.items \|\| \[\]/);
});
