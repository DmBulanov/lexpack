/** Report schema v2 projection. No browser download ids or raw diagnostic payloads. */
(function () {
  const runtimeApi =
    typeof module !== "undefined" && module.exports
      ? require("./runtime.js")
      : globalThis;

  function cleanText(value, maximum = 2000) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, maximum);
  }

  function counters(items) {
    const result = { total: 0, processed: 0, completed: 0, unconfirmed: 0, failed: 0, stopped: 0 };
    for (const item of Array.isArray(items) ? items : []) {
      result.total += 1;
      if (["completed", "unconfirmed", "failed", "stopped"].includes(item?.status)) {
        result.processed += 1;
      }
      if (["completed", "unconfirmed", "failed", "stopped"].includes(item?.status)) {
        result[item.status] += 1;
      }
    }
    return result;
  }

  function summaryStatus(result) {
    if (result.failed) return "completed_with_errors";
    if (result.unconfirmed) return "completed_with_unconfirmed";
    if (result.stopped) return "stopped";
    return "completed";
  }

  function safeMetadata(metadata) {
    const result = {};
    for (const field of ["date", "case", "court", "documentType"]) {
      const source = metadata?.[field] || {};
      result[field] = {
        value: cleanText(source.value, 240) || null,
        source: cleanText(source.source, 80) || null,
        confidence: ["exact", "high", "medium", "missing", "ambiguous"].includes(
          source.confidence
        )
          ? source.confidence
          : source.value
            ? "high"
            : "missing",
      };
    }
    return result;
  }

  function safeWarnings(warnings) {
    return (Array.isArray(warnings) ? warnings : []).slice(0, 24).map((warning) => ({
      code: cleanText(warning?.code, 80),
      token: cleanText(warning?.token, 40) || undefined,
      message: cleanText(warning?.message, 300),
    }));
  }

  function safeCleanup(cleanup) {
    const values = (source) => (Array.isArray(source) ? source : [])
      .slice(0, 24)
      .map((entry) => cleanText(entry, 80))
      .filter(Boolean);
    return { folder: values(cleanup?.folder), filename: values(cleanup?.filename) };
  }

  function safeProfile(profile) {
    return {
      schemaVersion: 1,
      id: cleanText(profile?.id, 64) || "default",
      name: cleanText(profile?.name, 80) || "По умолчанию",
      format: cleanText(profile?.format, 10),
      filenameTemplate: cleanText(profile?.filenameTemplate, 300),
      folderTemplate: cleanText(profile?.folderTemplate, 300),
      collisionPolicy: "ordered-suffix",
      createdAt: profile?.createdAt || null,
      updatedAt: profile?.updatedAt || null,
    };
  }

  function safeCollection(collection, itemCount) {
    return {
      source: collection?.source === "search" ? "search" : "current-list",
      scope: cleanText(collection?.scope, 200),
      total: Math.max(itemCount, Number(collection?.total) || itemCount),
      totalKnown: collection?.totalKnown === true,
      truncated: collection?.truncated === true,
      createdAt: collection?.createdAt || null,
    };
  }

  function reportItem(item, offset) {
    const expectedFilename = cleanText(item?.expectedFilename || item?.plannedFilename, 240);
    const actualFilename = cleanText(item?.actualFilename || item?.filename, 240) || null;
    const externalCollision = Boolean(
      actualFilename && expectedFilename && actualFilename !== expectedFilename
    );
    const collision = item?.collisionResolution || {};
    const normalizedMetadata = safeMetadata(item?.metadata);
    const sourceUrl = runtimeApi.consProvenanceUrl(item?.sourceUrl || item?.url);
    const exportIndex = Math.max(1, Number(item?.exportIndex ?? item?.index) || offset + 1);
    const originalTitle = cleanText(item?.originalTitle || item?.title, 500) || "document";
    return {
      exportIndex,
      sourceIndex: Math.max(1, Number(item?.sourceIndex) || exportIndex),
      selected: item?.selected !== false,
      originalTitle,
      normalizedMetadata,
      metadata: normalizedMetadata,
      instance: cleanText(item?.instance, 80) || null,
      instanceLabel: cleanText(item?.instanceLabel, 200) || null,
      safeSourceUrl: sourceUrl,
      plannedRelativeFolder: cleanText(item?.plannedRelativeFolder, 420),
      plannedFilename: cleanText(item?.plannedFilename, 240),
      plannedRelativePath: cleanText(item?.plannedRelativePath, 700),
      expectedFilename,
      actualFilename,
      attempts: Math.min(20, Math.max(0, Number(item?.attempts) || 0)),
      status: cleanText(item?.status, 20) || "queued",
      error: cleanText(item?.error, 1000) || null,
      warnings: safeWarnings(item?.warnings),
      cleanupRulesApplied: safeCleanup(item?.cleanupRulesApplied),
      collisionResolution: {
        type: cleanText(collision.type, 40) || "none",
        internal: collision.internal === true,
        external: externalCollision || collision.external === true,
        originalFilename: cleanText(collision.originalFilename, 240) || null,
        suffix: Number.isInteger(Number(collision.suffix)) ? Number(collision.suffix) : null,
      },

      // Compatibility aliases retained for scripts that consumed the 0.8 report.
      index: exportIndex,
      title: originalTitle,
      sourceUrl,
      filename: actualFilename,
    };
  }

  function consBuildReportV2(job = {}, context = {}) {
    const generatedAt = new Date(context.generatedAt ?? Date.now()).toISOString();
    const resultCounters = counters(job.items);
    const summary = { status: summaryStatus(resultCounters), ...resultCounters };
    return {
      schemaVersion: 2,
      generatedAt,
      extensionVersion: cleanText(job.extensionVersion || context.extensionVersion, 40),
      variant: cleanText(job.variant || context.variant, 40),
      adapter: cleanText(job.adapter, 40),
      jobId: cleanText(job.id, 80),
      startedAt: job.startedAt || null,
      finishedAt: job.finishedAt || generatedAt,
      query: job.reportQueryIncluded === false ? null : cleanText(job.query, 2000),
      scope: cleanText(job.scope, 200),
      format: cleanText(job.format, 10),
      profileSnapshot: safeProfile(job.profileSnapshot),
      collection: safeCollection(job.collection, resultCounters.total),
      selectedCount: Math.max(0, Number(job.selectedCount) || resultCounters.total),
      resultCounters,
      downloadDiagnostics: runtimeApi.consSanitizeDownloadDiagnostics(job.downloadDiagnostics),
      privacy: {
        historyMode: cleanText(job.historyMode, 20) || "safe",
        queryIncluded: job.reportQueryIncluded !== false,
      },
      summary,
      items: (Array.isArray(job.items) ? job.items : []).map(reportItem),
    };
  }

  const api = { consBuildReportV2 };
  Object.assign(globalThis, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
