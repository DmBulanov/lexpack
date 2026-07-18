const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(
  path.resolve(__dirname, "../extension/popup/popup.js"),
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
