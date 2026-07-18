const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(
  path.resolve(__dirname, "../extension/background/service-worker.js"),
  "utf8"
);
const searchSource = fs.readFileSync(
  path.resolve(__dirname, "../extension/background/search-flow.js"),
  "utf8"
);

test("service worker persists jobs and has an alarm-backed resume path", () => {
  assert.match(source, /chrome\.storage\.session\.set/);
  assert.match(source, /chrome\.alarms\.create\(RESUME_ALARM/);
  assert.match(source, /chrome\.alarms\.onAlarm\.addListener/);
  assert.match(source, /readJob\(\)[\s\S]+ensureExportRunner/);
  assert.doesNotMatch(source, /const state\s*=\s*\{\s*running:/);
});

test("background owns query navigation and verifies query, scope, and settled results", () => {
  assert.match(source, /if \(searchFlowInProgress\) throw new Error\("Поиск уже выполняется"\)/);
  assert.match(source, /chrome\.tabs\.update\(tab\.id, \{ url: searchUrl \}\)/);
  assert.match(source, /importScripts\("search-flow\.js"\)/);
  assert.match(searchSource, /type: "GET_SEARCH_STATE"/);
  assert.match(searchSource, /type: "CLICK_SEARCH_SCOPE"/);
  assert.match(searchSource, /state\.queryMatches/);
  assert.match(searchSource, /state\.queryAuthoritative/);
  assert.match(searchSource, /state\.activeScope === scope/);
  assert.match(searchSource, /state\.resultsReady/);
  assert.match(source, /observeTabLoadCycle/);
  assert.doesNotMatch(source, /sendToTab\(tab\.id, \{\s*type: "RUN_SEARCH"/);
});

test("online practice continues through all results and selected court instances", () => {
  assert.match(source, /type: "OPEN_FULL_RESULTS"/);
  assert.match(source, /observeOpenedFullResultsTab\(tab, prepared\.fullResultsUrl\)/);
  assert.match(source, /activate: false/);
  assert.match(source, /activate: true/);
  assert.match(source, /isExpectedFullResultsUrl/);
  assert.match(source, /isOnlineFullResultsUrl/);
  assert.match(source, /type: "GET_FULL_RESULTS_STATE"/);
  assert.match(source, /type: "SELECT_JUDICIAL_CATEGORY"/);
  assert.match(source, /consNormalizeJudicialInstances/);
  assert.match(source, /waitFullResultsState\(tab\.id, query, instance, selected\)/);
  assert.match(source, /Number\(state\?\.resultsRevision/);
  assert.match(source, /allResults: true,[\s\S]{0,100}maxItems,[\s\S]{0,100}query,[\s\S]{0,100}category: instance/);
  assert.match(source, /category: instance,[\s\S]{0,60}prevalidated: true/);
  assert.match(source, /response\.query !== query \|\| response\.category\?\.key !== instance/);
  assert.match(source, /searchItemIdentity/);
  assert.match(source, /fullResultsTabId/);
  assert.match(source, /if \(ping\.adapter === "online-app"\)/);
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
  assert.match(source, /consNativeDownloadDecision/);
  assert.match(source, /sourceUrl: url/);
});

test("download diagnostics are closed, separate from reports, and exposed safely", () => {
  assert.match(source, /consNativeDownloadDecision/);
  assert.match(source, /consAppendDownloadDiagnostic/);
  assert.match(source, /case "GET_DOWNLOAD_DIAGNOSTICS"/);
  assert.match(source, /consSafeDownloadDiagnostics\(job\)/);
  const reportBody = source.slice(
    source.indexOf("function serializeJobReport"),
    source.indexOf("async function saveJobReport")
  );
  assert.doesNotMatch(reportBody, /downloadDiagnostics|nativeMatchCode/);
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
  assert.match(source, /CONS_JUDICIAL_INSTANCE_LABELS\[instance\]\) \|\| categoryLabel \|\| null/);
});
