/** Privacy-aware local history records and bounded history-state operations. */
(function () {
  const runtimeApi =
    typeof module !== "undefined" && module.exports
      ? require("./runtime.js")
      : globalThis;

  const CONS_HISTORY_SCHEMA_VERSION = 1;
  const CONS_HISTORY_STORAGE_KEY = "exportHistory";
  const CONS_HISTORY_MODE_KEY = "historyMode";
  const CONS_HISTORY_LIMIT = 50;
  const CONS_HISTORY_MAX_BYTES = 4 * 1024 * 1024;
  const CONS_HISTORY_MODES = Object.freeze(["off", "safe", "detailed"]);
  const TERMINAL_STATUSES = new Set(["completed", "unconfirmed", "failed", "stopped"]);

  function consNormalizeHistoryMode(value) {
    return CONS_HISTORY_MODES.includes(value) ? value : "safe";
  }

  function isoOrNull(value) {
    return Number.isFinite(Date.parse(value || "")) ? new Date(value).toISOString() : null;
  }

  function cleanText(value, maximum = 500) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, maximum);
  }

  function safeReportFilename(value) {
    const filename = cleanText(value, 160);
    return /^LexPack-report-[0-9TZ-]+(?: \(\d+\))?\.json$/u.test(filename)
      ? filename
      : null;
  }

  function itemCounters(items) {
    const counters = { successful: 0, reviewRequired: 0, failed: 0, stopped: 0 };
    for (const item of Array.isArray(items) ? items : []) {
      if (item?.status === "completed") counters.successful += 1;
      else if (item?.status === "unconfirmed") counters.reviewRequired += 1;
      else if (item?.status === "failed") counters.failed += 1;
      else if (item?.status === "stopped") counters.stopped += 1;
    }
    return counters;
  }

  function safeBaseRecord(job, context, mode) {
    const counters = itemCounters(job?.items);
    const id = cleanText(job?.id || context.id, 80) || `history-${Date.now()}`;
    const selectedCount = Math.min(
      200,
      Math.max(0, Number(job?.selectedCount ?? job?.items?.length) || 0)
    );
    return {
      schemaVersion: CONS_HISTORY_SCHEMA_VERSION,
      id,
      mode,
      startedAt: isoOrNull(job?.startedAt),
      finishedAt: isoOrNull(job?.finishedAt) || new Date(context.now ?? Date.now()).toISOString(),
      extensionVersion: cleanText(job?.extensionVersion || context.extensionVersion, 40),
      variant: cleanText(job?.variant || context.variant, 40),
      status: cleanText(job?.status, 20) || "done",
      format: cleanText(job?.format, 10),
      profileName: cleanText(job?.profileSnapshot?.name, 80) || "По умолчанию",
      selectedCount,
      successful: counters.successful,
      reviewRequired: counters.reviewRequired,
      failed: counters.failed,
      stopped: counters.stopped,
      reportFilename: safeReportFilename(job?.report?.filename),
    };
  }

  function detailedItem(item) {
    const status = TERMINAL_STATUSES.has(item?.status) ? item.status : "failed";
    const safeSourceUrl = runtimeApi.consProvenanceUrl(
      item?.safeSourceUrl || item?.sourceUrl || item?.url
    );
    return {
      exportIndex: Math.max(1, Number(item?.exportIndex ?? item?.index) || 1),
      sourceIndex: Math.max(1, Number(item?.sourceIndex) || 1),
      originalTitle: cleanText(item?.originalTitle || item?.title, 500) || "document",
      metadata: sanitizeMetadata(item?.metadata),
      instance: cleanText(item?.instance, 80) || null,
      instanceLabel: cleanText(item?.instanceLabel, 200) || null,
      safeSourceUrl,
      plannedRelativeFolder: cleanText(item?.plannedRelativeFolder, 420),
      plannedFilename: cleanText(item?.plannedFilename, 240),
      plannedRelativePath: cleanText(item?.plannedRelativePath, 700),
      expectedFilename: cleanText(item?.expectedFilename, 240),
      actualFilename: cleanText(item?.actualFilename || item?.filename, 240) || null,
      attempts: Math.min(20, Math.max(0, Number(item?.attempts) || 0)),
      status,
      error: cleanText(item?.error, 1000) || null,
      warnings: sanitizeWarnings(item?.warnings),
      cleanupRulesApplied: sanitizeCleanup(item?.cleanupRulesApplied),
      collisionResolution: sanitizeCollision(item?.collisionResolution),
    };
  }

  function sanitizeMetadata(metadata) {
    const result = {};
    for (const field of ["date", "case", "court", "documentType"]) {
      const source = metadata?.[field];
      const confidence = ["exact", "high", "medium", "missing", "ambiguous"].includes(
        source?.confidence
      )
        ? source.confidence
        : source?.value
          ? "high"
          : "missing";
      result[field] = {
        value: cleanText(source?.value, 240) || null,
        source: cleanText(source?.source, 80) || null,
        confidence,
      };
    }
    return result;
  }

  function sanitizeWarnings(warnings) {
    return (Array.isArray(warnings) ? warnings : []).slice(0, 24).map((warning) => ({
      code: cleanText(warning?.code, 80),
      token: cleanText(warning?.token, 40) || undefined,
      message: cleanText(warning?.message, 300),
    }));
  }

  function sanitizeCleanup(cleanup) {
    const closed = (value) => (Array.isArray(value) ? value : [])
      .slice(0, 24)
      .map((entry) => cleanText(entry, 80))
      .filter(Boolean);
    return { folder: closed(cleanup?.folder), filename: closed(cleanup?.filename) };
  }

  function sanitizeCollision(collision) {
    return {
      type: cleanText(collision?.type, 40) || "none",
      internal: collision?.internal === true,
      external: collision?.external === true,
      originalFilename: cleanText(collision?.originalFilename, 240) || null,
      suffix: Number.isInteger(Number(collision?.suffix)) ? Number(collision.suffix) : null,
    };
  }

  function consCreateHistoryRecord(job, requestedMode = "safe", context = {}) {
    const mode = consNormalizeHistoryMode(requestedMode);
    if (mode === "off") return null;
    const base = safeBaseRecord(job, context, mode);
    if (mode === "safe") return base;
    return {
      ...base,
      adapter: cleanText(job?.adapter, 40),
      query: cleanText(job?.query, 2000),
      scope: cleanText(job?.scope, 200),
      profileSnapshot: sanitizeProfileSnapshot(job?.profileSnapshot),
      collection: sanitizeCollection(job?.collection),
      items: (Array.isArray(job?.items) ? job.items : []).slice(0, 200).map(detailedItem),
    };
  }

  function sanitizeProfileSnapshot(profile) {
    return {
      schemaVersion: 1,
      id: cleanText(profile?.id, 64) || "default",
      name: cleanText(profile?.name, 80) || "По умолчанию",
      format: cleanText(profile?.format, 10) || "docx",
      filenameTemplate: cleanText(profile?.filenameTemplate, 300) || "{index} - {title}",
      folderTemplate: cleanText(profile?.folderTemplate, 300) || "LexPack",
      collisionPolicy: "ordered-suffix",
      createdAt: isoOrNull(profile?.createdAt),
      updatedAt: isoOrNull(profile?.updatedAt),
    };
  }

  function sanitizeCollection(collection) {
    return {
      source: collection?.source === "search" ? "search" : "current-list",
      scope: cleanText(collection?.scope, 200),
      total: Math.min(200, Math.max(0, Number(collection?.total) || 0)),
      totalKnown: collection?.totalKnown === true,
      truncated: collection?.truncated === true,
      createdAt: isoOrNull(collection?.createdAt),
    };
  }

  function normalizeExistingRecord(record) {
    const mode = record?.mode === "detailed" ? "detailed" : "safe";
    const base = {
      schemaVersion: CONS_HISTORY_SCHEMA_VERSION,
      id: cleanText(record?.id, 80),
      mode,
      startedAt: isoOrNull(record?.startedAt),
      finishedAt: isoOrNull(record?.finishedAt),
      extensionVersion: cleanText(record?.extensionVersion, 40),
      variant: cleanText(record?.variant, 40),
      status: cleanText(record?.status, 20),
      format: cleanText(record?.format, 10),
      profileName: cleanText(record?.profileName, 80),
      selectedCount: Math.min(200, Math.max(0, Number(record?.selectedCount) || 0)),
      successful: Math.min(200, Math.max(0, Number(record?.successful) || 0)),
      reviewRequired: Math.min(200, Math.max(0, Number(record?.reviewRequired) || 0)),
      failed: Math.min(200, Math.max(0, Number(record?.failed) || 0)),
      stopped: Math.min(200, Math.max(0, Number(record?.stopped) || 0)),
      reportFilename: safeReportFilename(record?.reportFilename),
    };
    if (!base.id || !base.finishedAt) return null;
    if (mode === "safe") return base;
    return {
      ...base,
      adapter: cleanText(record?.adapter, 40),
      query: cleanText(record?.query, 2000),
      scope: cleanText(record?.scope, 200),
      profileSnapshot: sanitizeProfileSnapshot(record?.profileSnapshot),
      collection: sanitizeCollection(record?.collection),
      items: (Array.isArray(record?.items) ? record.items : []).slice(0, 200).map(detailedItem),
    };
  }

  function consNormalizeHistoryState(rawState) {
    const records = [];
    const seen = new Set();
    for (const candidate of Array.isArray(rawState?.records) ? rawState.records : []) {
      if (records.length >= CONS_HISTORY_LIMIT) break;
      const record = normalizeExistingRecord(candidate);
      if (!record || seen.has(record.id)) continue;
      records.push(record);
      seen.add(record.id);
    }
    return {
      schemaVersion: CONS_HISTORY_SCHEMA_VERSION,
      records: fitRecordsToBudget(records),
    };
  }

  function fitRecordsToBudget(records) {
    const bounded = records.slice(0, CONS_HISTORY_LIMIT);
    while (bounded.length) {
      const state = { schemaVersion: CONS_HISTORY_SCHEMA_VERSION, records: bounded };
      const size = new TextEncoder().encode(JSON.stringify(state)).byteLength;
      if (size <= CONS_HISTORY_MAX_BYTES) break;
      bounded.pop();
    }
    return bounded;
  }

  function consAppendHistoryRecord(state, record) {
    const normalized = consNormalizeHistoryState(state);
    if (!record) return normalized;
    const safeRecord = normalizeExistingRecord(record);
    if (!safeRecord) return normalized;
    const records = fitRecordsToBudget([
        safeRecord,
        ...normalized.records.filter((entry) => entry.id !== safeRecord.id),
      ]);
    return { schemaVersion: CONS_HISTORY_SCHEMA_VERSION, records };
  }

  function consDeleteHistoryRecord(state, id) {
    const normalized = consNormalizeHistoryState(state);
    normalized.records = normalized.records.filter((record) => record.id !== String(id || ""));
    return normalized;
  }

  const api = {
    CONS_HISTORY_LIMIT,
    CONS_HISTORY_MAX_BYTES,
    CONS_HISTORY_MODES,
    CONS_HISTORY_MODE_KEY,
    CONS_HISTORY_SCHEMA_VERSION,
    CONS_HISTORY_STORAGE_KEY,
    consAppendHistoryRecord,
    consCreateHistoryRecord,
    consDeleteHistoryRecord,
    consNormalizeHistoryMode,
    consNormalizeHistoryState,
  };
  Object.assign(globalThis, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
