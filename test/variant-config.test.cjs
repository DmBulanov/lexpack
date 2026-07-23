const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const chrome = require(path.join(root, "variants/chrome/config.json"));
const gost = require(path.join(root, "variants/chromium-gost/config.json"));
const baseManifest = require(path.join(root, "extension/manifest.base.json"));

test("Chrome and Chromium-Gost are explicit independently versioned variants", () => {
  assert.equal(chrome.id, "chrome");
  assert.equal(chrome.manifest.versionName, "0.9.2-chrome");
  assert.match(chrome.manifest.name, /\(Chrome\)$/);
  assert.equal(chrome.archiveName, "lexpack-chrome-0.9.2.zip");

  assert.equal(gost.id, "chromium-gost");
  assert.equal(gost.manifest.versionName, "0.9.2-gost");
  assert.match(gost.manifest.name, /\(Chromium-Gost\)$/);
  assert.equal(gost.archiveName, "lexpack-chromium-gost-0.9.2.zip");
});

test("only Chromium-Gost enables the slower guarded native-download policy", () => {
  assert.deepEqual(chrome.nativeDownloads, {
    startTimeoutMs: 35000,
    completionTimeoutMs: 60000,
    maxAttempts: 1,
    controlSettleMs: 0,
    lateRecoveryGraceMs: 0,
    interItemDelayMs: 0,
    matchWindowMs: 35000,
  });
  assert.deepEqual(gost.nativeDownloads, {
    startTimeoutMs: 35000,
    completionTimeoutMs: 60000,
    maxAttempts: 2,
    controlSettleMs: 1500,
    lateRecoveryGraceMs: 2500,
    interItemDelayMs: 5000,
    matchWindowMs: 40000,
  });
});

test("the base manifest loads generated variant configuration first", () => {
  assert.equal(baseManifest.manifest_version, 3);
  assert.equal(baseManifest.name, undefined);
  assert.equal(baseManifest.version, undefined);
  const mainWorldCleaner = baseManifest.content_scripts.find(
    (entry) => entry.world === "MAIN"
  );
  assert.deepEqual(mainWorldCleaner.matches, ["https://online.consultant.ru/*"]);
  assert.equal(mainWorldCleaner.run_at, "document_start");
  assert.deepEqual(mainWorldCleaner.js, [
    "shared/docx-sanitizer.js",
    "content/docx-cleaner-main.js",
  ]);
  const isolatedContentScript = baseManifest.content_scripts.find((entry) =>
    entry.js.includes("shared/variant-config.js")
  );
  assert.equal(
    isolatedContentScript.js[0],
    "shared/variant-config.js"
  );
  assert.equal(fs.existsSync(path.join(root, "extension/manifest.json")), false);
});
