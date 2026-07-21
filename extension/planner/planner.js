const plannerVariant = globalThis.LEXPACK_VARIANT;
if (!plannerVariant) throw new Error("LexPack variant configuration is missing");

const els = {
  variantLabel: document.getElementById("variantLabel"),
  status: document.getElementById("status"),
  profileSelect: document.getElementById("profileSelect"),
  profileName: document.getElementById("profileName"),
  format: document.getElementById("format"),
  filenameTemplate: document.getElementById("filenameTemplate"),
  folderTemplate: document.getElementById("folderTemplate"),
  newProfile: document.getElementById("newProfile"),
  duplicateProfile: document.getElementById("duplicateProfile"),
  deleteProfile: document.getElementById("deleteProfile"),
  saveProfile: document.getElementById("saveProfile"),
  profileStateText: document.getElementById("profileStateText"),
  collectionSummary: document.getElementById("collectionSummary"),
  selectAll: document.getElementById("selectAll"),
  selectNone: document.getElementById("selectNone"),
  selectedCount: document.getElementById("selectedCount"),
  planWarnings: document.getElementById("planWarnings"),
  planErrors: document.getElementById("planErrors"),
  documentRows: document.getElementById("documentRows"),
  historyMode: document.getElementById("historyMode"),
  historyNotice: document.getElementById("historyNotice"),
  historyList: document.getElementById("historyList"),
  clearHistory: document.getElementById("clearHistory"),
  launchSummary: document.getElementById("launchSummary"),
  launchHint: document.getElementById("launchHint"),
  startExport: document.getElementById("startExport"),
};

let collection = null;
let sourceItems = [];
let selectedSourceIndexes = new Set();
let profileState = null;
let historyState = { schemaVersion: 1, records: [] };
let currentPlan = null;
let retryProfileSnapshot = null;
let updateTimer = null;
let running = false;
let progressTimer = null;

function extensionVersionLabel() {
  const manifest = chrome.runtime.getManifest();
  return manifest.version_name || manifest.version;
}

async function sendMessage(message) {
  let response = await chrome.runtime.sendMessage(message);
  if (response === undefined || response === null) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    response = await chrome.runtime.sendMessage(message);
  }
  if (!response) throw new Error("Фоновый процесс расширения не ответил");
  return response;
}

function setStatus(text, error = false) {
  els.status.textContent = String(text || "");
  els.status.classList.toggle("error", Boolean(error));
}

function activeProfile() {
  if (els.profileSelect.value === "__retry_snapshot__" && retryProfileSnapshot) {
    return retryProfileSnapshot;
  }
  return profileState?.profiles?.find((profile) => profile.id === els.profileSelect.value)
    || profileState?.profiles?.[0]
    || null;
}

function profileDraft() {
  const source = activeProfile() || {};
  return {
    ...source,
    name: els.profileName.value,
    format: els.format.value,
    filenameTemplate: els.filenameTemplate.value,
    folderTemplate: els.folderTemplate.value,
    collisionPolicy: "ordered-suffix",
  };
}

function renderProfileOptions(selectedId = null) {
  const requested = selectedId || profileState?.selectedProfileId || CONS_DEFAULT_PROFILE_ID;
  els.profileSelect.replaceChildren();
  if (retryProfileSnapshot) {
    const option = document.createElement("option");
    option.value = "__retry_snapshot__";
    option.textContent = `Snapshot: ${retryProfileSnapshot.name}`;
    els.profileSelect.append(option);
  }
  for (const profile of profileState?.profiles || []) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.builtIn ? `${profile.name} (встроенный)` : profile.name;
    els.profileSelect.append(option);
  }
  const available = [...els.profileSelect.options].some((option) => option.value === requested);
  els.profileSelect.value = available ? requested : CONS_DEFAULT_PROFILE_ID;
  loadProfileFields(activeProfile());
}

function loadProfileFields(profile) {
  if (!profile) return;
  const capabilities = consGetAdapterCapabilities(collection?.adapter || "online-app");
  for (const option of els.format.options) {
    option.disabled = !capabilities.exportFormats.includes(option.value);
  }
  const supportedFormat = capabilities.exportFormats.includes(profile.format)
    ? profile.format
    : capabilities.exportFormats[0] || "txt";
  els.profileName.value = profile.name;
  els.format.value = supportedFormat;
  els.filenameTemplate.value = profile.filenameTemplate;
  els.folderTemplate.value = profile.folderTemplate;
  const snapshot = els.profileSelect.value === "__retry_snapshot__";
  els.profileName.disabled = profile.builtIn || snapshot;
  els.format.disabled = snapshot;
  els.filenameTemplate.disabled = snapshot;
  els.folderTemplate.disabled = snapshot;
  els.saveProfile.disabled = snapshot;
  els.deleteProfile.disabled = profile.builtIn || snapshot;
  els.profileStateText.textContent = snapshot
    ? "Используется неизменённый snapshot завершённой задачи; можно выбрать актуальный профиль."
    : "";
  schedulePlanUpdate();
}

function schedulePlanUpdate() {
  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = setTimeout(updatePlan, 100);
}

function updatePlanNow() {
  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = null;
  updatePlan();
}

function updatePlan() {
  updateTimer = null;
  const profile = profileDraft();
  currentPlan = consBuildExportPlan({
    adapter: collection?.adapter || "online-app",
    query: collection?.query || "",
    collection: collection || {},
    items: sourceItems,
    selectedSourceIndexes: [...selectedSourceIndexes],
    profile,
  });
  renderPlan();
}

function metadataText(item) {
  const metadata = consNormalizeDocumentMetadata(item);
  const labels = { date: "Дата", case: "Дело", court: "Суд", documentType: "Тип" };
  return Object.entries(labels)
    .map(([field, label]) => {
      const value = metadata[field];
      if (value.value) return `${label}: ${value.value}`;
      if (value.confidence === "ambiguous") return `${label}: неоднозначно`;
      return `${label}: —`;
    })
    .join("\n");
}

function appendCell(row, text, className = "") {
  const cell = document.createElement("td");
  cell.textContent = String(text ?? "");
  if (className) cell.className = className;
  row.append(cell);
  return cell;
}

function renderRows() {
  const bySourceIndex = new Map(
    (currentPlan?.items || []).map((item) => [item.sourceIndex, item])
  );
  const fragment = document.createDocumentFragment();
  sourceItems.forEach((source, offset) => {
    const sourceIndex = Number(source.sourceIndex ?? source.index) || offset + 1;
    const planned = bySourceIndex.get(sourceIndex);
    const selected = selectedSourceIndexes.has(sourceIndex);
    const row = document.createElement("tr");
    if (!selected) row.className = "unselected";

    const selectCell = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected;
    checkbox.dataset.sourceIndex = String(sourceIndex);
    checkbox.setAttribute("aria-label", `Выбрать документ ${sourceIndex}`);
    checkbox.disabled = running;
    selectCell.append(checkbox);
    row.append(selectCell);

    appendCell(row, planned ? String(planned.exportIndex).padStart(2, "0") : "—");
    appendCell(row, sourceIndex);
    appendCell(row, source.title || source.originalTitle || "document", "title");
    appendCell(row, source.instanceLabel || source.instance || "—");
    appendCell(row, metadataText(source), "metadata");
    appendCell(row, planned?.plannedRelativePath || "—", "path");
    const warningText = planned?.warnings?.map((warning) => warning.message).join("; ") || "";
    appendCell(row, warningText || "—", warningText ? "warning" : "");
    fragment.append(row);
  });
  els.documentRows.replaceChildren(fragment);
}

function renderPlan() {
  const selected = currentPlan?.selectedCount || 0;
  els.selectedCount.textContent = `Выбрано: ${selected} из ${sourceItems.length}`;
  const warningCount = currentPlan?.warnings?.length || 0;
  els.planWarnings.textContent = warningCount
    ? `Предупреждений: ${warningCount}`
    : "Предупреждений нет";
  const errors = currentPlan?.errors || [];
  els.planErrors.hidden = errors.length === 0;
  els.planErrors.textContent = errors.map((error) => error.message).join("\n");
  renderRows();
  const canStart = Boolean(currentPlan?.ok && selected > 0 && !running);
  els.startExport.disabled = !canStart;
  els.selectAll.disabled = running || !sourceItems.length;
  els.selectNone.disabled = running || !sourceItems.length;
  els.launchSummary.textContent = selected
    ? `${selected} документ(ов) · ${currentPlan.format.toUpperCase()}`
    : "Выберите документы";
  els.launchHint.textContent = errors.length
    ? errors[0].message
    : warningCount
      ? "Проверьте предупреждения и пути перед запуском."
      : "План готов к запуску.";
}

async function saveCurrentProfile() {
  if (els.profileSelect.value === "__retry_snapshot__") return true;
  const response = await sendMessage({ type: "PUT_EXPORT_PROFILE", profile: profileDraft() });
  if (!response.ok) {
    setStatus(response.error || "Не удалось сохранить профиль", true);
    return false;
  }
  profileState = response.profileState;
  renderProfileOptions(profileState.selectedProfileId);
  els.profileStateText.textContent = "Профиль сохранён.";
  return true;
}

function newProfileId() {
  const uuid = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `profile-${uuid}`.slice(0, 64);
}

async function createProfile(duplicate = false) {
  const source = profileDraft();
  const now = new Date().toISOString();
  const candidate = {
    ...source,
    id: newProfileId(),
    name: duplicate ? `Копия ${source.name}` : "Новый профиль",
    builtIn: false,
    createdAt: now,
    updatedAt: now,
  };
  const response = await sendMessage({ type: "PUT_EXPORT_PROFILE", profile: candidate });
  if (!response.ok) return setStatus(response.error || "Не удалось создать профиль", true);
  retryProfileSnapshot = null;
  profileState = response.profileState;
  renderProfileOptions(profileState.selectedProfileId);
  if (!duplicate) {
    els.profileName.disabled = false;
    els.profileName.focus();
    els.profileName.select();
  }
}

async function deleteProfile() {
  const profile = activeProfile();
  if (!profile || profile.builtIn || els.profileSelect.value === "__retry_snapshot__") return;
  if (!confirm(`Удалить профиль «${profile.name}»?`)) return;
  const response = await sendMessage({ type: "DELETE_EXPORT_PROFILE", profileId: profile.id });
  if (!response.ok) return setStatus(response.error || "Не удалось удалить профиль", true);
  profileState = response.profileState;
  renderProfileOptions(profileState.selectedProfileId);
}

function collectionLabel(value) {
  if (!value) return "Подборка не загружена.";
  const count = value.items?.length || 0;
  const suffix = value.truncated ? " (достигнут лимит 200)" : "";
  return `Собрано: ${count}${suffix}. Порядок соответствует исходной подборке.`;
}

function historyNotice(mode) {
  if (mode === "off") {
    return "После завершения постоянная запись задачи не создаётся.";
  }
  if (mode === "detailed") {
    return "Подробный режим локально хранит запрос, заголовки документов, безопасные URL источников и результаты обработки. Эти данные могут быть чувствительными и нужны для просмотра и ручного повтора.";
  }
  return "Безопасный режим хранит только время, версию, формат, имя профиля и итоговые счётчики — без запроса, заголовков, URL, номеров дел и списка позиций.";
}

function historyDate(value) {
  if (!value) return "—";
  try { return new Date(value).toLocaleString("ru-RU"); } catch { return value; }
}

function historyButton(text, action, id, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text;
  button.dataset.historyAction = action;
  button.dataset.historyId = id;
  button.disabled = disabled;
  return button;
}

function detailedHistoryShell(record) {
  const details = document.createElement("details");
  details.className = "history-details";
  details.dataset.historyDetailsId = record.id;
  const summary = document.createElement("summary");
  summary.textContent = `Подробный результат · ${record.items.length} позиций`;
  const body = document.createElement("div");
  body.className = "history-details-body";
  body.textContent = "Откройте, чтобы загрузить подробности из локальной записи.";
  details.append(summary, body);
  return details;
}

function renderDetailedHistory(details, record) {
  const body = details.querySelector(".history-details-body");
  if (!body || body.dataset.rendered === "true") return;
  body.dataset.rendered = "true";
  body.replaceChildren();

  const query = document.createElement("p");
  query.textContent = record.query ? `Запрос: ${record.query}` : "Запрос: —";
  const list = document.createElement("ol");
  list.className = "history-item-list";
  for (const item of record.items) {
    const entry = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = `${item.exportIndex}. ${item.originalTitle}`;
    const result = document.createElement("span");
    const actual = item.actualFilename || "—";
    result.textContent =
      `Статус: ${item.status}; попыток: ${item.attempts}; ` +
      `план: ${item.plannedRelativePath || "—"}; фактически: ${actual}`;
    entry.append(title, result);
    if (item.error) {
      const error = document.createElement("span");
      error.className = "history-item-error";
      error.textContent = `Ошибка: ${item.error}`;
      entry.append(error);
    }
    if (item.safeSourceUrl) {
      const source = document.createElement("span");
      source.className = "history-item-source";
      source.textContent = `Источник: ${item.safeSourceUrl}`;
      entry.append(source);
    }
    list.append(entry);
  }
  body.append(query, list);
}

function renderHistory() {
  els.historyNotice.textContent = historyNotice(els.historyMode.value);
  els.historyList.replaceChildren();
  const records = historyState?.records || [];
  els.clearHistory.disabled = records.length === 0;
  if (!records.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "История пока пуста.";
    els.historyList.append(empty);
    return;
  }
  for (const record of records) {
    const entry = document.createElement("article");
    entry.className = "history-entry";
    const info = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = `${historyDate(record.finishedAt)} · ${String(record.format || "").toUpperCase()} · ${record.profileName}`;
    const counts = document.createElement("p");
    counts.textContent = `Выбрано ${record.selectedCount}; успешно ${record.successful}; проверить ${record.reviewRequired}; ошибок ${record.failed}.`;
    const mode = document.createElement("p");
    mode.textContent = record.mode === "detailed" ? "Подробная запись" : "Безопасная запись";
    info.append(title, counts, mode);
    if (record.reportFilename) {
      const report = document.createElement("p");
      report.textContent = `Отчёт: ${record.reportFilename}`;
      info.append(report);
    }

    const actions = document.createElement("div");
    actions.className = "history-actions";
    if (record.mode === "detailed" && Array.isArray(record.items)) {
      actions.append(historyButton("Повторить всё", "retry-all", record.id));
      const hasFailures = record.items.some((item) => ["failed", "unconfirmed"].includes(item.status));
      actions.append(historyButton("Повторить ошибки", "retry-errors", record.id, !hasFailures));
    }
    const remove = historyButton("Удалить", "delete", record.id);
    remove.classList.add("danger");
    actions.append(remove);
    entry.append(info, actions);
    if (record.mode === "detailed" && Array.isArray(record.items)) {
      entry.append(detailedHistoryShell(record));
    }
    els.historyList.append(entry);
  }
}

function prepareRetry(record, failedOnly) {
  if (!record || record.mode !== "detailed" || !Array.isArray(record.items)) return;
  const retryItems = record.items.map((item) => ({
    sourceIndex: item.sourceIndex,
    index: item.sourceIndex,
    title: item.originalTitle,
    url: item.safeSourceUrl,
    instance: item.instance,
    instanceLabel: item.instanceLabel,
    metadata: item.metadata,
    previousStatus: item.status,
  }));
  sourceItems = retryItems;
  selectedSourceIndexes = new Set(
    retryItems
      .filter((item) => !failedOnly || ["failed", "unconfirmed"].includes(item.previousStatus))
      .map((item) => item.sourceIndex)
  );
  collection = {
    ...(record.collection || {}),
    status: "ready",
    source: "history-retry",
    adapter: record.adapter || "online-app",
    query: record.query || "",
    scope: `retry:${record.id}`,
    items: retryItems,
    total: retryItems.length,
    totalKnown: true,
    truncated: false,
  };
  retryProfileSnapshot = record.profileSnapshot;
  els.collectionSummary.textContent = failedOnly
    ? `Повтор failed/unconfirmed из задачи ${historyDate(record.finishedAt)}. Запуск только после нового preview.`
    : `Повтор всей задачи ${historyDate(record.finishedAt)}. Запуск только после нового preview.`;
  renderProfileOptions("__retry_snapshot__");
  updatePlanNow();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function updateHistoryMode() {
  const previous = consNormalizeHistoryMode(els.historyMode.dataset.previous || "safe");
  const next = consNormalizeHistoryMode(els.historyMode.value);
  if (next === "detailed") {
    const accepted = confirm(
      "Подробная история будет хранить в профиле браузера запрос, заголовки документов, безопасные URL источников и результаты обработки. Все данные остаются локальными. Включить?"
    );
    if (!accepted) {
      els.historyMode.value = previous;
      return;
    }
  }
  const response = await sendMessage({ type: "SET_HISTORY_MODE", mode: next });
  if (!response.ok) {
    els.historyMode.value = previous;
    return setStatus(response.error || "Не удалось изменить режим истории", true);
  }
  els.historyMode.dataset.previous = response.mode;
  renderHistory();
}

function renderProgress(progress, active) {
  running = Boolean(active);
  if (!progress) return;
  if (running) {
    setStatus(`Выгрузка выполняется: ${progress.current || 0}/${progress.total || 0}`);
  } else if (progress.status && progress.status !== "idle") {
    setStatus(
      `Последняя задача: ${progress.completed || 0} успешно, ${progress.unconfirmed || 0} требует проверки, ${progress.failed || 0} ошибок.`
    );
  }
  renderPlan();
}

function pollProgress() {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = setInterval(async () => {
    try {
      const response = await sendMessage({ type: "GET_PROGRESS" });
      if (!response.ok) return;
      renderProgress(response.progress, response.running);
      if (!response.running) {
        clearInterval(progressTimer);
        progressTimer = null;
        const context = await sendMessage({ type: "GET_PLANNER_CONTEXT" });
        if (context.ok) {
          historyState = context.history;
          renderHistory();
        }
      }
    } catch (error) {
      setStatus(error.message, true);
    }
  }, 750);
}

async function startExport() {
  if (!currentPlan?.ok || !currentPlan.selectedCount || running) return;
  if (els.profileSelect.value !== "__retry_snapshot__") {
    const saved = await saveCurrentProfile();
    if (!saved) return;
    updatePlan();
  }
  if (!currentPlan?.ok) return;
  running = true;
  renderPlan();
  setStatus("Запускаю выгрузку…");
  const response = await sendMessage({ type: "START_PLANNED_EXPORT", plan: currentPlan });
  if (!response.ok) {
    running = false;
    renderPlan();
    return setStatus(response.error || "Не удалось запустить выгрузку", true);
  }
  setStatus(`Задача запущена: ${response.total} документ(ов).`);
  pollProgress();
}

async function init() {
  document.title = `План выгрузки · ${plannerVariant.browserLabel}`;
  els.variantLabel.textContent = `${plannerVariant.browserLabel} · ${extensionVersionLabel()}`;
  const response = await sendMessage({ type: "GET_PLANNER_CONTEXT" });
  if (!response.ok) throw new Error(response.error || "Не удалось загрузить planner");
  profileState = response.profileState;
  historyState = response.history;
  collection = response.collection;
  sourceItems = collection?.items || [];
  selectedSourceIndexes = new Set(
    sourceItems.map((item, offset) => Number(item.sourceIndex ?? item.index) || offset + 1)
  );
  els.collectionSummary.textContent = collectionLabel(collection);
  els.historyMode.value = response.historyMode;
  els.historyMode.dataset.previous = response.historyMode;
  renderProfileOptions(profileState.selectedProfileId);
  renderHistory();
  renderProgress(response.progress, response.running);
  if (response.running) pollProgress();
  updatePlanNow();
}

els.profileSelect.addEventListener("change", async () => {
  if (els.profileSelect.value === "__retry_snapshot__") {
    loadProfileFields(retryProfileSnapshot);
    return;
  }
  const response = await sendMessage({
    type: "SELECT_EXPORT_PROFILE",
    profileId: els.profileSelect.value,
  });
  if (response.ok) profileState = response.profileState;
  loadProfileFields(activeProfile());
});
for (const input of [els.profileName, els.format, els.filenameTemplate, els.folderTemplate]) {
  input.addEventListener("input", schedulePlanUpdate);
  input.addEventListener("change", schedulePlanUpdate);
}
els.saveProfile.addEventListener("click", () => saveCurrentProfile());
els.newProfile.addEventListener("click", () => createProfile(false));
els.duplicateProfile.addEventListener("click", () => createProfile(true));
els.deleteProfile.addEventListener("click", deleteProfile);
els.selectAll.addEventListener("click", () => {
  selectedSourceIndexes = new Set(
    sourceItems.map((item, offset) => Number(item.sourceIndex ?? item.index) || offset + 1)
  );
  updatePlan();
});
els.selectNone.addEventListener("click", () => {
  selectedSourceIndexes.clear();
  updatePlan();
});
els.documentRows.addEventListener("change", (event) => {
  const checkbox = event.target.closest("input[type='checkbox'][data-source-index]");
  if (!checkbox) return;
  const sourceIndex = Number(checkbox.dataset.sourceIndex);
  if (checkbox.checked) selectedSourceIndexes.add(sourceIndex);
  else selectedSourceIndexes.delete(sourceIndex);
  updatePlan();
});
els.historyMode.addEventListener("change", updateHistoryMode);
els.historyList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-history-action]");
  if (!button) return;
  const record = historyState.records.find((entry) => entry.id === button.dataset.historyId);
  if (button.dataset.historyAction === "retry-all") return prepareRetry(record, false);
  if (button.dataset.historyAction === "retry-errors") return prepareRetry(record, true);
  if (button.dataset.historyAction === "delete") {
    if (!confirm("Удалить эту запись локальной истории? Скачанные файлы останутся.")) return;
    const response = await sendMessage({ type: "DELETE_HISTORY_RECORD", id: record?.id });
    if (response.ok) {
      historyState = response.history;
      renderHistory();
    }
  }
});
els.historyList.addEventListener("toggle", (event) => {
  const details = event.target.closest("details[data-history-details-id]");
  if (!details?.open) return;
  const record = historyState.records.find(
    (entry) => entry.id === details.dataset.historyDetailsId
  );
  if (record?.mode === "detailed" && Array.isArray(record.items)) {
    renderDetailedHistory(details, record);
  }
}, true);
els.clearHistory.addEventListener("click", async () => {
  if (!confirm("Очистить всю локальную историю? Скачанные документы и отчёты останутся.")) return;
  const response = await sendMessage({ type: "CLEAR_HISTORY" });
  if (response.ok) {
    historyState = response.history;
    renderHistory();
  }
});
els.startExport.addEventListener("click", () => startExport().catch((error) => {
  running = false;
  renderPlan();
  setStatus(error.message, true);
}));

init().catch((error) => setStatus(error?.message || error, true));
