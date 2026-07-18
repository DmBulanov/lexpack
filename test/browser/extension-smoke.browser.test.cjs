const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");

const extensionPath = path.resolve(__dirname, "../../extension");

test("unpacked MV3 extension starts its service worker in Chromium", async (t) => {
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
  assert.equal(manifest.version, "0.6.0");
  assert.equal(manifest.minimum_chrome_version, "120");
  assert.deepEqual(
    [...manifest.host_permissions].sort(),
    ["https://*.consultant.ru/*", "https://consultant.ru/*"]
  );

  const popupErrors = [];
  const popup = await context.newPage();
  popup.on("pageerror", (error) => popupErrors.push(String(error)));
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popup.locator("#btnFind").waitFor();
  await popup.waitForFunction(() => document.querySelector("#adapterName")?.textContent !== "—");
  assert.equal(await popup.locator("#maxItems").inputValue(), "50");
  assert.equal(await popup.locator("#rememberQuery").isChecked(), false);
  assert.deepEqual(popupErrors, []);
});
