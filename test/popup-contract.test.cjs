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
  assert.match(source, /version: chrome\.runtime\.getManifest\(\)\.version/);
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
  assert.match(source, /if \(ping\.page === "list"\) await scanList\(\)/);
  assert.match(source, /instances: selectedInstances\(\)/);
  assert.match(source, /type: "COLLECT_LIST",[\s\S]{0,120}allResults: true/);
  assert.match(source, /lastInstances/);
  assert.match(source, /response\.categoryTotalKnown/);
  assert.match(source, /response\.truncatedByLimit/);
  assert.match(source, /собрано \$\{response\.count\} из/);
  assert.match(source, /response\.truncated \? " \(достигнут лимит\)"/);
  assert.doesNotMatch(source, /type: "COLLECT_LIST",[\s\S]{0,160}prevalidated: true/);
});

test("popup explains the 200-item limit, remembered query, report, and exceptional downloads", () => {
  assert.match(html, /id="limitInfo"[\s\S]*От 1 до 200 документов за одну задачу/i);
  assert.match(html, /id="rememberInfo"[\s\S]*только в этом[\s\S]*профиле Chrome/i);
  assert.match(html, /Запомнить запрос/);
  assert.match(html, /JSON — текстовый файл, его можно открыть в Блокноте/);
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
    "rememberInfo",
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
  assert.match(html, /Найти и скачать/);
  assert.match(html, /Скачать результаты/);
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
  assert.match(source, /const listPage = currentPage === "list"/);
  assert.doesNotMatch(source, /!cachedItems\.length \|\| !formatSupported/);
  assert.match(source, /btnOne\.hidden = !documentPage/);
  assert.match(
    source,
    /query\.addEventListener\("change"[\s\S]{0,120}rememberQuery\.checked[\s\S]{0,80}storeSettings/
  );
});
