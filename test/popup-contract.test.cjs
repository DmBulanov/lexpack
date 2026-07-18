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

test("copied diagnostics use the shared allowlist and never copy the job log", () => {
  assert.match(source, /type: "GET_DOWNLOAD_DIAGNOSTICS"/);
  assert.match(source, /consBuildSafeDiagnosticsSnapshot/);
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
  assert.match(html, /Все результаты поиска/);
  assert.match(html, /Собрать открытую категорию/);
  assert.match(source, /instances: selectedInstances\(\)/);
  assert.match(source, /type: "COLLECT_LIST",[\s\S]{0,120}allResults: true/);
  assert.match(source, /lastInstances/);
  assert.match(source, /response\.categoryTotalKnown/);
  assert.match(source, /response\.truncatedByLimit/);
  assert.match(source, /собрано \$\{response\.count\} из/);
  assert.match(source, /response\.truncated \? " \(достигнут лимит\)"/);
  assert.doesNotMatch(source, /type: "COLLECT_LIST",[\s\S]{0,160}prevalidated: true/);
});
