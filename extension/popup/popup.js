const els = {
  pageMeta: document.getElementById("pageMeta"),
  adapterName: document.getElementById("adapterName"),
  pageType: document.getElementById("pageType"),
  listCount: document.getElementById("listCount"),
  format: document.getElementById("format"),
  downloadFolder: document.getElementById("downloadFolder"),
  folderPreview: document.getElementById("folderPreview"),
  btnOpenDownloadsSettings: document.getElementById("btnOpenDownloadsSettings"),
  query: document.getElementById("query"),
  scope: document.getElementById("scope"),
  instancesBlock: document.getElementById("instancesBlock"),
  instanceInputs: [...document.querySelectorAll("input[name='instance']")],
  maxItems: document.getElementById("maxItems"),
  rememberQuery: document.getElementById("rememberQuery"),
  btnFind: document.getElementById("btnFind"),
  btnFindSave: document.getElementById("btnFindSave"),
  btnScan: document.getElementById("btnScan"),
  btnExport: document.getElementById("btnExport"),
  btnOne: document.getElementById("btnOne"),
  btnStop: document.getElementById("btnStop"),
  btnProbe: document.getElementById("btnProbe"),
  btnClearData: document.getElementById("btnClearData"),
  progressText: document.getElementById("progressText"),
  log: document.getElementById("log"),
};

const STATUS_LABELS = {
  idle: "ожидание",
  running: "выполняется",
  stopping: "останавливается",
  done: "готово",
  stopped: "остановлено",
  failed: "ошибка",
};

let cachedItems = [];
let cachedQuery = "";
let cachedScope = "current-list";
let currentAdapter = "online-app";
let currentPage = "unsupported";
let currentCapabilities = consGetAdapterCapabilities(currentAdapter);
let exportRunning = false;
let actionPending = false;
let progressTimer = null;

async function sendMessage(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

function tabMessage(payload) {
  return sendMessage({ type: "FORWARD_TO_ACTIVE_TAB", payload });
}

function setLog(message) {
  els.log.textContent = String(message || "");
}

function maxItemsValue() {
  const value = Number.parseInt(els.maxItems.value, 10);
  return Number.isInteger(value) ? Math.min(200, Math.max(1, value)) : 50;
}

function selectedInstances() {
  return consNormalizeJudicialInstances(
    els.instanceInputs.filter((input) => input.checked).map((input) => input.value)
  );
}

function updateInstancesState() {
  const available = currentAdapter === "online-app";
  els.instancesBlock.hidden = !available;
  for (const input of els.instanceInputs) input.disabled = !available;
}

function updateActionState() {
  const formats = currentCapabilities.exportFormats || [];
  const formatSupported = formats.includes(els.format.value);
  els.btnExport.disabled =
    exportRunning || actionPending || !cachedItems.length || !formatSupported;
  els.btnOne.disabled =
    exportRunning || actionPending || currentPage !== "document" || !formatSupported;
  els.btnScan.disabled =
    exportRunning || actionPending || !["list", "search"].includes(currentPage);
  const instancesReady =
    currentAdapter !== "online-app" || selectedInstances().length > 0;
  els.btnFind.disabled =
    exportRunning || actionPending || currentPage === "auth-required" || !instancesReady;
  els.btnFindSave.disabled =
    exportRunning || actionPending || currentPage === "auth-required" || !instancesReady;
}

function applyCapabilities(adapter, page, pageCapabilities = {}) {
  currentAdapter = adapter || "online-app";
  currentPage = page || "unsupported";
  const shared = consGetAdapterCapabilities(currentAdapter);
  const scopes = pageCapabilities.searchScopes?.length
    ? pageCapabilities.searchScopes
    : shared.scopes;
  const exportFormats = pageCapabilities.exportFormats?.filter((format) =>
    CONS_FORMATS.includes(format)
  );
  currentCapabilities = {
    ...shared,
    search: pageCapabilities.search ?? shared.search,
    scopes,
    exportFormats: exportFormats?.length ? exportFormats : shared.exportFormats,
  };

  for (const option of els.scope.options) option.disabled = !scopes.includes(option.value);
  if (!scopes.includes(els.scope.value)) els.scope.value = scopes[0] || "all";
  updateInstancesState();

  for (const option of els.format.options) {
    option.disabled = !currentCapabilities.exportFormats.includes(option.value);
  }
  if (!currentCapabilities.exportFormats.includes(els.format.value)) {
    els.format.value = currentCapabilities.exportFormats[0] || "txt";
  }

  els.adapterName.textContent = currentAdapter;
  els.pageType.textContent = currentPage;
  updateActionState();
}

function renderProgress(progress, running) {
  if (!progress) return;
  exportRunning = Boolean(running);
  const {
    current = 0,
    total = 0,
    completed = 0,
    failed = 0,
    status = "idle",
    log = [],
  } = progress;
  const label = STATUS_LABELS[status] || status;
  els.progressText.textContent = status === "idle"
    ? label
    : `${label}: ${current}/${total || "?"}; успешно ${completed}, ошибок ${failed}`;
  if (log.length) els.log.textContent = log.join("\n");
  els.btnStop.hidden = !running;
  updateActionState();
}

async function refreshProgress() {
  const response = await sendMessage({ type: "GET_PROGRESS" });
  if (response?.ok) renderProgress(response.progress, response.running);
  return Boolean(response?.running);
}

function applyItems(items, meta = {}) {
  cachedItems = Array.isArray(items) ? items : [];
  cachedQuery = String(meta.query || "").slice(0, 2000);
  cachedScope = String(meta.scope || "current-list");
  els.listCount.textContent = String(cachedItems.length);
  if (meta.adapter || meta.page || meta.capabilities) {
    applyCapabilities(
      meta.adapter || currentAdapter,
      meta.page || currentPage,
      meta.capabilities || {}
    );
  }
  els.log.textContent = cachedItems
    .slice(0, 10)
    .map((item, offset) => {
      const group = item.instanceLabel ? `[${item.instanceLabel}] ` : "";
      return `${item.index || offset + 1}. ${group}${String(item.title || "document").slice(0, 70)}`;
    })
    .join("\n");
  if (cachedItems.length > 10) {
    els.log.textContent += `\n… и ещё ${cachedItems.length - 10}`;
  }
  if (!cachedItems.length) {
    els.log.textContent = meta.emptyMessage || "Ничего не найдено";
  }
  updateActionState();
}

async function storeSettings() {
  const folder = consSanitizeFolder(els.downloadFolder.value);
  const settings = {
    rememberQuery: els.rememberQuery.checked,
    lastScope: els.scope.value,
    lastFormat: els.format.value,
    downloadFolder: folder,
    maxItems: maxItemsValue(),
    lastInstances: selectedInstances(),
  };
  if (els.rememberQuery.checked) settings.lastQuery = els.query.value.trim();
  await chrome.storage.local.set(settings);
  if (!els.rememberQuery.checked) await chrome.storage.local.remove("lastQuery");
  els.downloadFolder.value = folder;
  els.folderPreview.textContent = folder;
  els.maxItems.value = String(settings.maxItems);
}

async function init() {
  const stored = await chrome.storage.local.get([
    "lastQuery",
    "lastScope",
    "downloadFolder",
    "lastFormat",
    "rememberQuery",
    "maxItems",
    "lastInstances",
  ]);
  els.rememberQuery.checked = Boolean(stored.rememberQuery);
  if (els.rememberQuery.checked && stored.lastQuery) els.query.value = stored.lastQuery;
  if (!els.rememberQuery.checked && stored.lastQuery) await chrome.storage.local.remove("lastQuery");
  if (stored.lastScope) els.scope.value = stored.lastScope;
  if (stored.lastFormat) els.format.value = stored.lastFormat;
  const storedInstances = consNormalizeJudicialInstances(stored.lastInstances);
  if (storedInstances.length) {
    for (const input of els.instanceInputs) {
      input.checked = storedInstances.includes(input.value);
    }
  }
  els.maxItems.value = String(stored.maxItems || 50);
  const folder = consSanitizeFolder(stored.downloadFolder || "ConsExport");
  els.downloadFolder.value = folder;
  els.folderPreview.textContent = folder;

  const running = await refreshProgress();
  if (running) pollWhileRunning();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !consIsConsultantPageUrl(tab.url)) {
    els.pageMeta.textContent =
      "Откройте online.consultant.ru после входа — либо нажмите «Найти»";
    applyCapabilities("online-app", "unsupported");
    return;
  }
  els.pageMeta.textContent = tab.title || consRedactUrl(tab.url);

  const ping = await tabMessage({ type: "PING" });
  if (!ping?.ok) {
    els.pageMeta.textContent = ping?.error || "Не удалось связаться со страницей";
    applyCapabilities("online-app", ping?.code === "AUTH_REQUIRED" ? "auth-required" : "unsupported");
    return;
  }
  applyCapabilities(ping.adapter, ping.page, ping.capabilities);
  if (ping.authRequired) {
    els.pageMeta.textContent = "Сначала войдите в онлайн-КонсультантПлюс";
    return;
  }
  if (ping.page === "list") await scanList();
}

async function scanList() {
  const response = await tabMessage({
    type: "COLLECT_LIST",
    allResults: true,
    maxItems: maxItemsValue(),
  });
  if (!response?.ok) {
    applyItems([], { emptyMessage: response?.error || "Не удалось прочитать список" });
    els.listCount.textContent = "ошибка";
    return false;
  }
  applyItems(response.items, {
    adapter: response.adapter,
    page: response.page,
    capabilities: response.capabilities,
    query: response.query || "",
    scope: response.category?.key
      ? `current:${response.category.key}`
      : "current-list",
  });
  if (response.category?.label) {
    if (response.categoryTotalKnown) {
      const suffix = response.truncatedByLimit
        ? " (достигнут лимит)"
        : response.incomplete
          ? " (список дочитан не полностью)"
          : "";
      els.progressText.textContent =
        `${response.category.label}: собрано ${response.count} из ` +
        `${response.categoryTotal}${suffix}`;
      els.listCount.textContent = `${response.count} из ${response.categoryTotal}`;
    } else {
      els.progressText.textContent =
        `${response.category.label}: собрано ${response.count}` +
        (response.truncated ? " (возможна неполная выборка)" : "");
    }
  }
  return true;
}

async function runFind(autoExport) {
  if (actionPending || exportRunning) return;
  const query = els.query.value.trim();
  const scope = els.scope.value;
  if (!query) {
    setLog("Введите, какую практику нужно найти");
    els.query.focus();
    return;
  }
  actionPending = true;
  updateActionState();
  els.progressText.textContent = autoExport ? "поиск + сохранение…" : "поиск…";
  setLog(`Ищем: ${query}`);

  try {
    await storeSettings();
    const response = await sendMessage({
      type: "RUN_SEARCH_FLOW",
      query,
      scope,
      instances: selectedInstances(),
      autoExport,
      format: els.format.value,
      maxItems: maxItemsValue(),
    });
    if (!response?.ok) {
      els.progressText.textContent = "ошибка";
      setLog(response?.error || "Поиск не удался");
      return;
    }
    applyItems(response.items || [], {
      adapter: response.adapter || currentAdapter,
      page: "list",
      query: response.query ?? query,
      scope: response.scope ?? scope,
      emptyMessage: "По запросу список пуст. Уточните формулировку или область поиска.",
    });
    els.progressText.textContent = response.exportStarted
      ? `сохраняем ${response.count} док.${response.truncated ? " (с учётом лимита)" : ""}`
      : `найдено: ${response.count || 0}${
          response.truncated ? " (достигнут лимит)" : ""
        }`;
    if (response.exportStarted) {
      exportRunning = true;
      pollWhileRunning();
    }
  } catch (error) {
    els.progressText.textContent = "ошибка";
    setLog(String(error?.message || error));
  } finally {
    actionPending = false;
    updateActionState();
  }
}

async function exportCachedItems() {
  if (actionPending || exportRunning) return;
  actionPending = true;
  updateActionState();
  try {
    if (!cachedItems.length && !(await scanList())) return;
    if (!cachedItems.length) return;
    await storeSettings();
    const response = await sendMessage({
      type: "START_TAB_EXPORT",
      adapter: currentAdapter,
      items: cachedItems,
      format: els.format.value,
      maxItems: maxItemsValue(),
      query: cachedQuery,
      scope: cachedScope,
    });
    if (!response?.ok) {
      setLog(response?.error || "Не удалось запустить экспорт");
      return;
    }
    exportRunning = true;
    els.progressText.textContent = `сохраняем ${response.total} док.`;
    pollWhileRunning();
  } catch (error) {
    setLog(String(error?.message || error));
  } finally {
    actionPending = false;
    updateActionState();
  }
}

async function exportCurrentDocument() {
  if (actionPending || exportRunning) return;
  actionPending = true;
  updateActionState();
  try {
    await storeSettings();
    const response = await sendMessage({
      type: "START_CURRENT_EXPORT",
      format: els.format.value,
    });
    if (!response?.ok) {
      setLog(response?.error || "Не удалось сохранить документ");
      return;
    }
    exportRunning = true;
    els.progressText.textContent = "сохраняем текущий документ…";
    pollWhileRunning();
  } catch (error) {
    setLog(String(error?.message || error));
  } finally {
    actionPending = false;
    updateActionState();
  }
}

function pollWhileRunning() {
  if (progressTimer) clearInterval(progressTimer);
  els.btnStop.hidden = false;
  progressTimer = setInterval(async () => {
    const running = await refreshProgress();
    if (!running) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
  }, 750);
}

els.btnFind.addEventListener("click", () => runFind(false));
els.btnFindSave.addEventListener("click", () => runFind(true));
els.btnScan.addEventListener("click", () => scanList());
els.btnExport.addEventListener("click", () => exportCachedItems());
els.btnOne.addEventListener("click", () => exportCurrentDocument());

els.query.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    runFind(false);
  }
});

els.downloadFolder.addEventListener("change", () => storeSettings());
els.format.addEventListener("change", () => storeSettings().then(updateActionState));
els.scope.addEventListener("change", () => {
  updateInstancesState();
  updateActionState();
  storeSettings();
});
for (const input of els.instanceInputs) {
  input.addEventListener("change", () => {
    updateActionState();
    storeSettings();
  });
}
els.maxItems.addEventListener("change", () => storeSettings());
els.rememberQuery.addEventListener("change", () => storeSettings());

els.btnOpenDownloadsSettings.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://settings/downloads" }).catch(() => {
    setLog("Откройте вручную chrome://settings/downloads и выключите запрос места сохранения");
  });
});

els.btnStop.addEventListener("click", async () => {
  const response = await sendMessage({ type: "STOP_EXPORT" });
  if (!response?.ok) setLog(response?.error || "Не удалось остановить экспорт");
  await refreshProgress();
});

els.btnProbe.addEventListener("click", async () => {
  const [pageResponse, downloadResponse] = await Promise.all([
    tabMessage({ type: "PROBE" }),
    sendMessage({ type: "GET_DOWNLOAD_DIAGNOSTICS" }),
  ]);
  if (!pageResponse?.ok && !downloadResponse?.ok) {
    setLog(pageResponse?.error || downloadResponse?.error || "Диагностика недоступна");
    return;
  }
  const text = JSON.stringify(
    consBuildSafeDiagnosticsSnapshot(
      pageResponse?.ok ? pageResponse.probe : {},
      downloadResponse?.ok ? downloadResponse.diagnostics : []
    ),
    null,
    2
  );
  setLog(text);
  try {
    await navigator.clipboard.writeText(text);
    els.progressText.textContent = "Обезличенная диагностика скопирована";
  } catch {
    els.progressText.textContent = "Диагностика готова";
  }
});

els.btnClearData.addEventListener("click", async () => {
  const response = await sendMessage({ type: "CLEAR_LOCAL_DATA" });
  if (!response?.ok) {
    setLog(response?.error || "Не удалось очистить данные");
    return;
  }
  els.query.value = "";
  els.rememberQuery.checked = false;
  els.downloadFolder.value = "ConsExport";
  els.folderPreview.textContent = "ConsExport";
  els.maxItems.value = "50";
  for (const input of els.instanceInputs) {
    input.checked = ["higher-courts", "arbitration-circuit"].includes(input.value);
  }
  applyItems([], { emptyMessage: "Список очищен" });
  setLog("Локальные настройки, запрос и история экспорта удалены");
  await refreshProgress();
});

init().catch((error) => {
  els.pageMeta.textContent = String(error?.message || error);
});
