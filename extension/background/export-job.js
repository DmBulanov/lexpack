/** Pure export-job state helpers. Loaded by the service worker and Node tests. */
(function () {
  const ACTIVE_JOB_STATUSES = new Set(["running", "stopping"]);
  const TERMINAL_ITEM_STATUSES = new Set(["completed", "failed", "stopped"]);

  function consCreateExportJob(input, now = Date.now()) {
    const items = (input.items || []).map((item, offset) => ({
      index: offset + 1,
      sourceIndex: item.index ?? offset + 1,
      title: String(item.title || `document-${offset + 1}`),
      url: String(item.url || ""),
      status: "queued",
      attempts: 0,
      error: null,
      filename: null,
      downloadId: null,
    }));
    return {
      version: 1,
      id: String(input.id || `job-${now}`),
      adapter: input.adapter,
      format: input.format,
      query: String(input.query || "").slice(0, 2000),
      scope: String(input.scope || "all"),
      folder: String(input.folder || "ConsExport"),
      status: "running",
      phase: "queued",
      nextIndex: 0,
      stopRequested: false,
      startedAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      finishedAt: null,
      current: null,
      lastError: null,
      log: [],
      reportEnabled: input.reportEnabled !== false,
      report: null,
      items,
    };
  }

  function consIsJobActive(job) {
    return Boolean(job && ACTIVE_JOB_STATUSES.has(job.status));
  }

  function consAppendJobLog(job, line, now = Date.now()) {
    const entry = `${new Date(now).toLocaleTimeString()} ${line}`;
    job.log = [...(job.log || []).slice(-99), entry];
    job.updatedAt = new Date(now).toISOString();
    return job;
  }

  function consMarkItemStarted(job, itemIndex, now = Date.now()) {
    const item = job.items[itemIndex];
    if (!item) throw new Error(`Нет элемента ${itemIndex}`);
    item.status = "running";
    item.attempts = Number(item.attempts || 0) + 1;
    item.error = null;
    job.phase = "processing";
    job.current = {
      itemIndex,
      tabId: null,
      downloadId: null,
      blobUrl: null,
      expectedFilename: null,
      sourceUrl: null,
      downloadKind: null,
      downloadStartedAt: null,
    };
    job.updatedAt = new Date(now).toISOString();
    return job;
  }

  function consMarkItemFinished(job, itemIndex, status, details = {}, now = Date.now()) {
    if (!TERMINAL_ITEM_STATUSES.has(status)) throw new Error(`Некорректный статус: ${status}`);
    const item = job.items[itemIndex];
    if (!item) throw new Error(`Нет элемента ${itemIndex}`);
    item.status = status;
    item.error = details.error ? String(details.error) : null;
    item.filename = details.filename || item.filename || null;
    item.downloadId = details.downloadId ?? item.downloadId ?? null;
    job.nextIndex = Math.max(job.nextIndex, itemIndex + 1);
    job.phase = "queued";
    job.current = null;
    job.lastError = item.error || job.lastError;
    job.updatedAt = new Date(now).toISOString();
    return job;
  }

  function consFinishJob(job, status, now = Date.now()) {
    if (!["done", "stopped", "failed"].includes(status)) {
      throw new Error(`Некорректный итоговый статус: ${status}`);
    }
    job.status = status;
    job.phase = "finished";
    job.current = null;
    job.finishedAt = new Date(now).toISOString();
    job.updatedAt = job.finishedAt;
    return job;
  }

  function consJobProgress(job) {
    if (!job) {
      return {
        current: 0,
        total: 0,
        completed: 0,
        failed: 0,
        status: "idle",
        lastError: null,
        log: [],
      };
    }
    const completed = job.items.filter((item) => item.status === "completed").length;
    const failed = job.items.filter((item) => item.status === "failed").length;
    const stopped = job.items.filter((item) => item.status === "stopped").length;
    return {
      jobId: job.id,
      current: completed + failed + stopped,
      total: job.items.length,
      completed,
      failed,
      stopped,
      status: job.status,
      phase: job.phase,
      lastError: job.lastError,
      log: job.log || [],
      report: job.report,
    };
  }

  const api = {
    consAppendJobLog,
    consCreateExportJob,
    consFinishJob,
    consIsJobActive,
    consJobProgress,
    consMarkItemFinished,
    consMarkItemStarted,
  };
  Object.assign(globalThis, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
