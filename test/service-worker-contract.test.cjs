const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(
  path.resolve(__dirname, "../extension/background/service-worker.js"),
  "utf8"
);

test("service worker persists jobs and has an alarm-backed resume path", () => {
  assert.match(source, /chrome\.storage\.session\.set/);
  assert.match(source, /chrome\.alarms\.create\(RESUME_ALARM/);
  assert.match(source, /chrome\.alarms\.onAlarm\.addListener/);
  assert.match(source, /readJob\(\)[\s\S]+ensureExportRunner/);
  assert.doesNotMatch(source, /const state\s*=\s*\{[\s\S]*running:/);
});

test("background serializes searches and waits for the online search UI", () => {
  assert.match(source, /if \(searchFlowInProgress\) throw new Error\("Поиск уже выполняется"\)/);
  assert.match(source, /await waitSearchReady\(tab\.id, message\.scope \|\| "practice"\)/);
  assert.match(source, /ping\.capabilities\?\.searchReady/);
  assert.match(source, /await waitSearchResultsReady\(tab\.id\)/);
});

test("export waits for the document pane and native controls", () => {
  assert.match(source, /await waitDocumentReady\(tab\.id, job\.format, job\.id\)/);
  assert.match(source, /ping\.capabilities\.wordSaveReady \|\| ping\.capabilities\.menuSaveReady/);
});

test("download completion and native filename determination are explicit", () => {
  assert.match(source, /chrome\.downloads\.onDeterminingFilename\.addListener/);
  assert.match(source, /chrome\.downloads\.onCreated\.addListener/);
  assert.match(source, /item\.state === "complete"/);
  assert.match(source, /item\.state === "interrupted"/);
  assert.match(source, /waitForDownloadCompletion/);
  assert.match(source, /consMatchesNativeDownload/);
  assert.match(source, /sourceUrl: url/);
});

test("stop requests are checked before tab extraction and while saving the report", () => {
  assert.match(source, /waitTabComplete\(tab\.id, TAB_TIMEOUT_MS, null, job\.id\)/);
  assert.match(source, /waitDocumentReady\(tab\.id, job\.format, job\.id\)/);
  assert.match(source, /await assertJobCanContinue\(job\.id\)/);
  assert.match(source, /latest\?\.stopRequested \|\| latest\?\.status === "stopping"/);
  assert.match(
    source,
    /draft\.stopRequested \|\|[\s\S]{0,80}draft\.status === "stopping"[\s\S]{0,800}updated\.stopRequested[\s\S]{0,80}updated\.status === "stopping"/
  );
});

test("all export item URLs cross the shared allowlist boundary", () => {
  assert.match(source, /consNormalizeDocumentUrl\(item\.url, job\.adapter\)/);
  assert.match(source, /consAssertFormatSupported\(adapter,/);
  assert.doesNotMatch(source, /fetch\(item\.url/);
  assert.doesNotMatch(source, /function parsePublicDocument/);
  assert.match(source, /canonicalUrl: consProvenanceUrl\(doc\?\.url \|\| fallbackUrl\)/);
});
