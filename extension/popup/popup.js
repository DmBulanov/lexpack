const els = {
  pageMeta: document.getElementById("pageMeta"),
  format: document.getElementById("format"),
  downloadFolder: document.getElementById("downloadFolder"),
  folderPreview: document.getElementById("folderPreview"),
  btnOpenDownloadsSettings: document.getElementById("btnOpenDownloadsSettings"),
  searchPanel: document.getElementById("searchPanel"),
  searchSummary: document.getElementById("searchSummary"),
  query: document.getElementById("query"),
  scope: document.getElementById("scope"),
  instancesBlock: document.getElementById("instancesBlock"),
  instanceInputs: [...document.querySelectorAll("input[name='instance']")],
  resultActions: document.getElementById("resultActions"),
  resultTitle: document.getElementById("resultTitle"),
  resultQuantity: document.getElementById("resultQuantity"),
  foundSummary: document.getElementById("foundSummary"),
  maxItems: document.getElementById("maxItems"),
  btnFind: document.getElementById("btnFind"),
  contextActions: document.getElementById("contextActions"),
  btnExport: document.getElementById("btnExport"),
  btnOne: document.getElementById("btnOne"),
  btnStop: document.getElementById("btnStop"),
  btnProbe: document.getElementById("btnProbe"),
  btnClearData: document.getElementById("btnClearData"),
  extensionVersion: document.getElementById("extensionVersion"),
  progressText: document.getElementById("progressText"),
  progressInfoControl: document.getElementById("progressInfoControl"),
  progressInfo: document.getElementById("progressInfo"),
  infoButtons: [...document.querySelectorAll(".info-button[data-info-target]")],
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
let collectionReady = false;
let collectionMeta = {};
let collectionSource = "";
let collectionStatus = "idle";
let collectionMessage = "";
let currentTabId = null;
let currentAdapter = "online-app";
let currentPage = "unsupported";
let currentTabUrl = "";
let currentCapabilities = consGetAdapterCapabilities(currentAdapter);
let exportRunning = false;
let actionPending = false;
let collectionScanDeferred = false;
let progressTimer = null;
let openInfoButton = null;

function infoPopoverFor(button) {
  const id = button?.dataset.infoTarget;
  return id ? document.getElementById(id) : null;
}

function closeInfoPopover({ restoreFocus = false } = {}) {
  if (!openInfoButton) return;
  const button = openInfoButton;
  const popover = infoPopoverFor(button);
  button.setAttribute("aria-expanded", "false");
  if (popover) {
    popover.hidden = true;
    popover.style.removeProperty("left");
    popover.style.removeProperty("top");
    popover.style.removeProperty("visibility");
  }
  openInfoButton = null;
  if (restoreFocus) button.focus();
}

function positionInfoPopover(button, popover) {
  const viewportGap = 8;
  const triggerGap = 6;
  popover.style.visibility = "hidden";
  popover.hidden = false;
  const buttonRect = button.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const maxLeft = Math.max(viewportGap, window.innerWidth - popoverRect.width - viewportGap);
  const left = Math.min(maxLeft, Math.max(viewportGap, buttonRect.right - popoverRect.width));
  let top = buttonRect.bottom + triggerGap;
  if (top + popoverRect.height > window.innerHeight - viewportGap) {
    top = buttonRect.top - popoverRect.height - triggerGap;
  }
  top = Math.max(viewportGap, Math.min(top, window.innerHeight - popoverRect.height - viewportGap));
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
  popover.style.visibility = "visible";
}

function openInfoPopover(button) {
  const popover = infoPopoverFor(button);
  if (!popover || button.closest("[hidden]")) return;
  if (openInfoButton && openInfoButton !== button) closeInfoPopover();
  openInfoButton = button;
  button.setAttribute("aria-expanded", "true");
  positionInfoPopover(button, popover);
}

function setupInfoPopovers() {
  for (const button of els.infoButtons) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (openInfoButton === button) closeInfoPopover();
      else openInfoPopover(button);
    });
  }

  document.addEventListener("click", (event) => {
    if (!openInfoButton) return;
    const popover = infoPopoverFor(openInfoButton);
    if (popover?.contains(event.target)) return;
    closeInfoPopover();
  });
  document.addEventListener("focusin", (event) => {
    if (!openInfoButton) return;
    const popover = infoPopoverFor(openInfoButton);
    if (event.target === openInfoButton || popover?.contains(event.target)) return;
    closeInfoPopover();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !openInfoButton) return;
    event.preventDefault();
    closeInfoPopover({ restoreFocus: true });
  });
  window.addEventListener("resize", () => {
    if (!openInfoButton) return;
    const popover = infoPopoverFor(openInfoButton);
    if (popover) positionInfoPopover(openInfoButton, popover);
  });
  window.addEventListener("scroll", () => closeInfoPopover(), true);
}

function setProgressInfo(messages = []) {
  const text = messages.filter(Boolean).join(" ");
  if (!text && openInfoButton?.dataset.infoTarget === "progressInfo") {
    closeInfoPopover();
  }
  els.progressInfo.textContent = text;
  els.progressInfoControl.hidden = !text;
}

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
  const available = Math.min(200, cachedItems.length);
  if (!available) return 0;
  const value = Number.parseInt(els.maxItems.value, 10);
  return Number.isInteger(value) && value > 0
    ? Math.min(available, value)
    : 0;
}

function documentWord(count) {
  const value = Math.abs(Number(count) || 0) % 100;
  const tail = value % 10;
  if (value >= 11 && value <= 14) return "документов";
  if (tail === 1) return "документ";
  if (tail >= 2 && tail <= 4) return "документа";
  return "документов";
}

function updateDownloadSelection() {
  const available = Math.min(200, cachedItems.length);
  els.maxItems.max = String(Math.max(1, available));
  const selected = maxItemsValue();
  els.btnExport.textContent = selected
    ? `Скачать ${selected} ${documentWord(selected)}`
    : "Скачать документы";
}

function collectionSummary(meta = {}) {
  const count = cachedItems.length;
  const total = Number(meta.total);
  const prefix = meta.label ? `${meta.label}: ` : "";
  const found = prefix ? "найдено" : "Найдено";
  if (meta.totalKnown && Number.isInteger(total) && total > count) {
    return `${prefix}${found} ${total}. Можно скачать ${count}.`;
  }
  if (meta.truncated) {
    return `${prefix}${found} не менее ${count}. Можно скачать ${count}.`;
  }
  return `${prefix}${found} ${count}`;
}

function invalidateCollection() {
  cachedItems = [];
  cachedQuery = "";
  cachedScope = "current-list";
  collectionReady = false;
  collectionMeta = {};
  collectionSource = "";
  collectionStatus = "idle";
  collectionMessage = "";
  updateDownloadSelection();
  updateActionState();
}

function isOnlineFullResultsUrl(rawUrl = currentTabUrl) {
  try {
    const url = new URL(rawUrl);
    return currentAdapter === "online-app" && url.searchParams.get("req") === "query";
  } catch {
    return false;
  }
}

function manualCategoryIsSupported(category) {
  if (!isOnlineFullResultsUrl()) return true;
  return CONS_JUDICIAL_INSTANCES.includes(String(category?.key || ""));
}

function setCollectionNotice(status, message, meta = {}) {
  cachedItems = [];
  cachedQuery = String(meta.query || "").slice(0, 2000);
  cachedScope = String(meta.scope || "current-list");
  collectionReady = false;
  collectionSource = String(meta.source || "current-list");
  collectionStatus = status;
  collectionMessage = String(message || "");
  collectionMeta = {
    label: String(meta.label || ""),
    total: 0,
    totalKnown: false,
    truncated: false,
  };
  els.log.textContent = collectionMessage;
  updateActionState();
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
  const documentPage = currentPage === "document";
  const hasDownloadableCollection =
    collectionStatus === "ready" && collectionReady && cachedItems.length > 0;
  const retryableCollection =
    collectionStatus === "error" && currentCapabilities.collectList === true;
  els.resultTitle.textContent = collectionSource === "search"
    ? "Результаты поиска"
    : "Открытая подборка";
  els.searchSummary.textContent = collectionStatus === "idle"
    ? "Найти практику"
    : "Найти другую практику";
  els.foundSummary.textContent = hasDownloadableCollection
    ? collectionSummary(collectionMeta)
    : collectionMessage;
  els.resultActions.hidden = collectionStatus === "idle";
  els.resultQuantity.hidden = !hasDownloadableCollection;
  els.btnExport.hidden = !hasDownloadableCollection && !retryableCollection;
  if (retryableCollection) els.btnExport.textContent = "Повторить чтение";
  else updateDownloadSelection();
  els.btnOne.hidden = !documentPage;
  els.btnExport.disabled =
    exportRunning ||
    actionPending ||
    (!retryableCollection &&
      (!formatSupported || !hasDownloadableCollection || maxItemsValue() === 0));
  els.maxItems.disabled = exportRunning || actionPending || !hasDownloadableCollection;
  els.btnOne.disabled =
    exportRunning || actionPending || currentPage !== "document" || !formatSupported;
  const instancesReady =
    currentAdapter !== "online-app" || selectedInstances().length > 0;
  els.btnFind.disabled =
    exportRunning || actionPending || currentPage === "auth-required" || !instancesReady;
  els.contextActions.hidden = [els.btnOne, els.btnStop].every(
    (button) => button.hidden
  );
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
    collectList: pageCapabilities.collectList === true,
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

  updateActionState();
}

function renderProgress(progress, running) {
  if (!progress) return;
  exportRunning = Boolean(running);
  const {
    current = 0,
    total = 0,
    completed = 0,
    unconfirmed = 0,
    failed = 0,
    status = "idle",
    log = [],
  } = progress;
  const label = STATUS_LABELS[status] || status;
  const outcomes = [];
  if (unconfirmed > 0 || failed > 0) outcomes.push(`успешно ${completed}`);
  if (unconfirmed > 0) outcomes.push(`требует проверки ${unconfirmed}`);
  if (failed > 0) outcomes.push(`ошибок ${failed}`);
  els.progressText.textContent = status === "idle"
    ? label
    : `${label}: ${current}/${total || "?"}${outcomes.length ? `; ${outcomes.join(", ")}` : ""}`;
  const hints = [];
  if (unconfirmed > 0) {
    hints.push(
      "«Требует проверки» означает: Chrome не смог надёжно сопоставить загрузку; перед повторным запуском проверьте файл в «Загрузках»."
    );
  }
  if (failed > 0) {
    hints.push(
      "Ошибка означает прерванную загрузку или сбой операции; подробность указана в журнале."
    );
  }
  setProgressInfo(hints);
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
  collectionSource = String(meta.source || "search");
  collectionStatus = String(
    meta.status || (cachedItems.length ? "ready" : "empty")
  );
  collectionReady = collectionStatus === "ready" && meta.ready !== false;
  collectionMessage = String(
    meta.message || meta.emptyMessage || (cachedItems.length ? "" : "Документы не найдены")
  );
  collectionMeta = {
    label: String(meta.label || ""),
    total: Number.isInteger(meta.total) ? meta.total : cachedItems.length,
    totalKnown: meta.totalKnown === true,
    truncated: meta.truncated === true,
  };
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
    els.log.textContent = collectionMessage;
  }
  els.maxItems.value = String(Math.max(1, cachedItems.length));
  updateDownloadSelection();
  updateActionState();
}

async function storeSettings() {
  const folder = consSanitizeFolder(els.downloadFolder.value);
  const settings = {
    lastScope: els.scope.value,
    lastFormat: els.format.value,
    downloadFolder: folder,
    lastInstances: selectedInstances(),
    settingsSchemaVersion: CONS_SETTINGS_SCHEMA_VERSION,
  };
  await chrome.storage.local.set(settings);
  els.downloadFolder.value = folder;
  els.folderPreview.textContent = folder;
}

async function init() {
  els.extensionVersion.textContent = chrome.runtime.getManifest().version;
  const stored = await chrome.storage.local.get([
    "lastScope",
    "downloadFolder",
    "lastFormat",
    "lastInstances",
    "settingsSchemaVersion",
  ]);
  if (stored.lastScope) els.scope.value = stored.lastScope;
  if (stored.lastFormat) els.format.value = stored.lastFormat;
  const storedInstances = consNormalizeJudicialInstances(stored.lastInstances);
  if (storedInstances.length) {
    for (const input of els.instanceInputs) {
      input.checked = storedInstances.includes(input.value);
    }
  }
  await chrome.storage.local.remove(["lastQuery", "rememberQuery", "maxItems"]);
  const folder = consMigrateStoredDownloadFolder(
    stored.downloadFolder,
    stored.settingsSchemaVersion
  );
  if (Number(stored.settingsSchemaVersion || 0) < CONS_SETTINGS_SCHEMA_VERSION) {
    await chrome.storage.local.set({
      downloadFolder: folder,
      settingsSchemaVersion: CONS_SETTINGS_SCHEMA_VERSION,
    });
  }
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
  currentTabId = tab.id;
  currentTabUrl = tab.url;
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
  currentTabUrl = ping.url || currentTabUrl;
  if (ping.capabilities?.collectList) {
    if (running) {
      collectionScanDeferred = true;
      setCollectionNotice(
        "loading",
        "После завершения текущей загрузки LexPack прочитает открытую подборку.",
        { source: "current-list", label: ping.category?.label }
      );
    } else {
      await prepareOpenCollection(ping);
    }
  }
}

function unsupportedManualCategoryMessage(category) {
  const label = String(category?.label || "").trim();
  const prefix = label ? `Сейчас открыт раздел «${label}». ` : "";
  return `${prefix}Выберите слева уровень судебной инстанции, который нужно скачать.`;
}

async function prepareOpenCollection(ping) {
  currentTabUrl = ping?.url || currentTabUrl;
  if (!ping?.capabilities?.collectList) return false;
  if (!manualCategoryIsSupported(ping.category)) {
    setCollectionNotice(
      "blocked",
      unsupportedManualCategoryMessage(ping.category),
      {
        source: "current-list",
        query: ping.query || "",
        label: ping.category?.label || "",
      }
    );
    els.progressText.textContent = "выберите уровень судебной инстанции";
    return false;
  }
  const restored = await restoreCollection(ping);
  return restored || scanList(ping);
}

async function scanList(initialPing = null) {
  setCollectionNotice("loading", "Читаю открытую подборку…", {
    source: "current-list",
    query: initialPing?.query || "",
    label: initialPing?.category?.label || "",
  });
  els.progressText.textContent = "читаем найденные документы…";
  const ping = initialPing || await tabMessage({ type: "PING" });
  if (!ping?.ok) {
    setCollectionNotice(
      "error",
      ping?.error || "Не удалось связаться с открытой страницей",
      { source: "current-list" }
    );
    return false;
  }
  currentTabUrl = ping.url || currentTabUrl;
  applyCapabilities(ping.adapter, ping.page, ping.capabilities);
  if (!ping.capabilities?.collectList) {
    setCollectionNotice("error", "На открытой странице нет списка документов", {
      source: "current-list",
    });
    return false;
  }
  if (!manualCategoryIsSupported(ping.category)) {
    setCollectionNotice(
      "blocked",
      unsupportedManualCategoryMessage(ping.category),
      {
        source: "current-list",
        query: ping.query || "",
        label: ping.category?.label || "",
      }
    );
    els.progressText.textContent = "выберите уровень судебной инстанции";
    return false;
  }
  const response = await tabMessage({
    type: "COLLECT_LIST",
    allResults: true,
    maxItems: 200,
    query: ping.query || "",
    category: ping.category?.key || "",
  });
  if (!response?.ok) {
    setCollectionNotice(
      "error",
      response?.error || "Не удалось прочитать открытую подборку",
      {
        source: "current-list",
        query: ping.query || "",
        label: ping.category?.label || "",
      }
    );
    els.progressText.textContent = "не удалось прочитать подборку";
    return false;
  }
  if (!manualCategoryIsSupported(response.category)) {
    setCollectionNotice(
      "blocked",
      unsupportedManualCategoryMessage(response.category),
      {
        source: "current-list",
        query: response.query || "",
        label: response.category?.label || "",
      }
    );
    els.progressText.textContent = "выберите уровень судебной инстанции";
    return false;
  }
  applyItems(response.items, {
    source: "current-list",
    adapter: response.adapter,
    page: response.page,
    capabilities: response.capabilities,
    query: response.query || "",
    label: response.category?.label || "",
    scope: response.category?.key
      ? `current:${response.category.key}`
      : "current-list",
    total: response.categoryTotalKnown ? response.categoryTotal : response.count,
    totalKnown: response.categoryTotalKnown === true,
    truncated: response.truncated === true,
    emptyMessage: "В открытой категории нет документов",
  });
  await sendMessage({
    type: "CACHE_SEARCH_COLLECTION",
    tabId: currentTabId,
    source: "current-list",
    adapter: response.adapter,
    query: response.query || "",
    categoryKey: response.category?.key || "",
    scope: response.category?.key
      ? `current:${response.category.key}`
      : "current-list",
    items: response.items,
    total: response.categoryTotalKnown ? response.categoryTotal : response.count,
    totalKnown: response.categoryTotalKnown === true,
    truncated: response.truncated === true,
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
    } else {
      els.progressText.textContent =
        `${response.category.label}: собрано ${response.count}` +
        (response.truncated ? " (возможна неполная выборка)" : "");
    }
  }
  return true;
}

async function restoreCollection(ping) {
  const response = await sendMessage({
    type: "GET_SEARCH_COLLECTION",
    tabId: currentTabId,
    adapter: ping.adapter,
    query: ping.query || "",
    categoryKey: ping.category?.key || "",
  });
  const cache = response?.cache;
  if (!response?.ok || cache?.status !== "ready") return false;
  applyItems(cache.items || [], {
    source: cache.source || "current-list",
    adapter: cache.adapter || ping.adapter,
    page: "list",
    capabilities: ping.capabilities,
    query: cache.query || "",
    scope: cache.scope || "current-list",
    label: cache.source === "current-list" ? ping.category?.label || "" : "",
    total: cache.total,
    totalKnown: cache.totalKnown,
    truncated: cache.truncated,
    emptyMessage: "Документы не найдены",
  });
  els.progressText.textContent = cache.items?.length
    ? collectionSummary(cache)
    : "Документы не найдены";
  return true;
}

async function runFind() {
  if (actionPending || exportRunning) return;
  const query = els.query.value.trim();
  const scope = els.scope.value;
  if (!query) {
    setLog("Введите, какую практику нужно найти");
    els.query.focus();
    return;
  }
  actionPending = true;
  invalidateCollection();
  updateActionState();
  setProgressInfo();
  els.progressText.textContent = "поиск…";
  setLog(`Ищем: ${query}`);

  try {
    await storeSettings();
    const response = await sendMessage({
      type: "RUN_SEARCH_FLOW",
      query,
      scope,
      instances: selectedInstances(),
    });
    if (!response?.ok) {
      els.progressText.textContent = "ошибка";
      setLog(response?.error || "Поиск не удался");
      return;
    }
    applyItems(response.items || [], {
      source: "search",
      adapter: response.adapter || currentAdapter,
      page: "list",
      query: response.query ?? query,
      scope: response.scope ?? scope,
      total: response.count || 0,
      totalKnown: response.truncated !== true,
      truncated: response.truncated === true,
      emptyMessage: "По запросу список пуст. Уточните формулировку или область поиска.",
    });
    if (response.count) {
      els.searchPanel.open = false;
      window.scrollTo(0, 0);
    }
    els.progressText.textContent = response.count
      ? collectionSummary({
          total: response.count,
          totalKnown: response.truncated !== true,
          truncated: response.truncated === true,
        })
      : "Документы не найдены";
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
    if (!collectionReady || !cachedItems.length) return;
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
    setProgressInfo();
    els.progressText.textContent = `скачиваем ${response.total} док.`;
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
      setLog(response?.error || "Не удалось скачать документ");
      return;
    }
    exportRunning = true;
    setProgressInfo();
    els.progressText.textContent = "скачиваем открытый документ…";
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
  updateActionState();
  progressTimer = setInterval(async () => {
    const running = await refreshProgress();
    if (!running) {
      clearInterval(progressTimer);
      progressTimer = null;
      if (collectionScanDeferred) {
        collectionScanDeferred = false;
        const ping = await tabMessage({ type: "PING" });
        if (ping?.ok) await prepareOpenCollection(ping);
      }
    }
  }, 750);
}

async function handleCollectionButton() {
  if (collectionStatus !== "error") {
    await exportCachedItems();
    return;
  }
  if (actionPending || exportRunning) return;
  actionPending = true;
  updateActionState();
  try {
    await scanList();
  } finally {
    actionPending = false;
    updateActionState();
  }
}

function invalidateSearchCollection() {
  if (collectionSource === "search") invalidateCollection();
}

els.btnFind.addEventListener("click", () => runFind());
els.btnExport.addEventListener("click", () => handleCollectionButton());
els.btnOne.addEventListener("click", () => exportCurrentDocument());

els.query.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    runFind();
  }
});
els.query.addEventListener("input", () => {
  if (
    collectionSource === "search" &&
    collectionReady &&
    els.query.value.trim() !== cachedQuery
  ) {
    invalidateSearchCollection();
  }
});
els.downloadFolder.addEventListener("change", () => storeSettings());
els.format.addEventListener("change", () => storeSettings().then(updateActionState));
els.scope.addEventListener("change", () => {
  invalidateSearchCollection();
  updateInstancesState();
  updateActionState();
  storeSettings();
});
for (const input of els.instanceInputs) {
  input.addEventListener("change", () => {
    invalidateSearchCollection();
    updateActionState();
    storeSettings();
  });
}
els.maxItems.addEventListener("input", () => {
  updateDownloadSelection();
  updateActionState();
});
els.maxItems.addEventListener("change", () => {
  els.maxItems.value = String(maxItemsValue() || Math.min(200, cachedItems.length) || 1);
  updateDownloadSelection();
  updateActionState();
});
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
    {
      version: chrome.runtime.getManifest().version,
      ...consBuildSafeDiagnosticsSnapshot(
        pageResponse?.ok ? pageResponse.probe : {},
        downloadResponse?.ok ? downloadResponse.diagnostics : []
      ),
    },
    null,
    2
  );
  setLog(text);
  try {
    await navigator.clipboard.writeText(text);
    els.progressText.textContent = "Обезличенная диагностика скопирована";
  } catch {
    els.progressText.textContent =
      "Не удалось скопировать — скопируйте диагностику из журнала вручную";
  }
});

els.btnClearData.addEventListener("click", async () => {
  if (!confirm(
    "Сбросить область поиска, формат, подпапку, инстанции, текущую подборку и историю задачи? Скачанные файлы и вход не изменятся."
  )) {
    return;
  }
  const response = await sendMessage({ type: "CLEAR_LOCAL_DATA" });
  if (!response?.ok) {
    setLog(response?.error || "Не удалось очистить данные");
    return;
  }
  els.query.value = "";
  els.downloadFolder.value = CONS_DEFAULT_DOWNLOAD_FOLDER;
  els.folderPreview.textContent = CONS_DEFAULT_DOWNLOAD_FOLDER;
  const defaultScope = [...els.scope.options].find(
    (option) => option.value === "practice" && !option.disabled
  ) || [...els.scope.options].find((option) => !option.disabled);
  const defaultFormat = [...els.format.options].find(
    (option) => option.value === "docx" && !option.disabled
  ) || [...els.format.options].find((option) => !option.disabled);
  if (defaultScope) els.scope.value = defaultScope.value;
  if (defaultFormat) els.format.value = defaultFormat.value;
  for (const input of els.instanceInputs) {
    input.checked = ["higher-courts", "arbitration-circuit"].includes(input.value);
  }
  invalidateCollection();
  setLog(
    "Настройки возвращены по умолчанию. Текущая подборка и история задачи удалены; скачанные файлы не изменены."
  );
  await refreshProgress();
});

setupInfoPopovers();

init().catch((error) => {
  els.pageMeta.textContent = String(error?.message || error);
});
