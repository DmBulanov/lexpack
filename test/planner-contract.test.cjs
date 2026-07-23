const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(
  path.resolve(__dirname, "../extension/planner/planner.js"),
  "utf8"
);
const html = fs.readFileSync(
  path.resolve(__dirname, "../extension/planner/planner.html"),
  "utf8"
);

test("planner exposes arbitrary selection, source/export indexes, and live preview", () => {
  assert.match(html, /id="selectAll"/);
  assert.match(html, /id="selectNone"/);
  assert.match(html, /№ выгрузки/);
  assert.match(html, /№ источника/);
  assert.match(html, /Планируемый путь/);
  assert.match(source, /selectedSourceIndexes/);
  assert.match(source, /consBuildExportPlan/);
  assert.match(source, /data-source-index/);
  assert.match(source, /type: "START_PLANNED_EXPORT"/);
  assert.doesNotMatch(source, /START_TAB_EXPORT/);
});

test("planner manages profiles and blocks launch through plan validation", () => {
  for (const id of [
    "profileSelect", "newProfile", "duplicateProfile", "deleteProfile",
    "filenameTemplate", "folderTemplate", "saveProfile",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(source, /type: "PUT_EXPORT_PROFILE"/);
  assert.match(source, /type: "DELETE_EXPORT_PROFILE"/);
  assert.match(source, /currentPlan\?\.ok/);
  assert.match(source, /els\.startExport\.disabled = !canStart/);
});

test("history modes disclose detailed storage and retries return to preview", () => {
  assert.match(html, /src="\.\.\/shared\/history-storage\.js"/);
  assert.match(html, /value="off"/);
  assert.match(html, /value="safe"/);
  assert.match(html, /value="detailed"/);
  assert.match(html, /class="author-credit"/);
  assert.match(html, /https:\/\/t\.me\/Dmitry_Bulanov/);
  assert.match(html, /@Dmitry_Bulanov/);
  assert.match(source, /Подробная история будет хранить/);
  assert.match(source, /safeSourceUrl/);
  assert.match(source, /\["failed", "unconfirmed"\]/);
  assert.match(source, /Запуск только после нового preview/);
  assert.match(source, /function renderDetailedHistory\(details, record\)/);
  assert.match(source, /Подробный результат/);
  assert.match(source, /type: "SET_HISTORY_MODE"/);
  assert.match(source, /type: "CLEAR_HISTORY"/);
});
