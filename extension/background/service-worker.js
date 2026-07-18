/** Background orchestration for search, durable export jobs, and downloads. */

importScripts("../shared/filename.js");
importScripts("../shared/runtime.js");
importScripts("export-job.js");

const JOB_STORAGE_KEY = "exportJob";
const PROGRESS_STORAGE_KEY = "exportProgress";
const RESUME_ALARM = "cons-export-resume";
const OFFSCREEN_PATH = "offscreen/sanitizer.html";
const MAX_EXPORT_ITEMS = 200;
const TAB_TIMEOUT_MS = 45000;
const CONTENT_TIMEOUT_MS = 12000;
const DIRECT_DOWNLOAD_TIMEOUT_MS = 90000;
const NATIVE_DOWNLOAD_START_TIMEOUT_MS = 35000;
const NATIVE_DOWNLOAD_TIMEOUT_MS = 60000;
const POLL_MS = 400;
const CONTENT_SCRIPT_FILES = [
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error) {
  return String(error?.message || error || "Неизвестная ошибка");
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

async function getDownloadFolder() {
  const { downloadFolder } = await chrome.storage.local.get("downloadFolder");
  return consSanitizeFolder(downloadFolder || "ConsExport");
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
  const url = await createBlobUrl(content, mime);
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename: `${consSanitizeFolder(folder)}/${filename}`,
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
  return {
    filename: `${consSanitizeFolder(job.folder)}/${job.current.expectedFilename}`,
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
      if (draft.id === job.id) draft.cancelGuard = null;
      return draft;
    });
    return false;
  }
  if (!matchesCurrentDownload(downloadItem, guard)) return false;

  let cancellationError = null;
  try {
    if (downloadItem.state === "in_progress") {
      await chrome.downloads.cancel(downloadItem.id);
    } else {
      cancellationError = `Отложенная загрузка ${downloadItem.id} уже не выполняется`;
    }
  } catch (error) {
    cancellationError = `Не удалось отменить отложенную загрузку ${downloadItem.id}: ${errorText(error)}`;
  }
  await mutateJob((draft) => {
    if (draft.id === job.id) {
      consAppendJobLog(
        draft,
        cancellationError || `Отложенная загрузка ${downloadItem.id} отменена`
      );
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
  if (!matchesCurrentDownload(downloadItem, job.current)) return;

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
    throw new Error("Найдено несколько подходящих загрузок; сопоставление неоднозначно");
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

    const recovered = job.current && (await findRecentDownload(job.current));
    if (recovered) {
      await mutateJob((draft) => {
        if (draft.id === jobId && draft.current) {
          draft.current.downloadId = recovered.id;
          draft.phase = "waiting_download";
        }
        return draft;
      });
      return recovered.id;
    }
    await delay(POLL_MS);
  }
  throw new Error("Загрузка не началась за отведённое время");
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
  throw new Error("Превышено время ожидания завершения загрузки");
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
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!isMissingContentReceiver(error)) throw error;
    await ensureContentScripts(tabId);
    return chrome.tabs.sendMessage(tabId, message);
  }
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

async function waitSearchResultsReady(tabId) {
  const deadline = Date.now() + CONTENT_TIMEOUT_MS;
  let lastError = "Поисковая выдача ещё не готова";
  while (Date.now() < deadline) {
    try {
      const ping = await sendToTab(tabId, { type: "PING" });
      if (!ping?.ok) {
        lastError = ping?.error || lastError;
      } else if (ping.authRequired || ping.page === "auth-required") {
        const error = new Error("Сначала войдите в онлайн-КонсультантПлюс");
        error.code = "AUTH_REQUIRED";
        throw error;
      } else if (ping.capabilities?.resultsReady) {
        return ping;
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
  };
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
  const expectedFilename = consSafeFilename(item.title, itemIndex + 1, job.format);

  const tab = await chrome.tabs.create({ url, active: false });
  await updateCurrent(job.id, { tabId: tab.id }, "loading_tab");

  try {
    await waitTabComplete(tab.id, TAB_TIMEOUT_MS, null, job.id);
    await waitDocumentReady(tab.id, job.format, job.id);
    await assertJobCanContinue(job.id);

    if (isNative) {
      const startedAt = Date.now();
      await updateCurrent(
        job.id,
        {
          downloadKind: "native",
          downloadStartedAt: startedAt,
          expectedFilename,
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
      return { downloadId, filename: downloadBasename(completed, expectedFilename) };
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
      },
      "starting_download"
    );
    await assertJobCanContinue(job.id);
    const download = await downloadGeneratedFile(job.folder, expectedFilename, body, mime);
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
  return `ConsExport-report-${stamp}.json`;
}

function serializeJobReport(job) {
  const progress = consJobProgress(job);
  return JSON.stringify(
    {
      schemaVersion: 1,
      jobId: job.id,
      query: job.query,
      scope: job.scope,
      adapter: job.adapter,
      format: job.format,
      startedAt: job.startedAt,
      generatedAt: new Date().toISOString(),
      summary: {
        status: progress.failed ? "completed_with_errors" : "completed",
        total: progress.total,
        processed: progress.current,
        completed: progress.completed,
        failed: progress.failed,
        stopped: progress.stopped,
      },
      items: job.items.map((item) => ({
        index: item.index,
        title: item.title,
        sourceUrl: consProvenanceUrl(item.url),
        status: item.status,
        filename: item.filename,
        error: item.error,
      })),
    },
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
    draft.current = {
      itemIndex: -1,
      tabId: null,
      downloadId: null,
      blobUrl: null,
      expectedFilename: filename,
      downloadKind: "report",
      downloadStartedAt: startedAt,
    };
    return draft;
  });
  await assertJobCanContinue(job.id);
  const download = await downloadGeneratedFile(
    job.folder,
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
  let cancelGuard = createCancelGuard(job.current);
  let stopWarning = null;
  if (cancelGuard) {
    await mutateJob((draft) => {
      if (draft.id === job.id) draft.cancelGuard = cancelGuard;
      return draft;
    });
    const deadline = Date.now() + 1500;
    let matches = [];
    try {
      while (!matches.length && Date.now() < deadline) {
        matches = await findRecentDownloads(job.current);
        if (!matches.length) await delay(150);
      }
      const cancellationErrors = [];
      for (const match of matches) {
        if (match.state !== "in_progress") continue;
        try {
          await chrome.downloads.cancel(match.id);
        } catch (error) {
          cancellationErrors.push(`${match.id}: ${errorText(error)}`);
        }
      }
      if (cancellationErrors.length) {
        stopWarning = `Не удалось отменить загрузки: ${cancellationErrors.join("; ")}`;
      }
    } catch (error) {
      stopWarning = errorText(error);
    }
    stopWarning ||= matches.length
      ? `Отменено связанных загрузок: ${matches.filter((item) => item.state === "in_progress").length}`
      : "Загрузка ещё не обнаружена; при позднем старте расширение попытается её отменить";
  }
  await cleanupResources(job, true);
  await mutateJob((draft) => {
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
      await mutateJob((draft) => {
        const progress = consJobProgress(draft);
        consAppendJobLog(draft, `Готово: ${progress.completed}/${progress.total}`);
        return consFinishJob(draft, "done");
      });
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
    } catch (error) {
      const latest = await readJob();
      if (latest?.stopRequested || latest?.status === "stopping") {
        await stopCurrentWork(latest);
        return;
      }
      await cleanupResources(latest);
      await mutateJob((draft) => {
        consMarkItemFinished(draft, itemIndex, "failed", { error: errorText(error) });
        consAppendJobLog(draft, `ERR [${itemIndex + 1}] ${errorText(error)}`);
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
        await mutateJob((job) => {
          job.lastError = errorText(error);
          consAppendJobLog(job, `FATAL ${errorText(error)}`);
          return consFinishJob(job, "failed");
        });
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
  return items.slice(0, limit).map((item, offset) => ({
    index: offset + 1,
    title: String(item?.title || `document-${offset + 1}`).slice(0, 500),
    url: consNormalizeDocumentUrl(item?.url, adapter),
  }));
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

    const adapter = inferAdapter(options.items, options.adapter);
    const format = consAssertFormatSupported(adapter, options.format || "docx");
    const items = normalizeItems(options.items, adapter, options.maxItems);
    const folder = await getDownloadFolder();
    const id = globalThis.crypto?.randomUUID?.() || `job-${Date.now()}`;
    const job = consCreateExportJob({
      id,
      adapter,
      format,
      items,
      folder,
      query: options.query,
      scope: options.scope,
      reportEnabled: options.reportEnabled,
    });
    consAppendJobLog(job, `Старт: ${items.length} док. → .${format}`);
    if (items.length < options.items.length) {
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
    return { job, truncated: items.length < options.items.length };
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

async function waitSearchReady(tabId, scope) {
  const deadline = Date.now() + CONTENT_TIMEOUT_MS;
  let lastError = "Поисковый интерфейс ещё не готов";
  while (Date.now() < deadline) {
    try {
      const ping = await sendToTab(tabId, { type: "PING" });
      if (!ping?.ok) {
        lastError = ping?.error || lastError;
      } else if (ping.authRequired || ping.page === "auth-required") {
        const error = new Error("Сначала войдите в онлайн-КонсультантПлюс");
        error.code = "AUTH_REQUIRED";
        throw error;
      } else if (
        ping.adapter !== "online-app" ||
        scope === "all" ||
        ping.capabilities?.searchReady
      ) {
        return ping;
      }
    } catch (error) {
      if (error?.code === "AUTH_REQUIRED") throw error;
      lastError = errorText(error);
    }
    await delay(300);
  }
  throw new Error(lastError);
}

async function executeSearchFlow(message) {
  const query = String(message.query || "").trim();
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
  await waitSearchReady(tab.id, message.scope || "practice");
  const beforeUrl = tab.url;
  let result = await sendToTab(tab.id, {
    type: "RUN_SEARCH",
    query,
    scope: message.scope || "practice",
  });

  if (result?.navigating) {
    await waitTabComplete(tab.id, TAB_TIMEOUT_MS, result.url || null);
    await waitSearchResultsReady(tab.id);
    result = await sendToTab(tab.id, { type: "COLLECT_LIST" });
    if (result?.ok) result = { ...result, query, scope: message.scope || "practice" };
  } else if (result?.ok && result.url && result.url !== beforeUrl) {
    await waitTabComplete(tab.id, TAB_TIMEOUT_MS);
  }

  if (!result?.ok) {
    const error = new Error(result?.error || "Поиск не удался");
    error.code = result?.code;
    throw error;
  }

  if (message.autoExport && result.items?.length) {
    const started = await startExportJob({
      adapter: result.adapter,
      items: result.items,
      format: message.format,
      maxItems: message.maxItems,
      query,
      scope: message.scope,
    });
    return {
      ...result,
      items: started.job.items,
      count: started.job.items.length,
      exportStarted: true,
      truncated: started.truncated,
      jobId: started.job.id,
    };
  }
  return { ...result, count: result.items?.length || 0 };
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
    items: [{ index: 1, title: tab.title || "document", url: tab.url }],
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

      case "STOP_EXPORT": {
        const job = await readJob();
        if (!consIsJobActive(job)) return { ok: true, stopped: false };
        const updated = await mutateJob((draft) => {
          if (draft.id !== job.id || !consIsJobActive(draft)) return draft;
          draft.stopRequested = true;
          draft.status = "stopping";
          draft.cancelGuard = createCancelGuard(draft.current);
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

      case "GET_SETTINGS":
        return { ok: true, downloadFolder: await getDownloadFolder() };

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
        ]);
        await chrome.storage.session.remove([JOB_STORAGE_KEY, PROGRESS_STORAGE_KEY]);
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
      await clearResumeAlarmBestEffort();
    }
  })
  .catch(() => {});
