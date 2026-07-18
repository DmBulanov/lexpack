const assert = require("node:assert/strict");
const test = require("node:test");

const {
  consAppendJobLog,
  consCreateExportJob,
  consFinishJob,
  consIsJobActive,
  consJobProgress,
  consMarkItemFinished,
  consMarkItemStarted,
} = require("../extension/background/export-job.js");

function createJob() {
  return consCreateExportJob(
    {
      id: "job-test",
      adapter: "online-app",
      format: "docx",
      folder: "ConsExport",
      query: "аренда",
      scope: "practice",
      items: [
        { index: 4, title: "Первый", url: "https://online.consultant.ru/?req=doc&n=1" },
        { index: 5, title: "Второй", url: "https://online.consultant.ru/?req=doc&n=2" },
      ],
    },
    Date.UTC(2026, 6, 18, 10, 0, 0)
  );
}

test("job progress counts processed, completed, and failed items consistently", () => {
  const job = createJob();
  assert.equal(consIsJobActive(job), true);
  assert.deepEqual(
    { ...consJobProgress(job), log: [] },
    {
      jobId: "job-test",
      current: 0,
      total: 2,
      completed: 0,
      failed: 0,
      stopped: 0,
      status: "running",
      phase: "queued",
      lastError: null,
      log: [],
      report: null,
    }
  );

  consMarkItemStarted(job, 0);
  assert.equal(job.items[0].attempts, 1);
  assert.equal(job.current.itemIndex, 0);
  consMarkItemFinished(job, 0, "completed", { filename: "01 - Первый.docx", downloadId: 10 });
  consMarkItemStarted(job, 1);
  consMarkItemFinished(job, 1, "failed", { error: "NETWORK_TIMEOUT" });

  const progress = consJobProgress(job);
  assert.equal(progress.current, 2);
  assert.equal(progress.completed, 1);
  assert.equal(progress.failed, 1);
  assert.equal(job.nextIndex, 2);
  assert.equal(job.lastError, "NETWORK_TIMEOUT");
});

test("finishing a job clears transient state and makes it inactive", () => {
  const job = createJob();
  consMarkItemStarted(job, 0);
  consAppendJobLog(job, "Обработка");
  consFinishJob(job, "stopped", Date.UTC(2026, 6, 18, 10, 1, 0));

  assert.equal(consIsJobActive(job), false);
  assert.equal(job.status, "stopped");
  assert.equal(job.phase, "finished");
  assert.equal(job.current, null);
  assert.match(job.finishedAt, /^2026-07-18T10:01:00/);
  assert.equal(job.log.length, 1);
});

test("reports are enabled by default and can be disabled for a single-document job", () => {
  assert.equal(createJob().reportEnabled, true);
  assert.equal(
    consCreateExportJob({
      id: "single",
      adapter: "online-app",
      format: "pdf",
      reportEnabled: false,
      items: [{ title: "Один", url: "https://online.consultant.ru/?req=doc&n=1" }],
    }).reportEnabled,
    false
  );
});
