const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");

const variants = ["chrome", "chromium-gost"].map((id) => ({
  id,
  config: require(path.resolve(__dirname, `../../variants/${id}/config.json`)),
}));

for (const variant of variants) {
test(`unpacked ${variant.id} MV3 extension starts its service worker in Chromium`, async (t) => {
  const extensionPath = path.resolve(__dirname, `../../build/${variant.id}`);
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cons-export-browser-"));
  let context = null;
  t.after(async () => {
    await context?.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  let [worker] = context.serviceWorkers();
  worker ||= await context.waitForEvent("serviceworker", { timeout: 15000 });
  assert.match(worker.url(), /^chrome-extension:\/\/.+\/background\/service-worker\.js$/);
  const extensionId = new URL(worker.url()).hostname;

  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, variant.config.manifest.version);
  assert.equal(manifest.version_name, variant.config.manifest.versionName);
  assert.equal(manifest.name, variant.config.manifest.name);
  assert.equal(
    manifest.minimum_chrome_version,
    variant.config.manifest.minimumChromeVersion
  );
  assert.equal(manifest.icons["32"], "icons/icon32.png");
  assert.equal(manifest.action.default_icon["32"], "icons/icon32.png");
  assert.deepEqual(
    [...manifest.host_permissions].sort(),
    ["https://*.consultant.ru/*", "https://consultant.ru/*"]
  );
  const runtimeVariant = await worker.evaluate(() =>
    JSON.parse(JSON.stringify(globalThis.LEXPACK_VARIANT))
  );
  assert.equal(runtimeVariant.id, variant.id);
  assert.equal(runtimeVariant.browserLabel, variant.config.browserLabel);
  assert.deepEqual(runtimeVariant.nativeDownloads, variant.config.nativeDownloads);
  const acceptsGostLateWindow = await worker.evaluate(() => {
    const triggerAt = Date.parse("2026-07-20T10:00:00.000Z");
    return consMatchesNativeDownload(
      {
        startTime: new Date(triggerAt + 37500).toISOString(),
        filename: "/Downloads/document.docx",
        url: "blob:https://online.consultant.ru/download-id",
        referrer:
          "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=ASMS&n=42",
      },
      {
        downloadKind: "native",
        downloadStartedAt: triggerAt,
        expectedFilename: "01 - document.docx",
        sourceUrl:
          "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=ASMS&n=42",
      }
    );
  });
  assert.equal(
    acceptsGostLateWindow,
    variant.config.nativeDownloads.matchWindowMs >= 37500
  );

  const popupErrors = [];
  const popup = await context.newPage();
  popup.on("pageerror", (error) => popupErrors.push(String(error)));
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popup.locator("#searchSummary").waitFor();
  await popup.waitForFunction(
    () =>
      document.querySelector("#pageMeta")?.textContent !==
      "Найдите практику и скачайте документы"
  );
  assert.equal(await popup.locator(".brand").innerText(), variant.config.popup.brand);
  assert.equal(await popup.title(), variant.config.popup.title);
  assert.equal(
    await popup.locator("#extensionVersion").textContent(),
    variant.config.manifest.versionName
  );
  assert.equal(await popup.locator("#resultActions").isVisible(), false);
  assert.equal(await popup.locator("#searchPanel").getAttribute("open"), null);
  assert.equal(await popup.locator("#searchSummary").innerText(), "Найти практику");
  assert.equal(await popup.locator("#query").isVisible(), false);
  await popup.locator("#searchSummary").click();
  assert.equal(await popup.locator("#query").isVisible(), true);
  assert.equal(await popup.locator(".info-popover:visible").count(), 0);
  assert.match(
    await popup.locator("#limitInfo").textContent(),
    /автоматически выбраны[\s\S]*не\s+более 200/
  );
  await popup.locator('[data-info-target="searchInfo"]').click();
  await popup.locator('[data-info-target="scopeInfo"]').click();
  assert.equal(await popup.locator("#searchInfo").isVisible(), false);
  assert.equal(await popup.locator("#scopeInfo").isVisible(), true);
  await popup.keyboard.press("Escape");
  assert.equal(await popup.locator("#btnFind").innerText(), "Найти");
  assert.equal(await popup.locator("#btnFindSave").count(), 0);
  assert.equal(await popup.locator("#btnScan").count(), 0);
  assert.equal(await popup.locator("#stats").count(), 0);
  assert.equal(await popup.locator("#rememberQuery").count(), 0);
  assert.equal(await popup.locator("#downloadFolder").inputValue(), "LexPack");
  assert.match(
    await popup.locator('label[for="downloadFolder"]').innerText(),
    /Подпапка для документов и отчёта/i
  );
  await popup.locator('[data-info-target="folderInfo"]').click();
  assert.match(await popup.locator("#folderInfo").innerText(), /можно открыть в Блокноте/);
  assert.equal(await popup.locator("#btnOpenDownloadsSettings").isVisible(), true);
  await popup.keyboard.press("Escape");
  assert.equal(await popup.getByText("Можно выбрать несколько:", { exact: false }).count(), 0);

  await worker.evaluate(async () => {
    await chrome.storage.local.set({ downloadFolder: "ConsExport" });
    await chrome.storage.local.remove("settingsSchemaVersion");
  });
  await popup.reload();
  await popup.waitForFunction(
    () => document.querySelector("#downloadFolder")?.value === "LexPack"
  );
  const migratedSettings = await worker.evaluate(async () =>
    chrome.storage.local.get(["downloadFolder", "settingsSchemaVersion"])
  );
  assert.deepEqual(migratedSettings, {
    downloadFolder: "LexPack",
    settingsSchemaVersion: 2,
  });

  await worker.evaluate(async () => {
    await chrome.storage.session.set({
      exportJob: {
        id: "successful-smoke-job",
        status: "done",
        phase: "finished",
        items: Array.from({ length: 5 }, () => ({ status: "completed" })),
        log: [],
      },
    });
  });
  await popup.reload();
  await popup.waitForFunction(
    () => document.querySelector("#progressText")?.textContent === "готово: 5/5"
  );
  assert.equal(await popup.locator("#progressText").innerText(), "готово: 5/5");
  assert.equal(await popup.locator("#progressInfoControl").isVisible(), false);

  await worker.evaluate(async () => {
    await chrome.storage.session.set({
      exportJob: {
        id: "exceptional-smoke-job",
        status: "done",
        phase: "finished",
        items: [
          ...Array.from({ length: 4 }, () => ({ status: "completed" })),
          { status: "unconfirmed" },
        ],
        log: [],
      },
    });
  });
  await popup.reload();
  await popup.waitForFunction(
    () => document.querySelector("#progressText")?.textContent?.includes("требует проверки 1")
  );
  assert.equal(
    await popup.locator("#progressText").innerText(),
    "готово: 5/5; успешно 4, требует проверки 1"
  );
  assert.equal(await popup.locator("#progressInfoControl").isVisible(), true);
  await popup.locator('[data-info-target="progressInfo"]').click();
  assert.match(await popup.locator("#progressInfo").innerText(), /проверьте файл/);
  await popup.keyboard.press("Escape");

  await worker.evaluate(async () => {
    await chrome.storage.local.set({
      lastQuery: "временный запрос",
      lastScope: "all",
      lastFormat: "pdf",
      downloadFolder: "TemporaryFolder",
      rememberQuery: true,
      maxItems: 17,
      lastInstances: ["arbitration-first"],
    });
  });
  await popup.reload();
  await popup.waitForFunction(
    () => document.querySelector("#downloadFolder")?.value === "TemporaryFolder"
  );
  assert.equal(await popup.locator("#query").inputValue(), "");
  const removedLegacyQuery = await worker.evaluate(async () =>
    chrome.storage.local.get(["lastQuery", "rememberQuery"])
  );
  assert.deepEqual(removedLegacyQuery, {});
  await popup.locator("details.online-tools").evaluate((element) => {
    element.open = true;
  });
  assert.equal(
    await popup.locator("#btnClearData").innerText(),
    "Сбросить настройки и историю"
  );
  popup.once("dialog", (dialog) => dialog.accept());
  await popup.locator("#btnClearData").click();
  await popup.waitForFunction(
    () => document.querySelector("#downloadFolder")?.value === "LexPack"
  );
  assert.equal(await popup.locator("#query").inputValue(), "");
  assert.equal(await popup.locator("#rememberQuery").count(), 0);
  assert.equal(await popup.locator("#resultActions").isVisible(), false);
  assert.equal(await popup.locator("#scope").inputValue(), "practice");
  assert.equal(await popup.locator("#format").inputValue(), "docx");
  assert.equal(
    await popup.locator('input[name="instance"][value="higher-courts"]').isChecked(),
    true
  );
  assert.equal(
    await popup.locator('input[name="instance"][value="arbitration-circuit"]').isChecked(),
    true
  );
  const remainingSettings = await worker.evaluate(async () => chrome.storage.local.get(null));
  for (const key of [
    "lastQuery",
    "lastScope",
    "lastFormat",
    "downloadFolder",
    "rememberQuery",
    "maxItems",
    "lastInstances",
    "settingsSchemaVersion",
  ]) {
    assert.equal(remainingSettings[key], undefined);
  }
  assert.deepEqual(popupErrors, []);
});
}
