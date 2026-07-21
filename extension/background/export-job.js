/** Pure export-job state helpers. Loaded by the service worker and Node tests. */
(function () {
  const diagnosticsApi =
    typeof module !== "undefined" && module.exports
      ? require("../shared/runtime.js")
      : globalThis;
  const ACTIVE_JOB_STATUSES = new Set(["running", "stopping"]);
  const TERMINAL_ITEM_STATUSES = new Set([
    "completed",
    "unconfirmed",
    "failed",
    "stopped",
  ]);
  const DOWNLOAD_DIAGNOSTIC_CODES = new Set(
    diagnosticsApi.CONS_DOWNLOAD_DIAGNOSTIC_CODES
  );

  function cloneValue(value, fallback) {
    try {
      return structuredClone(value ?? fallback);
    } catch {
      return structuredClone(fallback);
    }
  }

  function consCreateExportJob(input, now = Date.now()) {
    const items = (input.items || []).map((item, offset) => {
      const exportIndex = Number(item.exportIndex ?? item.index) || offset + 1;
      const originalTitle = String(
        item.originalTitle || item.title || `document-${offset + 1}`
      );
      const plannedFilename = item.plannedFilename || null;
      return {
        exportIndex,
        index: exportIndex,
        sourceIndex: item.sourceIndex ?? item.index ?? offset + 1,
        selected: item.selected !== false,
        originalTitle,
        title: originalTitle,
        sourceUrl: String(item.sourceUrl || item.url || ""),
        url: String(item.sourceUrl || item.url || ""),
        instance: item.instance || null,
        instanceLabel: item.instanceLabel || null,
        metadata: cloneValue(item.metadata, {}),
        plannedRelativeFolder: String(
          item.plannedRelativeFolder || input.folder || CONS_DEFAULT_DOWNLOAD_FOLDER
        ),
        plannedFilename,
        plannedRelativePath: String(
          item.plannedRelativePath ||
            `${
              item.plannedRelativeFolder || input.folder || CONS_DEFAULT_DOWNLOAD_FOLDER
            }/${plannedFilename || ""}`
        ),
        expectedFilename: String(item.expectedFilename || plannedFilename || "") || null,
        warnings: cloneValue(item.warnings, []),
        cleanupRulesApplied: cloneValue(item.cleanupRulesApplied, {
          folder: [],
          filename: [],
        }),
        collisionResolution: cloneValue(item.collisionResolution, {
          type: "none",
          internal: false,
          external: false,
        }),
        status: "queued",
        attempts: 0,
        error: null,
        filename: null,
        actualFilename: null,
        downloadId: null,
        startedAt: null,
        finishedAt: null,
      };
    });
    return {
      version: 2,
      id: String(input.id || `job-${now}`),
      adapter: input.adapter,
      format: input.format,
      query: String(input.query || "").slice(0, 2000),
      scope: String(input.scope || "all"),
      folder: String(input.reportRelativeFolder || input.folder || CONS_DEFAULT_DOWNLOAD_FOLDER),
      reportRelativeFolder: String(
        input.reportRelativeFolder || input.folder || CONS_DEFAULT_DOWNLOAD_FOLDER
      ),
      profileSnapshot: cloneValue(input.profileSnapshot, null),
      collection: cloneValue(input.collection, {}),
      selectedCount: Number(input.selectedCount) || items.length,
      historyMode: String(input.historyMode || "safe"),
      extensionVersion: String(input.extensionVersion || ""),
      variant: String(input.variant || ""),
      reportQueryIncluded: input.reportQueryIncluded !== false,
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
      downloadDiagnostics: [],
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

  function consAppendDownloadDiagnostic(job, code, count = 1, now = Date.now()) {
    if (!DOWNLOAD_DIAGNOSTIC_CODES.has(code)) {
      throw new Error(`Неизвестный диагностический код: ${code}`);
    }
    const numericCount = Number(count);
    const countBucket = numericCount <= 0 ? "0" : numericCount === 1 ? "1" : "many";
    const event = {
      at: new Date(now).toISOString(),
      code,
      countBucket,
    };
    job.downloadDiagnostics = [...(job.downloadDiagnostics || []).slice(-31), event];
    job.updatedAt = event.at;
    return job;
  }

  function consSafeDownloadDiagnostics(job) {
    return diagnosticsApi.consSanitizeDownloadDiagnostics(job?.downloadDiagnostics);
  }

  function consMarkItemStarted(job, itemIndex, now = Date.now()) {
    const item = job.items[itemIndex];
    if (!item) throw new Error(`Нет элемента ${itemIndex}`);
    item.status = "running";
    item.attempts = Number(item.attempts || 0) + 1;
    item.error = null;
    item.startedAt = item.startedAt || new Date(now).toISOString();
    job.phase = "processing";
    job.current = {
      itemIndex,
      tabId: null,
      downloadId: null,
      blobUrl: null,
      expectedFilename: null,
      expectedRelativeFolder: null,
      expectedRelativePath: null,
      sourceExpectedFilename: null,
      sourceUrl: null,
      downloadKind: null,
      downloadStartedAt: null,
      nativeMatchCode: null,
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
    item.actualFilename = details.filename || details.actualFilename || item.actualFilename || null;
    item.filename = item.actualFilename;
    item.downloadId = details.downloadId ?? item.downloadId ?? null;
    item.finishedAt = new Date(now).toISOString();
    if (
      item.actualFilename &&
      item.expectedFilename &&
      item.actualFilename !== item.expectedFilename
    ) {
      item.collisionResolution = {
        ...(item.collisionResolution || { type: "none", internal: false }),
        external: true,
      };
    }
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
    const finishedAt = new Date(now).toISOString();
    if (status === "stopped") {
      for (const item of job.items || []) {
        if (TERMINAL_ITEM_STATUSES.has(item.status)) continue;
        item.status = "stopped";
        item.error = item.error || "Не запущено: задача остановлена пользователем";
        item.finishedAt = finishedAt;
      }
    } else if (status === "failed") {
      for (const item of job.items || []) {
        if (TERMINAL_ITEM_STATUSES.has(item.status)) continue;
        item.status = "failed";
        item.error = item.error || job.lastError || "Задача завершилась с ошибкой";
        item.finishedAt = finishedAt;
      }
    }
    job.status = status;
    job.phase = "finished";
    job.current = null;
    job.finishedAt = finishedAt;
    job.updatedAt = job.finishedAt;
    return job;
  }

  function consJobProgress(job) {
    if (!job) {
      return {
        current: 0,
        total: 0,
        completed: 0,
        unconfirmed: 0,
        failed: 0,
        status: "idle",
        lastError: null,
        log: [],
      };
    }
    const completed = job.items.filter((item) => item.status === "completed").length;
    const unconfirmed = job.items.filter((item) => item.status === "unconfirmed").length;
    const failed = job.items.filter((item) => item.status === "failed").length;
    const stopped = job.items.filter((item) => item.status === "stopped").length;
    return {
      jobId: job.id,
      current: completed + unconfirmed + failed + stopped,
      total: job.items.length,
      completed,
      unconfirmed,
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
    consAppendDownloadDiagnostic,
    consCreateExportJob,
    consFinishJob,
    consIsJobActive,
    consJobProgress,
    consMarkItemFinished,
    consMarkItemStarted,
    consSafeDownloadDiagnostics,
  };
  Object.assign(globalThis, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
