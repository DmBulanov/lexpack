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

test("search discovery always uses the hard 200-item cap, independent of download quantity", () => {
  const collectBody = source.slice(
    source.indexOf("async function collectJudicialInstances("),
    source.indexOf("async function executeSearchFlow(")
  );
  const executeBody = source.slice(
    source.indexOf("async function executeSearchFlow("),
    source.indexOf("async function runSearchFlow(")
  );

  assert.match(source, /const MAX_EXPORT_ITEMS = 200/);
  assert.match(
    collectBody,
    /async function collectJudicialInstances\(tab, query, requestedInstances\)/
  );
  assert.match(collectBody, /const maxItems = MAX_EXPORT_ITEMS/);
  assert.match(
    collectBody,
    /type: "COLLECT_LIST",[\s\S]{0,120}allResults: true,[\s\S]{0,80}maxItems,/
  );
  assert.doesNotMatch(collectBody, /requestedLimit|message\.maxItems/);
  assert.doesNotMatch(executeBody, /message\.maxItems/);
  assert.match(
    executeBody,
    /collectJudicialInstances\(\s*fullTab,\s*query,\s*message\.instances \|\|/
  );
});

test("search collections are persisted in session storage and exposed through scoped messages", () => {
  assert.match(source, /const SEARCH_COLLECTION_STORAGE_KEY = "searchCollection"/);
  assert.match(source, /async function persistSearchCollection\(options = \{\}\)/);
  assert.match(
    source,
    /chrome\.storage\.session\.set\(\{ \[SEARCH_COLLECTION_STORAGE_KEY\]: collection \}\)/
  );
  assert.match(source, /async function readSearchCollection\(\)/);
  assert.match(source, /function searchCollectionMatches\(collection, request = \{\}\)/);
  assert.match(source, /case "GET_SEARCH_COLLECTION"/);
  assert.match(source, /case "CACHE_SEARCH_COLLECTION"/);
  assert.match(source, /await persistSearchCollection\(message\)/);
  assert.match(
    source,
    /await persistSearchCollection\(\{[\s\S]{0,500}source: "search"[\s\S]{0,500}items: result\.items \|\| \[\]/
  );
});

test("export waits for the document pane and native controls", () => {
  assert.match(source, /await waitDocumentReady\(tab\.id, job\.format, job\.id\)/);
  assert.match(source, /ping\.capabilities\.wordSaveReady \|\| ping\.capabilities\.menuSaveReady/);
  assert.match(
    source,
    /const ready = await waitDocumentReady[\s\S]{0,300}ready\?\.documentTitle[\s\S]{0,250}consSafeFilename/
  );
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
  assert.match(source, /NM_FILENAME_FALLBACK/);
  assert.match(source, /DOWNLOAD_UNCONFIRMED/);
  assert.match(
    source,
    /nativeDecision\?\.code === "NM_FILENAME_FALLBACK"[\s\S]{0,500}ensureExportRunner\(\);[\s\S]{0,80}return;/
  );
  assert.match(
    source,
    /if \(matches\.length > 1\)[\s\S]{0,300}error\.code = "NM_AMBIGUOUS"/
  );
});

test("native download behavior is controlled by the selected build variant", () => {
  assert.match(source, /importScripts\("\.\.\/shared\/variant-config\.js"\)/);
  assert.match(source, /const NATIVE_DOWNLOAD_CONFIG = globalThis\.LEXPACK_VARIANT\?\.nativeDownloads/);
  assert.match(source, /NATIVE_DOWNLOAD_CONFIG\.maxAttempts/);
  assert.match(source, /NATIVE_DOWNLOAD_CONFIG\.controlSettleMs/);
  assert.match(source, /NATIVE_DOWNLOAD_CONFIG\.lateRecoveryGraceMs/);
  assert.match(source, /NATIVE_DOWNLOAD_CONFIG\.interItemDelayMs/);
  assert.match(source, /function isRetryableNativeStartTimeout/);
  assert.match(source, /recoverTimedOutNativeDownload/);
  assert.match(source, /consAppendDownloadDiagnostic\(draft, "NM_RETRY"\)/);
  assert.match(source, /attempts < NATIVE_DOWNLOAD_MAX_ATTEMPTS/);
  assert.match(source, /draft\.current = null/);
  assert.match(
    source,
    /result\.native && itemIndex \+ 1 < job\.items\.length[\s\S]{0,180}NATIVE_INTER_ITEM_DELAY_MS/
  );
  assert.match(source, /После \$\{NATIVE_DOWNLOAD_MAX_ATTEMPTS\} попыток/);
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
  assert.match(reportBody, /schemaVersion: 2/);
  assert.match(reportBody, /unconfirmed: progress\.unconfirmed/);
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

test("local reset removes every extension setting, completed job, and cached collection", () => {
  const resetBody = source.slice(
    source.indexOf('case "CLEAR_LOCAL_DATA"'),
    source.indexOf("default:", source.indexOf('case "CLEAR_LOCAL_DATA"'))
  );
  for (const key of [
    "lastQuery",
    "lastScope",
    "lastFormat",
    "downloadFolder",
    "rememberQuery",
    "maxItems",
    "lastInstances",
    "settingsSchemaVersion",
  ]) {
    assert.match(resetBody, new RegExp(`"${key}"`));
  }
  assert.match(
    resetBody,
    /chrome\.storage\.session\.remove\(\[[\s\S]{0,120}JOB_STORAGE_KEY,[\s\S]{0,80}PROGRESS_STORAGE_KEY,[\s\S]{0,80}SEARCH_COLLECTION_STORAGE_KEY,[\s\S]{0,40}\]\)/
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
