const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CONS_HISTORY_LIMIT,
  CONS_HISTORY_MAX_BYTES,
  consAppendHistoryRecord,
  consCreateHistoryRecord,
  consDeleteHistoryRecord,
} = require("../extension/shared/history-storage.js");

function job(id = "job-1") {
  return {
    id,
    startedAt: "2026-07-21T10:00:00.000Z",
    finishedAt: "2026-07-21T10:01:00.000Z",
    extensionVersion: "0.9.0-chrome",
    variant: "chrome",
    status: "done",
    adapter: "online-app",
    format: "pdf",
    query: "SECRET QUERY",
    scope: "practice",
    profileSnapshot: { id: "default", name: "По умолчанию", format: "pdf", filenameTemplate: "{title}", folderTemplate: "LexPack" },
    collection: { source: "search", total: 1 },
    report: { filename: "LexPack-report-20260721-100000Z.json" },
    items: [{
      exportIndex: 1,
      sourceIndex: 5,
      originalTitle: "SECRET TITLE",
      sourceUrl: "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=ARB&n=1&token=SECRET",
      metadata: { case: { value: "SECRET CASE", source: "adapter", confidence: "exact" } },
      status: "failed",
      attempts: 2,
      error: "timeout",
    }],
  };
}

test("off creates no history and safe mode excludes sensitive fields", () => {
  assert.equal(consCreateHistoryRecord(job(), "off"), null);
  const safe = consCreateHistoryRecord(job(), "safe");
  const serialized = JSON.stringify(safe);
  assert.doesNotMatch(serialized, /SECRET QUERY|SECRET TITLE|SECRET CASE|consultant\.ru/u);
  assert.equal(safe.failed, 1);
  assert.equal(safe.reportFilename, "LexPack-report-20260721-100000Z.json");
  assert.equal("items" in safe, false);
});

test("detailed mode contains only a safe source URL and retry fields", () => {
  const detailed = consCreateHistoryRecord(job(), "detailed");
  assert.equal(detailed.query, "SECRET QUERY");
  assert.equal(detailed.items[0].originalTitle, "SECRET TITLE");
  assert.equal(
    detailed.items[0].safeSourceUrl,
    "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=ARB&n=1"
  );
  assert.doesNotMatch(JSON.stringify(detailed), /token=SECRET/u);
  assert.equal("downloadId" in detailed.items[0], false);
});

test("history is bounded, replaceable, deletable, and clearable", () => {
  let state = { records: [] };
  for (let index = 0; index < CONS_HISTORY_LIMIT + 5; index += 1) {
    state = consAppendHistoryRecord(state, consCreateHistoryRecord(job(`job-${index}`), "safe"));
  }
  assert.equal(state.records.length, CONS_HISTORY_LIMIT);
  assert.equal(state.records[0].id, `job-${CONS_HISTORY_LIMIT + 4}`);
  state = consDeleteHistoryRecord(state, state.records[0].id);
  assert.equal(state.records.length, CONS_HISTORY_LIMIT - 1);
  assert.deepEqual({ schemaVersion: 1, records: [] }, { schemaVersion: 1, records: [] });
});

test("detailed history drops oldest records before exceeding its byte budget", () => {
  let state = { records: [] };
  for (let recordIndex = 0; recordIndex < 20; recordIndex += 1) {
    const source = job(`large-${recordIndex}`);
    source.items = Array.from({ length: 200 }, (_, itemIndex) => ({
      ...source.items[0],
      exportIndex: itemIndex + 1,
      sourceIndex: itemIndex + 1,
      originalTitle: `Документ ${itemIndex} ${"Я".repeat(500)}`,
      plannedRelativePath: `LexPack/${"П".repeat(400)}`,
      error: "О".repeat(1000),
    }));
    state = consAppendHistoryRecord(
      state,
      consCreateHistoryRecord(source, "detailed")
    );
  }
  const size = new TextEncoder().encode(JSON.stringify(state)).byteLength;
  assert.ok(size <= CONS_HISTORY_MAX_BYTES);
  assert.ok(state.records.length < 20);
  assert.equal(state.records[0].id, "large-19");
});
