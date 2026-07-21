/** Background orchestration for search, durable export jobs, and downloads. */

importScripts("../shared/variant-config.js");
importScripts("../shared/filename.js");
importScripts("../shared/runtime.js");
importScripts("../shared/profile-storage.js");
importScripts("../shared/metadata-parser.js");
importScripts("../shared/template-engine.js");
importScripts("../shared/export-plan.js");
importScripts("../shared/history-storage.js");
importScripts("../shared/report-schema.js");
importScripts("export-job.js");
importScripts("search-flow.js");

const NATIVE_DOWNLOAD_CONFIG = globalThis.LEXPACK_VARIANT?.nativeDownloads;
if (!NATIVE_DOWNLOAD_CONFIG) {
  throw new Error("LexPack variant configuration is missing");
}

const JOB_STORAGE_KEY = "exportJob";
const PROGRESS_STORAGE_KEY = "exportProgress";
const SEARCH_COLLECTION_STORAGE_KEY = "searchCollection";
const RESUME_ALARM = "cons-export-resume";
const OFFSCREEN_PATH = "offscreen/sanitizer.html";
const MAX_EXPORT_ITEMS = 200;
const TAB_TIMEOUT_MS = 45000;
const CONTENT_TIMEOUT_MS = 12000;
const DIRECT_DOWNLOAD_TIMEOUT_MS = 90000;
const NATIVE_DOWNLOAD_START_TIMEOUT_MS = NATIVE_DOWNLOAD_CONFIG.startTimeoutMs;
const NATIVE_DOWNLOAD_TIMEOUT_MS = NATIVE_DOWNLOAD_CONFIG.completionTimeoutMs;
const NATIVE_DOWNLOAD_MAX_ATTEMPTS = NATIVE_DOWNLOAD_CONFIG.maxAttempts;
const NATIVE_CONTROL_SETTLE_MS = NATIVE_DOWNLOAD_CONFIG.controlSettleMs;
const NATIVE_LATE_RECOVERY_GRACE_MS = NATIVE_DOWNLOAD_CONFIG.lateRecoveryGraceMs;
const NATIVE_INTER_ITEM_DELAY_MS = NATIVE_DOWNLOAD_CONFIG.interItemDelayMs;
const POLL_MS = 400;
const DOWNLOAD_UNCONFIRMED_CODE = "DOWNLOAD_UNCONFIRMED";
const CONTENT_SCRIPT_FILES = [
  "shared/variant-config.js",
  "shared/filename.js",
  "shared/runtime.js",
  "content/adapters/public-site.js",
  "content/adapters/online-app.js",
  "content/content.js",
];

let jobMutationQueue = Promise.resolve();
let runnerPromise = null;
let offscreenCreating = null;
let jobStartInProgress = false;
let searchFlowInProgress = false;
const contentInjectionByTab = new Map();
const NATIVE_DIAGNOSTIC_RANK = Object.freeze({
  NM_REFERRER: 1,
  NM_FILENAME: 2,
  NM_URL: 3,
  NM_DOCUMENT: 4,
  NM_BASE: 5,
  NM_ID_MISSING: 6,
  NM_ID_MISMATCH: 7,
  NM_OWNER: 8,
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForActiveJobDelay(jobId, timeoutMs) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() < deadline) {
    const job = await readJob();
    if (
      !job ||
      job.id !== jobId ||
      !consIsJobActive(job) ||
      job.stopRequested ||
      job.status === "stopping"
    ) {
      return false;
    }
    await delay(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
  }
  return true;
}

function errorText(error) {
  return String(error?.message || error || "Неизвестная ошибка");
}

function unconfirmedDownloadError(message) {
  const error = new Error(message);
  error.code = DOWNLOAD_UNCONFIRMED_CODE;
  return error;
}

function isUnconfirmedDownloadError(error) {
  return [DOWNLOAD_UNCONFIRMED_CODE, "NM_AMBIGUOUS"].includes(error?.code);
}

function isRetryableNativeStartTimeout(error, job, itemIndex) {
  return Boolean(
    error?.code === DOWNLOAD_UNCONFIRMED_CODE &&
      job?.current?.itemIndex === itemIndex &&
      job.current.downloadKind === "native" &&
      job.current.downloadId == null
  );
}

async function readJob() {
  const stored = await chrome.storage.session.get(JOB_STORAGE_KEY);
  return stored[JOB_STORAGE_KEY] || null;
}

async function persistJob(job) {
  await chrome.storage.session.set({
    [JOB_STORAGE_KEY]: job,
    [PROGRESS_STORAGE_KEY]: consJobProgress(job),
  });
  return job;
}

function replaceJob(job) {
  const operation = jobMutationQueue.then(() => persistJob(job));
  jobMutationQueue = operation.catch(() => {});
  return operation;
}

function mutateJob(mutator) {
  const operation = jobMutationQueue.then(async () => {
    const current = await readJob();
    if (!current) return null;
    const draft = structuredClone(current);
    const result = (await mutator(draft)) || draft;
    return persistJob(result);
  });
  jobMutationQueue = operation.catch(() => {});
  return operation;
}

async function appendJobLog(line) {
  return mutateJob((job) => consAppendJobLog(job, line));
}

async function appendDownloadDiagnostic(jobId, code, count = 1) {
  return mutateJob((job) => {
    if (job.id === jobId) consAppendDownloadDiagnostic(job, code, count);
    return job;
  });
}

async function rememberNativeMatchDecision(jobId, decision) {
  if (!decision?.candidate || !NATIVE_DIAGNOSTIC_RANK[decision.code]) return;
  await mutateJob((job) => {
    if (job.id !== jobId || job.current?.downloadKind !== "native") return job;
    const previousRank = NATIVE_DIAGNOSTIC_RANK[job.current.nativeMatchCode] || 0;
    if (NATIVE_DIAGNOSTIC_RANK[decision.code] > previousRank) {
      job.current.nativeMatchCode = decision.code;
    }
    return job;
  });
}

async function getDownloadFolder() {
  const { downloadFolder, settingsSchemaVersion } = await chrome.storage.local.get([
    "downloadFolder",
    "settingsSchemaVersion",
  ]);
  const folder = consMigrateStoredDownloadFolder(downloadFolder, settingsSchemaVersion);
  if (Number(settingsSchemaVersion || 0) < CONS_SETTINGS_SCHEMA_VERSION) {
    await chrome.storage.local.set({
      downloadFolder: folder,
      settingsSchemaVersion: CONS_SETTINGS_SCHEMA_VERSION,
    });
  }
  return folder;
}

async function readProfileState() {
  const stored = await chrome.storage.local.get([
    CONS_PROFILE_STATE_KEY,
    "lastFormat",
    "downloadFolder",
    "settingsSchemaVersion",
  ]);
  const state = consMigrateProfileState(
    stored[CONS_PROFILE_STATE_KEY],
    stored,
    Date.now()
  );
  if (JSON.stringify(state) !== JSON.stringify(stored[CONS_PROFILE_STATE_KEY])) {
    await chrome.storage.local.set({ [CONS_PROFILE_STATE_KEY]: state });
  }
  return state;
}

async function persistProfileState(state) {
  const normalized = consMigrateProfileState(state);
  await chrome.storage.local.set({ [CONS_PROFILE_STATE_KEY]: normalized });
  return normalized;
}

async function readHistoryMode() {
  const stored = await chrome.storage.local.get(CONS_HISTORY_MODE_KEY);
  return consNormalizeHistoryMode(stored[CONS_HISTORY_MODE_KEY]);
}

async function readHistoryState() {
  const stored = await chrome.storage.local.get(CONS_HISTORY_STORAGE_KEY);
  return consNormalizeHistoryState(stored[CONS_HISTORY_STORAGE_KEY]);
}

async function persistHistoryState(state) {
  const normalized = consNormalizeHistoryState(state);
  await chrome.storage.local.set({ [CONS_HISTORY_STORAGE_KEY]: normalized });
  return normalized;
}

async function recordCompletedJobHistory(job) {
  if (!job || consIsJobActive(job) || job.historySaved) return;
  const mode = consNormalizeHistoryMode(job.historyMode);
  const record = consCreateHistoryRecord(job, mode, {
    extensionVersion: job.extensionVersion,
    variant: job.variant,
  });
  if (record) {
    const history = await readHistoryState();
    await persistHistoryState(consAppendHistoryRecord(history, record));
  }
  await mutateJob((draft) => {
    if (draft.id === job.id) draft.historySaved = true;
    return draft;
  });
}

async function recordCompletedJobHistoryBestEffort(job) {
  try {
    await recordCompletedJobHistory(job);
  } catch (error) {
    await mutateJob((draft) => {
      if (draft.id === job?.id) {
        consAppendJobLog(draft, `История не сохранена: ${errorText(error)}`);
      }
      return draft;
    }).catch(() => {});
  }
}

async function setResumeAlarm(active) {
  if (active) {
    await chrome.alarms.create(RESUME_ALARM, { periodInMinutes: 0.5 });
  } else {
    await chrome.alarms.clear(RESUME_ALARM);
  }
}

async function clearResumeAlarmBestEffort() {
  try {
    await setResumeAlarm(false);
  } catch {
    // A stale alarm is harmless; the next wake-up/startup retries cleanup.
  }
}

async function ensureOffscreenDocument() {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [documentUrl],
  });
  if (contexts.length) return;

  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["DOM_PARSER", "BLOBS"],
        justification: "Безопасная DOM-санитизация и создание локальных файлов экспорта",
      })
      .finally(() => {
        offscreenCreating = null;
      });
  }
  await offscreenCreating;
}

async function closeOffscreenDocument() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
    });
    if (contexts.length) await chrome.offscreen.closeDocument();
  } catch {
    // The document is a resource optimization; job correctness does not depend on closing it.
  }
}

async function offscreenRequest(type, payload = {}) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    type,
    ...payload,
  });
  if (!response?.ok) throw new Error(response?.error || `Offscreen error: ${type}`);
  return response;
}

async function buildExportBody(doc, format, fallbackUrl = "") {
  if (format === "html") {
    const response = await offscreenRequest("SANITIZE_HTML", {
      title: doc?.title || "document",
      html: doc?.html || "",
      canonicalUrl: consProvenanceUrl(doc?.url || fallbackUrl),
    });
    return { body: response.html, mime: "text/html;charset=utf-8" };
  }

  const text = String(doc?.text || "");
  if (new TextEncoder().encode(text).byteLength > 32 * 1024 * 1024) {
    throw new Error("Текст документа превышает безопасный лимит 32 МБ");
  }
  return { body: text, mime: "text/plain;charset=utf-8" };
}

async function createBlobUrl(content, mime) {
  const response = await offscreenRequest("CREATE_BLOB_URL", { content, mime });
  return response.url;
}

async function revokeBlobUrl(url) {
  if (!url) return;
  try {
    await offscreenRequest("REVOKE_BLOB_URL", { url });
  } catch {
    // Offscreen teardown or worker restart may already have released the URL.
  }
}

async function downloadGeneratedFile(folder, filename, content, mime) {
  const safeDestination = consSafeRelativeDownloadPath(folder, filename);
  const url = await createBlobUrl(content, mime);
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename: safeDestination.path,
      saveAs: false,
      conflictAction: "uniquify",
    });
    return { downloadId, blobUrl: url };
  } catch (error) {
    await revokeBlobUrl(url);
    throw error;
  }
}

function matchesCurrentDownload(item, current) {
  if (!current?.downloadKind) return false;
  if (["direct", "report"].includes(current.downloadKind)) {
    const startedAt = Date.parse(item.startTime || "");
    const expectedExtension = String(current.expectedFilename || "")
      .toLowerCase()
      .match(/\.([a-z0-9]+)$/)?.[1];
    const actualExtension = String(item.filename || "")
      .toLowerCase()
      .match(/\.([a-z0-9]+)$/)?.[1];
    return (
      item.byExtensionId === chrome.runtime.id &&
      Number.isFinite(startedAt) &&
      startedAt >= Number(current.downloadStartedAt || 0) - 2000 &&
      startedAt <= Number(current.downloadStartedAt || 0) + 30000 &&
      Boolean(expectedExtension) &&
      actualExtension === expectedExtension
    );
  }
  return consMatchesNativeDownload(item, current);
}

async function suggestedFilenameFor(downloadItem) {
  const job = await readJob();
  if (
    !consIsJobActive(job) ||
    job.stopRequested ||
    job.status === "stopping" ||
    !matchesCurrentDownload(downloadItem, job.current)
  ) {
    return null;
  }
  const expectedRelativePath = consSafeRelativeDownloadPath(
    job.current.expectedRelativeFolder || job.folder,
    job.current.expectedFilename
  ).path;
  return {
    filename: expectedRelativePath,
    conflictAction: "uniquify",
  };
}

function createCancelGuard(current) {
  if (!current?.downloadKind) return null;
  return {
    ...current,
    expiresAt: Math.max(
      Date.now() + 2000,
      Number(current.downloadStartedAt || Date.now()) + 32000
    ),
  };
}

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  suggestedFilenameFor(downloadItem)
    .then((suggestion) => suggest(suggestion || undefined))
    .catch(() => suggest());
  return true;
});

async function cancelGuardedDownload(job, downloadItem) {
  const guard = job?.cancelGuard;
  if (!guard) return false;
  if (Number(guard.expiresAt || 0) < Date.now()) {
    await mutateJob((draft) => {
      if (draft.id === job.id) {
        draft.cancelGuard = null;
        consAppendDownloadDiagnostic(draft, "DG_EXPIRED");
      }
      return draft;
    });
    return false;
  }
  if (!matchesCurrentDownload(downloadItem, guard)) return false;

  let diagnosticCode;
  let logLine;
  try {
    if (downloadItem.state === "in_progress") {
      await chrome.downloads.cancel(downloadItem.id);
      diagnosticCode = "DG_CANCEL_LATE";
      logLine = "Поздно появившаяся связанная загрузка отменена";
    } else {
      diagnosticCode = "DG_ALREADY_TERMINAL";
      logLine = "Связанная загрузка уже завершилась до отмены";
    }
  } catch {
    diagnosticCode = "DG_CANCEL_FAILED";
    logLine = "Не удалось отменить поздно появившуюся связанную загрузку";
  }
  await mutateJob((draft) => {
    if (draft.id === job.id) {
      consAppendDownloadDiagnostic(draft, diagnosticCode);
      consAppendJobLog(draft, logLine);
    }
    return draft;
  });
  return true;
}

async function attachCreatedDownload(downloadItem) {
  const job = await readJob();
  if (job?.stopRequested || job?.status === "stopping") {
    await cancelGuardedDownload(job, downloadItem);
    return;
  }
  if (!consIsJobActive(job)) {
    await cancelGuardedDownload(job, downloadItem);
    return;
  }
  if (job.current?.downloadId != null) return;
  const nativeDecision =
    job.current?.downloadKind === "native"
      ? consNativeDownloadDecision(downloadItem, job.current)
      : null;
  if (!(nativeDecision?.match ?? matchesCurrentDownload(downloadItem, job.current))) {
    await rememberNativeMatchDecision(job.id, nativeDecision);
    return;
  }
  if (nativeDecision?.code === "NM_FILENAME_FALLBACK") {
    await mutateJob((draft) => {
      if (draft.id === job.id && draft.current?.downloadId == null) {
        consAppendDownloadDiagnostic(draft, "NM_FILENAME_FALLBACK");
      }
      return draft;
    });
    // The polling recovery path checks that exactly one recent fallback
    // candidate exists before it assigns the download to the current item.
    ensureExportRunner();
    return;
  }

  const updated = await mutateJob((draft) => {
    if (
      draft.id !== job.id ||
      !consIsJobActive(draft) ||
      draft.stopRequested ||
      draft.status === "stopping" ||
      !draft.current ||
      draft.current.downloadId != null
    ) {
      return draft;
    }
    draft.current.downloadId = downloadItem.id;
    draft.phase = "waiting_download";
    if (draft.current.downloadKind === "native") {
      consAppendDownloadDiagnostic(draft, "NM_ATTACHED");
    }
    return draft;
  });
  if (
    !consIsJobActive(updated) ||
    updated.stopRequested ||
    updated.status === "stopping"
  ) {
    await cancelGuardedDownload(updated, downloadItem);
    return;
  }
  ensureExportRunner();
}

chrome.downloads.onCreated.addListener((item) => {
  attachCreatedDownload(item).catch(() => {});
});

chrome.downloads.onChanged.addListener(() => {
  ensureExportRunner();
});

async function findRecentDownloads(current) {
  const startedAfter = new Date(Number(current.downloadStartedAt || Date.now()) - 2000).toISOString();
  const candidates = await chrome.downloads.search({ startedAfter, limit: 50 });
  return candidates
    .filter((item) => matchesCurrentDownload(item, current))
    .sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime));
}

async function findRecentDownload(current) {
  const matches = await findRecentDownloads(current);
  if (matches.length > 1) {
    const error = new Error("Найдено несколько подходящих загрузок; сопоставление неоднозначно");
    error.code = "NM_AMBIGUOUS";
    throw error;
  }
  return matches[0];
}

async function waitForCurrentDownloadId(jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await readJob();
    if (!job || job.id !== jobId) throw new Error("Задача экспорта была заменена");
    if (job.stopRequested) throw new Error("Экспорт остановлен пользователем");
    if (job.current?.downloadId != null) return job.current.downloadId;

    let recovered;
    try {
      recovered = job.current && (await findRecentDownload(job.current));
    } catch (error) {
      if (error?.code === "NM_AMBIGUOUS" && job.current?.downloadKind === "native") {
        await appendDownloadDiagnostic(job.id, "NM_AMBIGUOUS");
      }
      throw error;
    }
    if (recovered) {
      await mutateJob((draft) => {
        if (draft.id === jobId && draft.current) {
          draft.current.downloadId = recovered.id;
          draft.phase = "waiting_download";
          if (draft.current.downloadKind === "native") {
            consAppendDownloadDiagnostic(draft, "NM_RECOVERED");
          }
        }
        return draft;
      });
      return recovered.id;
    }
    await delay(POLL_MS);
  }
  const timedOutJob = await readJob();
  if (timedOutJob?.id === jobId && timedOutJob.current?.downloadKind === "native") {
    await appendDownloadDiagnostic(
      jobId,
      timedOutJob.current.nativeMatchCode || "NM_TIMEOUT"
    );
  }
  throw unconfirmedDownloadError(
    "Расширение не подтвердило начало загрузки за отведённое время; файл мог сохраниться в «Загрузки»"
  );
}

async function waitForDownloadCompletion(jobId, downloadId, timeoutMs, allowStop = true) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (allowStop) {
      const job = await readJob();
      if (!job || job.id !== jobId) throw new Error("Задача экспорта была заменена");
      if (job.stopRequested) throw new Error("Экспорт остановлен пользователем");
    }

    const [item] = await chrome.downloads.search({ id: downloadId });
    if (!item) throw new Error(`Загрузка ${downloadId} не найдена`);
    if (item.state === "complete") return item;
    if (item.state === "interrupted") {
      throw new Error(`Загрузка прервана: ${item.error || "неизвестная причина"}`);
    }
    await delay(POLL_MS);
  }
  throw unconfirmedDownloadError(
    "Расширение не подтвердило завершение загрузки за отведённое время; проверьте «Загрузки» Chrome"
  );
}

async function assertJobCanContinue(jobId) {
  if (!jobId) return;
  const job = await readJob();
  if (!job || job.id !== jobId) throw new Error("Задача экспорта была заменена");
  if (job.stopRequested || job.status === "stopping") {
    throw new Error("Экспорт остановлен пользователем");
  }
}

async function waitTabComplete(
  tabId,
  timeoutMs = TAB_TIMEOUT_MS,
  expectedUrl = null,
  jobId = null
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await assertJobCanContinue(jobId);
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new Error("Рабочая вкладка была закрыта");
    }
    const urlReady = !expectedUrl || tab.url === expectedUrl || tab.url?.startsWith(expectedUrl);
    if (tab.status === "complete" && urlReady) return tab;
    await delay(300);
  }
  throw new Error("Превышено время загрузки вкладки");
}

function observeTabLoadCycle(tabId) {
  const state = { sawLoading: false, sawComplete: false };
  const listener = (updatedTabId, changeInfo) => {
    if (updatedTabId !== tabId) return;
    if (changeInfo.status === "loading") {
      state.sawLoading = true;
      state.sawComplete = false;
    } else if (changeInfo.status === "complete" && state.sawLoading) {
      state.sawComplete = true;
    }
  };
  chrome.tabs.onUpdated.addListener(listener);
  return {
    state,
    dispose() {
      chrome.tabs.onUpdated.removeListener(listener);
    },
  };
}

function isMissingContentReceiver(error) {
  return /(?:receiving end does not exist|could not establish connection)/i.test(
    errorText(error)
  );
}

async function ensureContentScripts(tabId) {
  if (!contentInjectionByTab.has(tabId)) {
    const injection = chrome.scripting
      .executeScript({
        target: { tabId },
        files: CONTENT_SCRIPT_FILES,
      })
      .finally(() => contentInjectionByTab.delete(tabId));
    contentInjectionByTab.set(tabId, injection);
  }
  return contentInjectionByTab.get(tabId);
}

async function sendToTab(tabId, message) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    // A newly navigated tab may not have a content-script receiver yet.
    if (response !== undefined && response !== null) return response;
  } catch (error) {
    if (!isMissingContentReceiver(error)) throw error;
  }
  await ensureContentScripts(tabId);
  return chrome.tabs.sendMessage(tabId, message);
}

async function waitContentReady(tabId, jobId = null) {
  const deadline = Date.now() + CONTENT_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    await assertJobCanContinue(jobId);
    try {
      const ping = await sendToTab(tabId, { type: "PING" });
      if (ping?.ok) return ping;
      lastError = ping?.error || ping?.code || "Страница не готова";
    } catch (error) {
      lastError = errorText(error);
    }
    await delay(400);
  }
  throw new Error(lastError || "Content script не отвечает");
}

async function waitDocumentReady(tabId, format, jobId) {
  const deadline = Date.now() + CONTENT_TIMEOUT_MS;
  let lastError = "Документ ещё не готов";
  while (Date.now() < deadline) {
    await assertJobCanContinue(jobId);
    try {
      const ping = await sendToTab(tabId, { type: "PING" });
      if (!ping?.ok) {
        lastError = ping?.error || lastError;
      } else if (ping.authRequired || ping.page === "auth-required") {
        const error = new Error("Сессия завершилась; войдите в КонсультантПлюс повторно");
        error.code = "AUTH_REQUIRED";
        throw error;
      } else if (ping.adapter === "public-site" && ping.capabilities?.documentReady) {
        return ping;
      } else if (ping.adapter === "online-app" && ping.capabilities?.documentReady) {
        const native = ["docx", "pdf", "rtf"].includes(format);
        const nativeReady =
          format === "docx"
            ? ping.capabilities.wordSaveReady || ping.capabilities.menuSaveReady
            : ping.capabilities.menuSaveReady;
        if (!native || nativeReady) return ping;
        lastError = "Команда нативного сохранения ещё не готова";
      }
    } catch (error) {
      if (error?.code === "AUTH_REQUIRED") throw error;
      lastError = errorText(error);
    }
    await delay(300);
  }
  throw new Error(lastError);
}

async function updateCurrent(jobId, patch, phase) {
  return mutateJob((job) => {
    if (job.id !== jobId || !job.current) return job;
    Object.assign(job.current, patch);
    if (phase) job.phase = phase;
    job.updatedAt = new Date().toISOString();
    return job;
  });
}

async function cleanupResources(job, cancelDownload = false) {
  const current = job?.current;
  if (!current) return;
  if (cancelDownload && current.downloadId != null) {
    try {
      const [download] = await chrome.downloads.search({ id: current.downloadId });
      if (download?.state === "in_progress") await chrome.downloads.cancel(current.downloadId);
    } catch {
      // Best effort cancellation.
    }
  }
  if (current.tabId != null) {
    try {
      await chrome.tabs.remove(current.tabId);
    } catch {
      // The user may already have closed the temporary tab.
    }
  }
  await revokeBlobUrl(current.blobUrl);
}

async function resumeExistingDownload(job) {
  const current = job.current;
  if (!current?.downloadKind) return null;
  const completionTimeout = current.downloadKind === "native"
    ? NATIVE_DOWNLOAD_TIMEOUT_MS
    : DIRECT_DOWNLOAD_TIMEOUT_MS;
  const startTimeout = current.downloadKind === "native"
    ? NATIVE_DOWNLOAD_START_TIMEOUT_MS
    : DIRECT_DOWNLOAD_TIMEOUT_MS;
  const downloadId =
    current.downloadId ?? (await waitForCurrentDownloadId(job.id, startTimeout));
  const completed = await waitForDownloadCompletion(
    job.id,
    downloadId,
    completionTimeout
  );
  return {
    downloadId,
    filename: downloadBasename(completed, current.expectedFilename),
    completed,
    native: current.downloadKind === "native",
  };
}

async function recoverTimedOutNativeDownload(job, graceMs) {
  if (!job?.current || job.current.downloadKind !== "native") return null;
  const active = await waitForActiveJobDelay(job.id, graceMs);
  if (!active) return null;

  let latest = await readJob();
  if (
    !latest ||
    latest.id !== job.id ||
    latest.current?.downloadKind !== "native"
  ) {
    return null;
  }

  if (latest.current.downloadId == null) {
    const recovered = await findRecentDownload(latest.current);
    if (!recovered) return null;
    await mutateJob((draft) => {
      if (
        draft.id === job.id &&
        draft.current?.downloadKind === "native" &&
        draft.current.downloadId == null
      ) {
        draft.current.downloadId = recovered.id;
        draft.phase = "waiting_download";
        consAppendDownloadDiagnostic(draft, "NM_RECOVERED");
      }
      return draft;
    });
    latest = await readJob();
  }

  if (latest?.current?.downloadId == null) return null;
  return resumeExistingDownload(latest);
}

function downloadBasename(downloadItem, fallback) {
  const normalized = String(downloadItem?.filename || "").replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() || fallback;
}

async function processExportItem(job, itemIndex) {
  const item = job.items[itemIndex];
  if (!item) throw new Error(`Документ ${itemIndex + 1} отсутствует`);

  if (job.current?.itemIndex === itemIndex && job.current.downloadKind) {
    try {
      return await resumeExistingDownload(job);
    } finally {
      await cleanupResources(await readJob());
    }
  }

  if (job.current) await cleanupResources(job);
  await mutateJob((draft) => consMarkItemStarted(draft, itemIndex));
  await appendJobLog(`Обработка [${itemIndex + 1}/${job.items.length}] ${item.title.slice(0, 70)}`);

  const url = consNormalizeDocumentUrl(item.url, job.adapter);
  const capabilities = consGetAdapterCapabilities(job.adapter);
  const isNative = capabilities.nativeFormats.includes(job.format);
  const expectedDestination = consSafeRelativeDownloadPath(
    item.plannedRelativeFolder || job.reportRelativeFolder || job.folder,
    item.plannedFilename ||
      consSafeFilename(item.title, item.exportIndex || itemIndex + 1, job.format),
    job.format
  );
  const expectedFilename = expectedDestination.filename;
  const expectedRelativeFolder = expectedDestination.folder;
  const expectedRelativePath = expectedDestination.path;
  let sourceExpectedFilename = consSafeFilename(
    item.title,
    item.exportIndex || itemIndex + 1,
    job.format
  );

  const tab = await chrome.tabs.create({ url, active: false });
  await updateCurrent(job.id, { tabId: tab.id }, "loading_tab");

  try {
    await waitTabComplete(tab.id, TAB_TIMEOUT_MS, null, job.id);
    const ready = await waitDocumentReady(tab.id, job.format, job.id);
    if (ready?.documentTitle) {
      sourceExpectedFilename = consSafeFilename(
        ready.documentTitle,
        item.exportIndex || itemIndex + 1,
        job.format
      );
    }
    await assertJobCanContinue(job.id);

    if (isNative) {
      const settled = await waitForActiveJobDelay(job.id, NATIVE_CONTROL_SETTLE_MS);
      if (!settled) await assertJobCanContinue(job.id);
      const startedAt = Date.now();
      await updateCurrent(
        job.id,
        {
          downloadKind: "native",
          downloadStartedAt: startedAt,
          expectedFilename,
          expectedRelativeFolder,
          expectedRelativePath,
          sourceExpectedFilename,
          sourceUrl: url,
          extensionId: chrome.runtime.id,
        },
        "triggering_native_download"
      );
      await assertJobCanContinue(job.id);
      const extracted = await sendToTab(tab.id, {
        type: "EXTRACT_DOCUMENT",
        format: job.format,
      });
      if (!extracted?.ok || !extracted.doc?.nativeSaveTriggered) {
        throw new Error(extracted?.error || "Сайт не запустил нативное сохранение");
      }
      const downloadId = await waitForCurrentDownloadId(
        job.id,
        NATIVE_DOWNLOAD_START_TIMEOUT_MS
      );
      const completed = await waitForDownloadCompletion(
        job.id,
        downloadId,
        NATIVE_DOWNLOAD_TIMEOUT_MS
      );
      return {
        downloadId,
        filename: downloadBasename(completed, expectedFilename),
        native: true,
      };
    }

    const extracted = await sendToTab(tab.id, {
      type: "EXTRACT_DOCUMENT",
      format: job.format,
    });
    if (!extracted?.ok || !extracted.doc) {
      throw new Error(extracted?.error || "Не удалось извлечь документ");
    }
    if (extracted.doc.nativeSaveTriggered) {
      throw new Error("Адаптер неожиданно запустил нативный экспорт");
    }

    const { body, mime } = await buildExportBody(extracted.doc, job.format, url);
    await assertJobCanContinue(job.id);
    const startedAt = Date.now();
    await updateCurrent(
      job.id,
      {
        downloadKind: "direct",
        downloadStartedAt: startedAt,
        expectedFilename,
        expectedRelativeFolder,
        expectedRelativePath,
      },
      "starting_download"
    );
    await assertJobCanContinue(job.id);
    const download = await downloadGeneratedFile(
      expectedRelativeFolder,
      expectedFilename,
      body,
      mime
    );
    await updateCurrent(
      job.id,
      { downloadId: download.downloadId, blobUrl: download.blobUrl },
      "waiting_download"
    );
    const completed = await waitForDownloadCompletion(
      job.id,
      download.downloadId,
      DIRECT_DOWNLOAD_TIMEOUT_MS
    );
    return {
      downloadId: download.downloadId,
      filename: downloadBasename(completed, expectedFilename),
    };
  } finally {
    await cleanupResources(await readJob());
  }
}

function reportFilename(job) {
  const stamp = (job.startedAt || new Date().toISOString())
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")
    .replace("T", "-");
  return `LexPack-report-${stamp}.json`;
}

function serializeJobReport(job) {
  return JSON.stringify(
    consBuildReportV2(job, {
      extensionVersion:
        chrome.runtime.getManifest().version_name || chrome.runtime.getManifest().version,
      variant: globalThis.LEXPACK_VARIANT?.id || "unknown",
    }),
    null,
    2
  );
}

async function saveJobReport(job) {
  if (job.current?.downloadKind === "report") {
    const resumed = await resumeExistingDownload(job);
    return { filename: resumed.filename, downloadId: resumed.downloadId };
  }

  const filename = reportFilename(job);
  const startedAt = Date.now();
  await mutateJob((draft) => {
    draft.phase = "saving_report";
    const reportDestination = consSafeRelativeDownloadPath(
      draft.reportRelativeFolder || draft.folder,
      filename,
      "json"
    );
    draft.current = {
      itemIndex: -1,
      tabId: null,
      downloadId: null,
      blobUrl: null,
      expectedFilename: reportDestination.filename,
      expectedRelativeFolder: reportDestination.folder,
      expectedRelativePath: reportDestination.path,
      downloadKind: "report",
      downloadStartedAt: startedAt,
    };
    return draft;
  });
  await assertJobCanContinue(job.id);
  const download = await downloadGeneratedFile(
    consSanitizeFolder(job.reportRelativeFolder || job.folder),
    filename,
    serializeJobReport(await readJob()),
    "application/json;charset=utf-8"
  );
  await updateCurrent(job.id, {
    downloadId: download.downloadId,
    blobUrl: download.blobUrl,
  });
  const completed = await waitForDownloadCompletion(
    job.id,
    download.downloadId,
    DIRECT_DOWNLOAD_TIMEOUT_MS
  );
  await revokeBlobUrl(download.blobUrl);
  return {
    filename: downloadBasename(completed, filename),
    downloadId: download.downloadId,
  };
}

async function stopCurrentWork(job) {
  const cancelGuard = createCancelGuard(job.current);
  let stopWarning = null;
  if (cancelGuard) {
    const guardWasArmed = Boolean(job.cancelGuard);
    await mutateJob((draft) => {
      if (draft.id === job.id) {
        draft.cancelGuard = cancelGuard;
        if (!guardWasArmed) consAppendDownloadDiagnostic(draft, "DG_ARMED");
      }
      return draft;
    });
    const deadline = Date.now() + 1500;
    let matches = [];
    let cancelledCount = 0;
    let cancellationFailures = 0;
    let scanFailed = false;
    try {
      while (!matches.length && Date.now() < deadline) {
        matches = await findRecentDownloads(job.current);
        if (!matches.length) await delay(150);
      }
      for (const match of matches) {
        if (match.state !== "in_progress") continue;
        try {
          await chrome.downloads.cancel(match.id);
          cancelledCount += 1;
        } catch {
          cancellationFailures += 1;
        }
      }
    } catch {
      scanFailed = true;
    }
    stopWarning = scanFailed
      ? "Не удалось проверить состояние связанной загрузки"
      : cancellationFailures
        ? "Не все связанные загрузки удалось отменить"
        : matches.length
          ? "Связанные выполнявшиеся загрузки остановлены"
          : "Загрузка ещё не обнаружена; поздний старт будет перехвачен";

    await mutateJob((draft) => {
      if (draft.id !== job.id) return draft;
      if (scanFailed) consAppendDownloadDiagnostic(draft, "DG_SCAN_FAILED");
      if (cancelledCount) {
        consAppendDownloadDiagnostic(draft, "DG_CANCEL_EXISTING", cancelledCount);
      }
      if (cancellationFailures) {
        consAppendDownloadDiagnostic(draft, "DG_CANCEL_FAILED", cancellationFailures);
      }
      if (!scanFailed && !matches.length) {
        consAppendDownloadDiagnostic(draft, "DG_PENDING", 0);
      }
      return draft;
    });
  }
  await cleanupResources(job, true);
  const stoppedJob = await mutateJob((draft) => {
    if (draft.current?.itemIndex >= 0) {
      consMarkItemFinished(draft, draft.current.itemIndex, "stopped", {
        error: "Остановлено пользователем",
      });
    }
    draft.cancelGuard = cancelGuard;
    if (stopWarning) consAppendJobLog(draft, stopWarning);
    consAppendJobLog(draft, "Остановлено пользователем");
    return consFinishJob(draft, "stopped");
  });
  await recordCompletedJobHistoryBestEffort(stoppedJob);
  await clearResumeAlarmBestEffort();
  await closeOffscreenDocument();
}

async function runStoredJob() {
  let job = await readJob();
  if (!consIsJobActive(job)) {
    await clearResumeAlarmBestEffort();
    return;
  }

  while (job && consIsJobActive(job)) {
    if (job.stopRequested || job.status === "stopping") {
      await stopCurrentWork(job);
      return;
    }

    if (job.nextIndex >= job.items.length) {
      if (job.reportEnabled) {
        try {
          const report = await saveJobReport(job);
          await mutateJob((draft) => {
            draft.report = { ...report, status: "completed" };
            consAppendJobLog(draft, `Отчёт: ${report.filename}`);
            return draft;
          });
        } catch (error) {
          const latest = await readJob();
          if (latest?.stopRequested || latest?.status === "stopping") {
            await stopCurrentWork(latest);
            return;
          }
          await mutateJob((draft) => {
            draft.report = { status: "failed", error: errorText(error) };
            consAppendJobLog(draft, `ERR отчёт: ${errorText(error)}`);
            return draft;
          });
        }
      }
      const latest = await readJob();
      if (latest?.stopRequested || latest?.status === "stopping") {
        await stopCurrentWork(latest);
        return;
      }
      const finishedJob = await mutateJob((draft) => {
        const progress = consJobProgress(draft);
        const unconfirmed = progress.unconfirmed
          ? `; требует проверки: ${progress.unconfirmed}`
          : "";
        consAppendJobLog(
          draft,
          `Готово: ${progress.completed}/${progress.total}${unconfirmed}`
        );
        return consFinishJob(draft, "done");
      });
      await recordCompletedJobHistoryBestEffort(finishedJob);
      await clearResumeAlarmBestEffort();
      await closeOffscreenDocument();
      return;
    }

    const itemIndex = job.nextIndex;
    try {
      const result = await processExportItem(job, itemIndex);
      await mutateJob((draft) => {
        consMarkItemFinished(draft, itemIndex, "completed", result);
        consAppendJobLog(draft, `OK [${itemIndex + 1}] ${draft.items[itemIndex].title.slice(0, 70)}`);
        return draft;
      });
      if (result.native && itemIndex + 1 < job.items.length) {
        await waitForActiveJobDelay(job.id, NATIVE_INTER_ITEM_DELAY_MS);
      }
    } catch (caughtError) {
      let error = caughtError;
      let latest = await readJob();
      if (latest?.stopRequested || latest?.status === "stopping") {
        await stopCurrentWork(latest);
        return;
      }

      const nativeStartTimedOut = isRetryableNativeStartTimeout(
        error,
        latest,
        itemIndex
      );
      await cleanupResources(latest);

      if (nativeStartTimedOut) {
        let recovered = null;
        try {
          recovered = await recoverTimedOutNativeDownload(
            latest,
            NATIVE_LATE_RECOVERY_GRACE_MS
          );
        } catch (recoveryError) {
          error = recoveryError;
        }

        latest = await readJob();
        if (latest?.stopRequested || latest?.status === "stopping") {
          await stopCurrentWork(latest);
          return;
        }

        if (recovered) {
          await mutateJob((draft) => {
            consMarkItemFinished(draft, itemIndex, "completed", recovered);
            consAppendJobLog(
              draft,
              `OK [${itemIndex + 1}] запоздавшая загрузка подтверждена`
            );
            return draft;
          });
          if (itemIndex + 1 < job.items.length) {
            await waitForActiveJobDelay(job.id, NATIVE_INTER_ITEM_DELAY_MS);
          }
          job = await readJob();
          continue;
        }

        const attempts = Number(latest?.items?.[itemIndex]?.attempts || 0);
        if (
          attempts < NATIVE_DOWNLOAD_MAX_ATTEMPTS &&
          isRetryableNativeStartTimeout(error, latest, itemIndex)
        ) {
          const retryState = await mutateJob((draft) => {
            if (
              draft.id !== job.id ||
              !consIsJobActive(draft) ||
              draft.stopRequested ||
              draft.status === "stopping" ||
              !isRetryableNativeStartTimeout(error, draft, itemIndex) ||
              Number(draft.items?.[itemIndex]?.attempts || 0) >=
                NATIVE_DOWNLOAD_MAX_ATTEMPTS
            ) {
              return draft;
            }
            const nextAttempt = Number(draft.items[itemIndex].attempts || 0) + 1;
            draft.items[itemIndex].status = "queued";
            draft.items[itemIndex].error = null;
            draft.phase = "native_retry_wait";
            draft.current = null;
            consAppendDownloadDiagnostic(draft, "NM_RETRY");
            consAppendJobLog(
              draft,
              `Повтор [${itemIndex + 1}]: попытка ${nextAttempt}/${NATIVE_DOWNLOAD_MAX_ATTEMPTS}`
            );
            return draft;
          });
          if (retryState?.id === job.id && consIsJobActive(retryState)) {
            job = retryState;
            continue;
          }
          latest = retryState || latest;
        }
      }

      await cleanupResources(latest);
      await mutateJob((draft) => {
        const status = isUnconfirmedDownloadError(error) ? "unconfirmed" : "failed";
        const attempts = Number(draft.items?.[itemIndex]?.attempts || 0);
        const retryExhausted =
          attempts >= NATIVE_DOWNLOAD_MAX_ATTEMPTS &&
          isRetryableNativeStartTimeout(error, draft, itemIndex);
        const message = retryExhausted
          ? `После ${NATIVE_DOWNLOAD_MAX_ATTEMPTS} попыток расширение не подтвердило начало загрузки; файл мог сохраниться в «Загрузки»`
          : errorText(error);
        consMarkItemFinished(draft, itemIndex, status, { error: message });
        const prefix = status === "unconfirmed" ? "ПРОВЕРИТЬ" : "ERR";
        consAppendJobLog(draft, `${prefix} [${itemIndex + 1}] ${message}`);
        return draft;
      });
    }
    job = await readJob();
  }
}

function ensureExportRunner() {
  if (runnerPromise) return runnerPromise;
  runnerPromise = runStoredJob()
    .catch(async (error) => {
      try {
        const failedJob = await mutateJob((job) => {
          job.lastError = errorText(error);
          consAppendJobLog(job, `FATAL ${errorText(error)}`);
          return consFinishJob(job, "failed");
        });
        await recordCompletedJobHistoryBestEffort(failedJob);
        await clearResumeAlarmBestEffort();
      } catch {
        // Nothing else can be persisted if storage itself failed.
      }
    })
    .finally(() => {
      runnerPromise = null;
      readJob()
        .then((job) => {
          if (consIsJobActive(job)) ensureExportRunner();
        })
        .catch(() => {});
    });
  return runnerPromise;
}

function inferAdapter(items, explicitAdapter) {
  if (CONS_ADAPTER_CAPABILITIES[explicitAdapter]) return explicitAdapter;
  const first = items?.[0]?.url;
  try {
    const url = new URL(first);
    if (
      (url.hostname === "consultant.ru" || url.hostname === "www.consultant.ru") &&
      url.pathname.startsWith("/document/")
    ) {
      return "public-site";
    }
  } catch {
    // Validation below will return a precise URL error.
  }
  return "online-app";
}

function normalizeItems(items, adapter, requestedLimit) {
  if (!Array.isArray(items) || !items.length) throw new Error("Список пуст");
  const parsedLimit = Number(requestedLimit);
  const limit = Number.isInteger(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, MAX_EXPORT_ITEMS)
    : MAX_EXPORT_ITEMS;
  return items.slice(0, limit).map((item, offset) => {
    const instance = consNormalizeJudicialInstances([item?.instance])[0] || null;
    const categoryLabel = String(item?.instanceLabel || "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    return {
      index: offset + 1,
      title: String(item?.title || `document-${offset + 1}`).slice(0, 500),
      url: consNormalizeDocumentUrl(item?.url, adapter),
      instance,
      instanceLabel:
        (instance && CONS_JUDICIAL_INSTANCE_LABELS[instance]) || categoryLabel || null,
    };
  });
}

function normalizedCollectionQuery(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 2000);
}

function normalizedCollectionCategory(value) {
  const category = consNormalizeJudicialInstances([value])[0];
  return category || "";
}

async function persistSearchCollection(options = {}) {
  const adapter = CONS_ADAPTER_CAPABILITIES[options.adapter]
    ? options.adapter
    : "online-app";
  const source = options.source === "search" ? "search" : "current-list";
  const items = Array.isArray(options.items) && options.items.length
    ? normalizeItems(options.items, adapter, MAX_EXPORT_ITEMS)
    : [];
  const total = Number(options.total);
  const collection = {
    version: 1,
    status: "ready",
    source,
    tabId: Number.isInteger(options.tabId) ? options.tabId : null,
    adapter,
    query: normalizedCollectionQuery(options.query),
    categoryKey: normalizedCollectionCategory(options.categoryKey),
    scope: String(options.scope || "current-list").slice(0, 200),
    items,
    total: Number.isInteger(total) && total >= items.length ? total : items.length,
    totalKnown: options.totalKnown === true,
    truncated: options.truncated === true,
    createdAt: new Date().toISOString(),
  };
  await chrome.storage.session.set({ [SEARCH_COLLECTION_STORAGE_KEY]: collection });
  return collection;
}

async function readSearchCollection() {
  const stored = await chrome.storage.session.get(SEARCH_COLLECTION_STORAGE_KEY);
  return stored[SEARCH_COLLECTION_STORAGE_KEY] || null;
}

function searchCollectionMatches(collection, request = {}) {
  if (!collection || collection.status !== "ready") return false;
  if (!Number.isInteger(request.tabId) || collection.tabId !== request.tabId) return false;
  if (request.adapter && collection.adapter !== request.adapter) return false;
  if (collection.query !== normalizedCollectionQuery(request.query)) return false;
  return collection.categoryKey === normalizedCollectionCategory(request.categoryKey);
}

async function startExportJob(options) {
  if (jobStartInProgress) throw new Error("Экспорт уже запускается");
  jobStartInProgress = true;
  try {
    let current = await readJob();
    if (consIsJobActive(current)) throw new Error("Экспорт уже выполняется");
    if (Number(current?.cancelGuard?.expiresAt || 0) > Date.now()) {
      throw new Error("Дождитесь завершения отмены предыдущей загрузки");
    }
    if (runnerPromise) await runnerPromise;
    current = await readJob();
    if (consIsJobActive(current)) throw new Error("Экспорт уже выполняется");
    if (Number(current?.cancelGuard?.expiresAt || 0) > Date.now()) {
      throw new Error("Дождитесь завершения отмены предыдущей загрузки");
    }

    let plan;
    let truncated = false;
    if (options.plan) {
      plan = consRebuildExportPlan(options.plan);
      if (!plan.ok) {
        const error = new Error(plan.errors[0]?.message || "Некорректный план выгрузки");
        error.code = plan.errors[0]?.code || "INVALID_EXPORT_PLAN";
        throw error;
      }
    } else {
      const adapter = inferAdapter(options.items, options.adapter);
      const format = consAssertFormatSupported(adapter, options.format || "docx");
      const normalizedItems = normalizeItems(options.items, adapter, options.maxItems);
      const profileState = await readProfileState();
      const selectedProfile = consGetSelectedProfile(profileState);
      const legacyProfile = consNormalizeProfile(
        {
          ...selectedProfile,
          format,
          folderTemplate: await getDownloadFolder(),
        },
        { builtIn: selectedProfile.id === CONS_DEFAULT_PROFILE_ID }
      );
      plan = consBuildExportPlan({
        adapter,
        query: options.query,
        collection: {
          source: "current-list",
          scope: options.scope,
          total: normalizedItems.length,
          totalKnown: true,
        },
        items: normalizedItems,
        profile: legacyProfile,
      });
      if (!plan.ok) throw new Error(plan.errors[0]?.message || "Не удалось построить план");
      truncated = normalizedItems.length < options.items.length;
    }

    const adapter = inferAdapter(
      plan.items.map((item) => ({ url: item.sourceUrl })),
      plan.adapter
    );
    const format = consAssertFormatSupported(adapter, plan.format);
    const items = plan.items.map((item) => ({
      ...item,
      sourceUrl: consNormalizeDocumentUrl(item.sourceUrl, adapter),
      url: consNormalizeDocumentUrl(item.sourceUrl, adapter),
    }));
    if (!items.length || items.length > MAX_EXPORT_ITEMS) {
      throw new Error("План должен содержать от 1 до 200 документов");
    }
    const historyMode = await readHistoryMode();
    const manifest = chrome.runtime.getManifest();
    const id = globalThis.crypto?.randomUUID?.() || `job-${Date.now()}`;
    const job = consCreateExportJob({
      id,
      adapter,
      format,
      items,
      folder: plan.reportRelativeFolder,
      reportRelativeFolder: plan.reportRelativeFolder,
      query: plan.query,
      scope: plan.collection?.scope || options.scope,
      profileSnapshot: plan.profileSnapshot,
      collection: plan.collection,
      selectedCount: plan.selectedCount,
      historyMode,
      extensionVersion: manifest.version_name || manifest.version,
      variant: globalThis.LEXPACK_VARIANT?.id || "unknown",
      reportQueryIncluded: historyMode === "detailed",
      reportEnabled: options.reportEnabled,
    });
    consAppendJobLog(job, `Старт: ${items.length} док. → .${format}`);
    if (truncated) {
      consAppendJobLog(job, `Применён лимит: ${items.length} из ${options.items.length}`);
    }
    await replaceJob(job);
    try {
      await setResumeAlarm(true);
    } catch (error) {
      await mutateJob((draft) => {
        if (draft.id !== job.id) return draft;
        draft.lastError = `Не удалось запланировать продолжение: ${errorText(error)}`;
        consAppendJobLog(draft, draft.lastError);
        return consFinishJob(draft, "failed");
      });
      throw error;
    }
    ensureExportRunner();
    return { job, truncated };
  } finally {
    jobStartInProgress = false;
  }
}

async function tabSupportsSearch(tab) {
  if (!tab?.id || !tab.url || !consIsConsultantPageUrl(tab.url)) return false;
  try {
    const ping = await sendToTab(tab.id, { type: "PING" });
    return Boolean(ping?.ok && ping.capabilities?.search && !ping.authRequired);
  } catch {
    return false;
  }
}

async function findSearchTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (await tabSupportsSearch(active)) return active;
  const tabs = await chrome.tabs.query({ url: ["https://online.consultant.ru/*"] });
  for (const tab of tabs) {
    if (await tabSupportsSearch(tab)) return tab;
  }
  return null;
}

function isOnlineFullResultsUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "https:" &&
      consIsConsultantHost(url.hostname) &&
      !["consultant.ru", "www.consultant.ru", "login.consultant.ru"].includes(
        url.hostname
      ) &&
      !url.username &&
      !url.password &&
      url.searchParams.get("req") === "query"
    );
  } catch {
    return false;
  }
}

function isExpectedFullResultsUrl(rawUrl, expectedUrl) {
  try {
    const actual = new URL(rawUrl);
    const expected = new URL(expectedUrl);
    actual.hash = "";
    expected.hash = "";
    return (
      isOnlineFullResultsUrl(actual.href) &&
      actual.origin === expected.origin &&
      actual.pathname === expected.pathname &&
      actual.search === expected.search
    );
  } catch {
    return false;
  }
}

function observeOpenedFullResultsTab(openerTab, expectedUrl) {
  let settled = false;
  let timeoutId = null;
  const candidates = new Set([openerTab.id]);
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const cleanup = () => {
    if (timeoutId != null) clearTimeout(timeoutId);
    chrome.tabs.onCreated.removeListener(onCreated);
    chrome.tabs.onUpdated.removeListener(onUpdated);
  };
  const finish = (tab) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolvePromise(tab);
  };
  const fail = () => {
    if (settled) return;
    settled = true;
    cleanup();
    const error = new Error("Не открылась вкладка «Все результаты поиска»");
    error.code = "FULL_RESULTS_TAB_TIMEOUT";
    rejectPromise(error);
  };
  const onCreated = (tab) => {
    if (tab.windowId !== openerTab.windowId) return;
    candidates.add(tab.id);
    if (isExpectedFullResultsUrl(tab.pendingUrl || tab.url, expectedUrl)) finish(tab);
  };
  const onUpdated = (tabId, changeInfo, tab) => {
    if (!candidates.has(tabId)) return;
    if (isExpectedFullResultsUrl(changeInfo.url || tab.url, expectedUrl)) finish(tab);
  };

  chrome.tabs.onCreated.addListener(onCreated);
  chrome.tabs.onUpdated.addListener(onUpdated);
  timeoutId = setTimeout(fail, TAB_TIMEOUT_MS);
  return {
    promise,
    dispose() {
      if (settled) return;
      settled = true;
      cleanup();
    },
  };
}

async function waitFullResultsState(tabId, query, category = "", transition = null) {
  const deadline = Date.now() + TAB_TIMEOUT_MS;
  let stableKey = "";
  let stableSince = 0;
  let sawLoading = false;
  let lastError = "Полная выдача ещё не готова";
  while (Date.now() < deadline) {
    try {
      const response = await sendToTab(tabId, {
        type: "GET_FULL_RESULTS_STATE",
        query,
        category,
      });
      if (response?.code === "AUTH_REQUIRED") {
        const error = new Error("Сессия завершилась; войдите повторно");
        error.code = "AUTH_REQUIRED";
        throw error;
      }
      if (!response?.ok) {
        lastError = response?.error || lastError;
      } else {
        const state = response.state;
        if (state?.loading === true) sawLoading = true;
        const transitioned =
          !transition?.triggered ||
          sawLoading ||
          state?.emptyResults === true ||
          state?.resultSignature !== transition.beforeSignature ||
          Number(state?.resultsRevision || 0) > Number(transition.beforeRevision || 0);
        const ready =
          state?.fullResults === true &&
          state.queryMatches === true &&
          state.queryAuthoritative === true &&
          state.resultsReady === true &&
          state.loading !== true &&
          (!category || state.activeCategory === category) &&
          transitioned;
        if (ready) {
          const key = [
            state.activeCategory || "",
            state.categoryTotal ?? "",
            state.resultSignature || "",
            Number(state.resultsRevision || 0),
          ].join(":");
          if (key !== stableKey) {
            stableKey = key;
            stableSince = Date.now();
          }
          if (Date.now() - stableSince >= 800) return state;
        } else {
          stableKey = "";
          stableSince = 0;
        }
      }
    } catch (error) {
      if (error?.code === "AUTH_REQUIRED") throw error;
      lastError = errorText(error);
      stableKey = "";
      stableSince = 0;
    }
    await delay(300);
  }
  const error = new Error(lastError);
  error.code = "FULL_RESULTS_TIMEOUT";
  throw error;
}

async function openOnlineFullResultsTab(tab, query) {
  if (isOnlineFullResultsUrl(tab.url)) {
    await waitFullResultsState(tab.id, query);
    return await chrome.tabs.get(tab.id);
  }

  const prepared = await sendToTab(tab.id, {
    type: "OPEN_FULL_RESULTS",
    activate: false,
  });
  if (!prepared?.ok) {
    const error = new Error(prepared?.error || "Не удалось открыть полную выдачу");
    error.code = prepared?.code || "FULL_RESULTS_OPEN_FAILED";
    throw error;
  }
  if (prepared.alreadyOpen) {
    await waitFullResultsState(tab.id, query);
    return await chrome.tabs.get(tab.id);
  }
  if (!isOnlineFullResultsUrl(prepared.fullResultsUrl)) {
    const error = new Error("Получен неожиданный адрес полной выдачи");
    error.code = "FULL_RESULTS_INVALID_URL";
    throw error;
  }
  const opened = observeOpenedFullResultsTab(tab, prepared.fullResultsUrl);
  try {
    const activated = await sendToTab(tab.id, {
      type: "OPEN_FULL_RESULTS",
      activate: true,
    });
    if (
      !activated?.ok ||
      !activated.triggered ||
      !isExpectedFullResultsUrl(activated.fullResultsUrl, prepared.fullResultsUrl)
    ) {
      const error = new Error(
        activated?.error || "Не удалось перейти к полной выдаче"
      );
      error.code = activated?.code || "FULL_RESULTS_OPEN_FAILED";
      throw error;
    }
    const fullTab = await opened.promise;
    await waitTabComplete(fullTab.id, TAB_TIMEOUT_MS);
    const ping = await waitContentReady(fullTab.id);
    if (ping.authRequired || ping.adapter !== "online-app") {
      const error = new Error("Полная выдача КонсультантПлюс недоступна");
      error.code = ping.authRequired ? "AUTH_REQUIRED" : "ADAPTER_CHANGED";
      throw error;
    }
    await waitFullResultsState(fullTab.id, query);
    return await chrome.tabs.get(fullTab.id);
  } catch (error) {
    opened.dispose();
    throw error;
  }
}

function searchItemIdentity(item) {
  try {
    const url = new URL(item?.url);
    const base = url.searchParams.get("base") || "";
    const strongId =
      url.searchParams.get("n") ||
      url.searchParams.get("doc") ||
      url.searchParams.get("id") ||
      "";
    return base && strongId
      ? `${url.hostname}:${base}:${strongId}`
      : consRedactUrl(url.href);
  } catch {
    return String(item?.url || "");
  }
}

async function collectJudicialInstances(tab, query, requestedInstances) {
  const instances = consNormalizeJudicialInstances(requestedInstances);
  if (!instances.length) throw new Error("Выберите хотя бы одну судебную инстанцию");
  const maxItems = MAX_EXPORT_ITEMS;
  const collected = new Map();
  const breakdown = [];
  const unavailableInstances = [];
  let truncated = false;

  for (const instance of instances) {
    if (collected.size >= maxItems) {
      truncated = true;
      break;
    }
    const selected = await sendToTab(tab.id, {
      type: "SELECT_JUDICIAL_CATEGORY",
      category: instance,
    });
    if (!selected?.ok) {
      if (["INSTANCE_NOT_FOUND", "UNSUPPORTED_INSTANCE"].includes(selected?.code)) {
        unavailableInstances.push(instance);
        continue;
      }
      const error = new Error(selected?.error || "Не удалось выбрать судебную инстанцию");
      error.code = selected?.code || "INSTANCE_SELECT_FAILED";
      throw error;
    }
    const state = await waitFullResultsState(tab.id, query, instance, selected);
    const response = await sendToTab(tab.id, {
      type: "COLLECT_LIST",
      allResults: true,
      maxItems,
      query,
      category: instance,
      prevalidated: true,
    });
    if (!response?.ok) {
      const error = new Error(response?.error || "Не удалось собрать выбранную категорию");
      error.code = response?.code || "COLLECT_LIST_FAILED";
      throw error;
    }
    if (response.query !== query || response.category?.key !== instance) {
      const error = new Error("Страница переключилась на другую поисковую выдачу");
      error.code = "FULL_RESULTS_STATE_MISMATCH";
      throw error;
    }
    if (response.incomplete) {
      const error = new Error(
        "Не удалось дочитать выбранную категорию до ожидаемого количества"
      );
      error.code = "COLLECTION_INCOMPLETE";
      throw error;
    }
    const availableNewKeys = new Set();
    for (const item of response.items || []) {
      const key = searchItemIdentity(item);
      if (key && !collected.has(key)) availableNewKeys.add(key);
    }
    let added = 0;
    for (const item of response.items || []) {
      const key = searchItemIdentity(item);
      if (!key || collected.has(key)) continue;
      collected.set(key, {
        ...item,
        instance,
        instanceLabel:
          response.category?.label || CONS_JUDICIAL_INSTANCE_LABELS[instance] || instance,
      });
      added += 1;
      if (collected.size >= maxItems) break;
    }
    if (added < availableNewKeys.size) truncated = true;
    breakdown.push({
      instance,
      label: response.category?.label || CONS_JUDICIAL_INSTANCE_LABELS[instance] || instance,
      total: Number.isInteger(response.categoryTotal)
        ? response.categoryTotal
        : Number.isInteger(state.categoryTotal)
          ? state.categoryTotal
          : response.count,
      collected: added,
    });
    if (response.truncated) truncated = true;
  }

  if (!collected.size && unavailableInstances.length === instances.length) {
    throw new Error("Выбранные судебные инстанции отсутствуют в этой выдаче");
  }
  const items = [...collected.values()].map((item, index) => ({
    ...item,
    index: index + 1,
  }));
  return { items, instances, breakdown, unavailableInstances, truncated };
}

async function executeSearchFlow(message) {
  const query = String(message.query || "").replace(/\s+/g, " ").trim();
  if (!query) throw new Error("Введите запрос");
  if (query.length > 2000) throw new Error("Запрос не должен превышать 2000 символов");

  let tab = await findSearchTab();
  if (!tab) {
    tab = await chrome.tabs.create({
      url: "https://online.consultant.ru/riv/cgi/online.cgi?req=home",
      active: true,
    });
    await waitTabComplete(tab.id, TAB_TIMEOUT_MS);
  }
  const ping = await waitContentReady(tab.id);
  if (ping.authRequired || ping.page === "auth-required") {
    const error = new Error("Сначала войдите в онлайн-КонсультантПлюс");
    error.code = "AUTH_REQUIRED";
    throw error;
  }

  const scope = String(
    message.scope || (ping.adapter === "public-site" ? "all" : "practice")
  );
  const searchFlow = consCreateSearchFlow({
    sendToTab,
    navigate: (tab, searchUrl) => chrome.tabs.update(tab.id, { url: searchUrl }),
    observeTabLoadCycle,
    buildOnlineSearchUrl: consBuildOnlineSearchUrl,
    buildPublicSearchUrl: consBuildPublicSearchUrl,
    delay,
    timeoutMs: CONTENT_TIMEOUT_MS,
  });
  let result;
  if (ping.adapter === "online-app") {
    let fullTab = null;
    if (isOnlineFullResultsUrl(tab.url)) {
      try {
        const current = await sendToTab(tab.id, {
          type: "GET_FULL_RESULTS_STATE",
          query,
        });
        if (
          current?.ok &&
          current.state?.queryMatches === true &&
          current.state?.queryAuthoritative === true
        ) {
          await waitFullResultsState(tab.id, query);
          fullTab = tab;
        }
      } catch (error) {
        if (error?.code === "AUTH_REQUIRED") throw error;
      }
    }
    if (!fullTab) {
      await searchFlow.run({ tab, adapter: ping.adapter, query, scope });
      tab = await chrome.tabs.get(tab.id);
      fullTab = await openOnlineFullResultsTab(tab, query);
    }
    const collected = await collectJudicialInstances(
      fullTab,
      query,
      message.instances || ["higher-courts", "arbitration-circuit"]
    );
    result = {
      adapter: "online-app",
      query,
      scope,
      scopeApplied: true,
      fullResults: true,
      fullResultsTabId: fullTab.id,
      ...collected,
      count: collected.items.length,
      emptyResults: collected.items.length === 0,
    };
  } else {
    result = await searchFlow.run({ tab, adapter: ping.adapter, query, scope });
  }

  const count = result.items?.length || 0;
  const categoryKey = result.breakdown?.at(-1)?.instance || "";
  await persistSearchCollection({
    source: "search",
    tabId: result.fullResultsTabId || tab.id,
    adapter: result.adapter,
    query,
    categoryKey,
    scope,
    items: result.items || [],
    total: count,
    totalKnown: result.adapter === "online-app" && result.truncated !== true,
    truncated: result.truncated === true,
  });
  return { ...result, count };
}

async function runSearchFlow(message) {
  if (searchFlowInProgress) throw new Error("Поиск уже выполняется");
  searchFlowInProgress = true;
  try {
    return await executeSearchFlow(message);
  } finally {
    searchFlowInProgress = false;
  }
}

async function startCurrentExport(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) throw new Error("Нет активного документа");
  const ping = await sendToTab(tab.id, { type: "PING" });
  if (!ping?.ok || ping.page !== "document") {
    throw new Error(ping?.error || "Откройте документ КонсультантПлюс");
  }
  return startExportJob({
    adapter: ping.adapter,
    format: message.format,
    maxItems: 1,
    reportEnabled: false,
    items: [{ index: 1, title: ping.documentTitle || tab.title || "document", url: tab.url }],
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RESUME_ALARM) return;
  readJob()
    .then((job) =>
      consIsJobActive(job) ? ensureExportRunner() : clearResumeAlarmBestEffort()
    )
    .catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureExportRunner();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") return false;

  const run = async () => {
    if (sender.id && sender.id !== chrome.runtime.id) {
      return { ok: false, error: "Недоверенный отправитель" };
    }

    switch (message.type) {
      case "GET_PROGRESS": {
        const job = await readJob();
        return { ok: true, progress: consJobProgress(job), running: consIsJobActive(job) };
      }

      case "GET_DOWNLOAD_DIAGNOSTICS": {
        const job = await readJob();
        return { ok: true, diagnostics: consSafeDownloadDiagnostics(job) };
      }

      case "STOP_EXPORT": {
        const job = await readJob();
        if (!consIsJobActive(job)) return { ok: true, stopped: false };
        const updated = await mutateJob((draft) => {
          if (draft.id !== job.id || !consIsJobActive(draft)) return draft;
          draft.stopRequested = true;
          draft.status = "stopping";
          draft.cancelGuard = createCancelGuard(draft.current);
          if (draft.cancelGuard) {
            consAppendDownloadDiagnostic(draft, "DG_ARMED");
          }
          consAppendJobLog(draft, "Запрос остановки…");
          return draft;
        });
        if (updated?.id !== job.id || updated?.status !== "stopping") {
          return { ok: true, stopped: false };
        }
        ensureExportRunner();
        return { ok: true, stopped: true };
      }

      case "START_PUBLIC_EXPORT":
      case "START_TAB_EXPORT": {
        const started = await startExportJob({
          adapter: message.type === "START_PUBLIC_EXPORT" ? "public-site" : message.adapter,
          items: message.items,
          format: message.format,
          maxItems: message.maxItems,
          query: message.query,
          scope: message.scope,
        });
        return {
          ok: true,
          started: true,
          total: started.job.items.length,
          jobId: started.job.id,
          truncated: started.truncated,
        };
      }

      case "START_PLANNED_EXPORT": {
        const started = await startExportJob({ plan: message.plan });
        return {
          ok: true,
          started: true,
          total: started.job.items.length,
          jobId: started.job.id,
          truncated: false,
        };
      }

      case "START_CURRENT_EXPORT": {
        const started = await startCurrentExport(message);
        return { ok: true, started: true, total: 1, jobId: started.job.id };
      }

      case "SAVE_EXTRACTED": {
        if (consIsJobActive(await readJob())) {
          return { ok: false, error: "Прямое сохранение недоступно во время массового экспорта" };
        }
        if (!message.doc || message.doc.nativeSaveTriggered) {
          return { ok: false, error: "Используйте START_CURRENT_EXPORT для нативного формата" };
        }
        const format = ["html", "txt"].includes(message.format) ? message.format : null;
        if (!format) return { ok: false, error: "Неподдерживаемый прямой формат" };
        const filename = consSafeFilename(message.doc.title, message.index, format);
        const { body, mime } = await buildExportBody(message.doc, format, message.doc.url);
        let download = null;
        try {
          download = await downloadGeneratedFile(
            await getDownloadFolder(),
            filename,
            body,
            mime
          );
          await waitForDownloadCompletion(
            "standalone",
            download.downloadId,
            DIRECT_DOWNLOAD_TIMEOUT_MS,
            false
          );
          return { ok: true, filename, downloadId: download.downloadId };
        } finally {
          await revokeBlobUrl(download?.blobUrl);
          await closeOffscreenDocument();
        }
      }

      case "FORWARD_TO_ACTIVE_TAB": {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return { ok: false, error: "Нет активной вкладки" };
        return sendToTab(tab.id, message.payload);
      }

      case "RUN_SEARCH_FLOW": {
        const result = await runSearchFlow(message);
        return { ok: true, ...result };
      }

      case "GET_SEARCH_COLLECTION": {
        const collection = await readSearchCollection();
        return {
          ok: true,
          cache: searchCollectionMatches(collection, message) ? collection : null,
        };
      }

      case "GET_PLANNER_CONTEXT": {
        const [collection, profileState, historyMode, history, job] = await Promise.all([
          readSearchCollection(),
          readProfileState(),
          readHistoryMode(),
          readHistoryState(),
          readJob(),
        ]);
        return {
          ok: true,
          collection: collection?.status === "ready" ? collection : null,
          profileState,
          historyMode,
          history,
          progress: consJobProgress(job),
          running: consIsJobActive(job),
        };
      }

      case "CACHE_SEARCH_COLLECTION": {
        const tab = Number.isInteger(message.tabId)
          ? await chrome.tabs.get(message.tabId)
          : null;
        if (!tab?.url || !consIsConsultantPageUrl(tab.url)) {
          return { ok: false, error: "Нельзя сохранить список с неподдерживаемой вкладки" };
        }
        const ping = await sendToTab(tab.id, { type: "PING" });
        const expectedQuery = normalizedCollectionQuery(message.query);
        const expectedCategory = normalizedCollectionCategory(message.categoryKey);
        if (
          !ping?.ok ||
          ping.page !== "list" ||
          ping.adapter !== message.adapter ||
          normalizedCollectionQuery(ping.query) !== expectedQuery ||
          normalizedCollectionCategory(ping.category?.key) !== expectedCategory
        ) {
          return { ok: false, error: "Страница уже показывает другую выдачу" };
        }
        const collection = await persistSearchCollection(message);
        return { ok: true, cache: collection };
      }

      case "GET_SETTINGS":
        return {
          ok: true,
          downloadFolder: await getDownloadFolder(),
          profileState: await readProfileState(),
          historyMode: await readHistoryMode(),
        };

      case "PUT_EXPORT_PROFILE": {
        const state = await readProfileState();
        const next = consUpsertProfileState(state, message.profile);
        await persistProfileState(next);
        const saved = next.profiles.find((profile) => profile.id === next.selectedProfileId);
        if (saved?.id === CONS_DEFAULT_PROFILE_ID) {
          await chrome.storage.local.set({
            lastFormat: saved.format,
            downloadFolder: consSanitizeFolder(saved.folderTemplate),
          });
        }
        return { ok: true, profileState: next };
      }

      case "SELECT_EXPORT_PROFILE": {
        const next = consSelectProfileState(await readProfileState(), message.profileId);
        await persistProfileState(next);
        return { ok: true, profileState: next };
      }

      case "DELETE_EXPORT_PROFILE": {
        const next = consDeleteProfileState(await readProfileState(), message.profileId);
        await persistProfileState(next);
        return { ok: true, profileState: next };
      }

      case "UPDATE_DEFAULT_PROFILE_SETTINGS": {
        const state = await readProfileState();
        const currentSelection = state.selectedProfileId;
        const builtIn = state.profiles.find((profile) => profile.id === CONS_DEFAULT_PROFILE_ID);
        const next = consUpsertProfileState(state, {
          ...builtIn,
          format: message.format || builtIn.format,
          folderTemplate: consSanitizeFolder(message.folderTemplate || builtIn.folderTemplate),
        });
        next.selectedProfileId = currentSelection;
        await persistProfileState(next);
        return { ok: true, profileState: next };
      }

      case "SET_HISTORY_MODE": {
        const mode = consNormalizeHistoryMode(message.mode);
        await chrome.storage.local.set({ [CONS_HISTORY_MODE_KEY]: mode });
        return { ok: true, mode };
      }

      case "DELETE_HISTORY_RECORD": {
        const next = consDeleteHistoryRecord(await readHistoryState(), message.id);
        await persistHistoryState(next);
        return { ok: true, history: next };
      }

      case "CLEAR_HISTORY": {
        const next = { schemaVersion: CONS_HISTORY_SCHEMA_VERSION, records: [] };
        await persistHistoryState(next);
        return { ok: true, history: next };
      }

      case "CLEAR_LOCAL_DATA":
        {
          const job = await readJob();
          if (consIsJobActive(job)) {
            return { ok: false, error: "Сначала остановите текущий экспорт" };
          }
          if (Number(job?.cancelGuard?.expiresAt || 0) > Date.now()) {
            return { ok: false, error: "Дождитесь завершения отмены предыдущей загрузки" };
          }
        }
        await chrome.storage.local.remove([
          "lastQuery",
          "lastScope",
          "lastFormat",
          "downloadFolder",
          "rememberQuery",
          "maxItems",
          "lastInstances",
          "settingsSchemaVersion",
          CONS_PROFILE_STATE_KEY,
          CONS_HISTORY_MODE_KEY,
          CONS_HISTORY_STORAGE_KEY,
        ]);
        await chrome.storage.session.remove([
          JOB_STORAGE_KEY,
          PROGRESS_STORAGE_KEY,
          SEARCH_COLLECTION_STORAGE_KEY,
        ]);
        return { ok: true };

      default:
        return { ok: false, error: `Unknown: ${message.type}` };
    }
  };

  run()
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, code: error.code, error: errorText(error) }));
  return true;
});

readJob()
  .then(async (job) => {
    if (consIsJobActive(job)) {
      try {
        await setResumeAlarm(true);
      } catch {
        // The immediate runner still proceeds; a later startup can retry the alarm.
      }
      ensureExportRunner();
    } else {
      await recordCompletedJobHistoryBestEffort(job);
      await clearResumeAlarmBestEffort();
    }
  })
  .catch(() => {});
