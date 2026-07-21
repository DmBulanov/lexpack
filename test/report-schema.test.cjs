const assert = require("node:assert/strict");
const test = require("node:test");

const { consBuildReportV2 } = require("../extension/shared/report-schema.js");

test("report v2 contains required planned/actual, metadata, attempts, and compatible fields", () => {
  const report = consBuildReportV2({
    id: "job-report",
    extensionVersion: "0.9.0-chrome",
    variant: "chrome",
    adapter: "online-app",
    startedAt: "2026-07-21T10:00:00.000Z",
    finishedAt: "2026-07-21T10:01:00.000Z",
    query: "аренда",
    scope: "practice",
    format: "pdf",
    selectedCount: 1,
    profileSnapshot: { id: "default", name: "По умолчанию", format: "pdf", filenameTemplate: "{title}", folderTemplate: "LexPack" },
    collection: { source: "search", total: 5, totalKnown: true },
    downloadDiagnostics: [{ at: "2026-07-21T10:00:01.000Z", code: "NM_RETRY", countBucket: "1", secret: "x" }],
    items: [{
      exportIndex: 1,
      sourceIndex: 5,
      selected: true,
      originalTitle: "Решение",
      sourceUrl: "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=ARB&n=1&token=SECRET",
      metadata: { case: { value: "А40-1/2025", source: "adapter", confidence: "exact" } },
      plannedRelativeFolder: "LexPack",
      plannedFilename: "Решение.pdf",
      plannedRelativePath: "LexPack/Решение.pdf",
      expectedFilename: "Решение.pdf",
      actualFilename: "Решение (2).pdf",
      attempts: 2,
      status: "failed",
      error: "timeout",
      warnings: [{ code: "X", message: "warning" }],
      cleanupRulesApplied: { folder: [], filename: ["separators-collapsed"] },
      collisionResolution: { type: "none", internal: false },
    }],
  }, { generatedAt: Date.UTC(2026, 6, 21, 10, 2, 0) });

  assert.equal(report.schemaVersion, 2);
  assert.equal(report.extensionVersion, "0.9.0-chrome");
  assert.equal(report.selectedCount, 1);
  assert.equal(report.resultCounters.failed, 1);
  assert.deepEqual(report.downloadDiagnostics, [{ at: "2026-07-21T10:00:01.000Z", code: "NM_RETRY", countBucket: "1" }]);
  const item = report.items[0];
  assert.equal(item.exportIndex, 1);
  assert.equal(item.sourceIndex, 5);
  assert.equal(item.normalizedMetadata.case.confidence, "exact");
  assert.equal(item.plannedFilename, "Решение.pdf");
  assert.equal(item.actualFilename, "Решение (2).pdf");
  assert.equal(item.collisionResolution.external, true);
  assert.equal(item.attempts, 2);
  assert.equal(item.error, "timeout");
  assert.equal(item.index, 1);
  assert.equal(item.title, "Решение");
  assert.equal(item.filename, "Решение (2).pdf");
  assert.equal(item.sourceUrl, "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=ARB&n=1");
  assert.doesNotMatch(JSON.stringify(report), /token=SECRET|downloadId/u);
});

test("report privacy keeps the query key but omits its value outside detailed mode", () => {
  const safe = consBuildReportV2({
    id: "safe-report",
    query: "чувствительный запрос",
    reportQueryIncluded: false,
    items: [],
  });
  assert.equal("query" in safe, true);
  assert.equal(safe.query, null);
  assert.equal(safe.privacy.queryIncluded, false);
});
