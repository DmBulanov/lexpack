const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");

const extensionPath = path.resolve(__dirname, "../../build/chrome");
const LIST_URL =
  "https://online.consultant.ru/riv/cgi/online.cgi?page=list&cacheid=manual";

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function manualPage({ label, root = "Судебная практика", total = 14, structure = "levels" }) {
  const otherRoot = root === "Судебная практика" ? "Российское законодательство" : "Судебная практика";
  const rootRow = `<span class="x-page-search-tree-item__name">${escapeHtml(root)}</span>`;
  const currentRow = label
    ? `<div class="x-page-search-tree-item x-page-search-tree-item--current" ${structure === "levels" ? 'aria-level="2"' : ""}><span class="x-page-search-tree-item__name">${escapeHtml(label)}</span></div>`
    : "";
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Ручная подборка</title></head><body>
    ${structure === "no-sidebar" ? "" : `<aside>
      <div class="x-page-search-tree-item" aria-level="1"><span class="x-page-search-tree-item__name">${escapeHtml(otherRoot)}</span></div>
      <div class="x-page-search-tree-item x-page-search-tree-item--no-select ${label ? "" : "x-page-search-tree-item--current"}" ${structure === "levels" ? 'aria-level="1"' : ""}>
        ${rootRow}${structure === "nested" ? currentRow : ""}
      </div>
      ${structure === "nested" ? "" : currentRow}
    </aside>`}
    ${["breadcrumbs", "no-sidebar"].includes(structure) ? `<div class="x-page-search-breadcrumbs"><span>${escapeHtml(root)}</span> › <span>${escapeHtml(label)}</span></div>` : ""}
    <div class="x-page-search-results-header__name">${escapeHtml(label)}</div>
    <div class="x-page-search-results-header__counter">[1:${total}]</div>
    <div class="x-list x-page-search-results__list">
      ${Array.from({ length: total }, (_, index) => `<a class="x-page-components-search-result-item__extra-title" href="?req=doc&base=ARB&n=${index + 1}"><div class="TH">Документ ${index + 1}</div></a>`).join("")}
    </div>
    </body></html>`;
}

test("manually opened judicial collections use page context instead of automatic navigation keys", async (t) => {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lexpack-manual-category-"));
  let context;
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
  const extensionId = new URL(worker.url()).hostname;
  let fixture;
  await context.route("https://online.consultant.ru/**", (route) =>
    route.fulfill({ contentType: "text/html; charset=utf-8", body: manualPage(fixture) })
  );
  const page = await context.newPage();
  let popup = await context.newPage();

  async function openCollection(options, expectedCount, navigate = true) {
    fixture = options;
    if (navigate) await page.goto(LIST_URL);
    await page.locator(".x-page-search-results__list").waitFor();
    await page.bringToFront();
    if (popup.isClosed()) popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await page.bringToFront();
    await popup.reload();
    if (expectedCount !== undefined) {
      await popup.waitForFunction(
        ({ label, count }) => document.querySelector("#progressText")?.textContent?.includes(`${label}: собрано ${count}`),
        { label: options.label, count: expectedCount },
        { timeout: 15000 }
      );
    } else {
      await popup.waitForFunction(
        () => document.querySelector("#foundSummary")?.textContent?.includes("Выберите слева"),
        undefined,
        { timeout: 10000 }
      );
    }
    return worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: ["https://online.consultant.ru/*"] });
      const ping = await chrome.tabs.sendMessage(tab.id, { type: "PING" });
      const cached = (await chrome.storage.session.get("searchCollection")).searchCollection;
      return { ping, cached };
    });
  }

  async function assertReady(options, expectedKey = null, navigate = true) {
    const count = options.total || 14;
    const { ping, cached } = await openCollection(options, count, navigate);
    assert.equal(ping.page, "list");
    assert.equal(ping.capabilities.documentReady, false);
    assert.equal(ping.category.key, expectedKey);
    assert.equal(ping.category.selected, true);
    assert.equal(ping.category.judicial, true);
    assert.equal(await popup.locator("#btnExport").isEnabled(), true);
    assert.equal(await popup.locator("#btnExport").innerText(), `Настроить выгрузку · ${count}`);
    assert.ok((await popup.locator("#foundSummary").innerText()).includes(options.label));
    assert.equal(cached.items.length, count);
    assert.ok(cached.items.every((item) => item.instance === expectedKey && item.instanceLabel === options.label));
    return { ping, cached };
  }

  await t.test("3 кассационный суд with 14 documents is available in popup and planner", async () => {
    await assertReady({ label: "3 кассационный суд", total: 14, structure: "breadcrumbs" });
    const plannerPromise = context.waitForEvent("page");
    await popup.locator("#btnExport").click();
    const planner = await plannerPromise;
    await planner.locator("#documentRows tr").nth(13).waitFor();
    assert.equal(await planner.locator("#documentRows tr").count(), 14);
    assert.equal(await planner.locator("#startExport").isEnabled(), true);
    assert.equal(await planner.locator("#documentRows tr").first().locator("td").nth(4).innerText(), "3 кассационный суд");
    await planner.close();
  });

  await t.test("an unknown judicial branch is accepted through nested tree ancestry", async () => {
    await assertReady({ label: "Акты специализированной коллегии", total: 3, structure: "nested" });
  });

  await t.test("an unknown judicial branch is accepted through flat tree levels", async () => {
    await assertReady({ label: "Акты новой коллегии", total: 2 });
  });

  await t.test("an unknown judicial branch is accepted through breadcrumbs", async () => {
    await assertReady({ label: "Материалы специального состава", total: 2, structure: "breadcrumbs" });
  });

  await t.test("a collapsed sidebar does not block a stable judicial header and breadcrumbs", async () => {
    const { cached } = await assertReady({ label: "Акты новой палаты", total: 2, structure: "no-sidebar" });
    assert.ok(cached.collectionIdentity.contextSignature);
  });

  await t.test("two unknown category labels cannot restore one another's cached collection", async () => {
    const first = await assertReady({ label: "Акты коллегии А", total: 2 });
    await page.evaluate(() => {
      document.querySelector(".x-page-search-results-header__name").textContent = "Акты коллегии Б";
      document.querySelector(".x-page-search-tree-item--current .x-page-search-tree-item__name").textContent = "Акты коллегии Б";
    });
    const second = await assertReady({ label: "Акты коллегии Б", total: 2 }, null, false);
    assert.equal(first.cached.collectionIdentity.documentId, second.cached.collectionIdentity.documentId);
    assert.notEqual(first.cached.collectionIdentity.contextSignature, second.cached.collectionIdentity.contextSignature);
    assert.ok(second.cached.items.every((item) => item.instanceLabel === "Акты коллегии Б"));
  });

  await t.test("changing the judicial context during collection aborts even with an unchanged label", async () => {
    await assertReady({ label: "Акты коллегии", total: 2 });
    await page.evaluate(() => {
      const list = document.querySelector(".x-page-search-results__list");
      list.style.height = "20px";
      list.style.overflowY = "auto";
      list.addEventListener("scroll", () => {
        document.querySelector(".x-page-search-tree-item--no-select .x-page-search-tree-item__name").textContent = "Российское законодательство";
      }, { once: true });
    });
    const response = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: ["https://online.consultant.ru/*"] });
      return chrome.tabs.sendMessage(tab.id, {
        type: "COLLECT_LIST", allResults: true, maxItems: 200, category: "Акты коллегии",
      });
    });
    assert.equal(response.ok, false);
    assert.equal(response.code, "COLLECTION_STATE_CHANGED");
  });

  await t.test("no selected category shows the selection hint even when documents exist", async () => {
    const { ping } = await openCollection({ label: "", total: 14 });
    assert.equal(ping.category.selected, false);
    assert.equal(await popup.locator("#btnExport").isVisible(), false);
    assert.match(await popup.locator("#foundSummary").innerText(), /Выберите слева суд или судебную категорию/);
  });

  await t.test("a legislative branch is not judicial merely because another tree branch is judicial", async () => {
    const { ping } = await openCollection({ label: "Комментарии решений судов", root: "Российское законодательство", total: 14 });
    assert.equal(ping.category.selected, true);
    assert.equal(ping.category.judicial, false);
    assert.equal(await popup.locator("#btnExport").isVisible(), false);
    assert.match(await popup.locator("#foundSummary").innerText(), /Комментарии решений судов[\s\S]*Выберите слева/);
  });

  for (const [key, label] of [
    ["higher-courts", "Решения высших судов"],
    ["arbitration-circuit", "Арбитражные суды округов"],
    ["arbitration-first", "Арбитражные суды первой инстанции"],
    ["arbitration-rulings", "Определения арбитражных судов"],
  ]) {
    await t.test(`${label} retains its automatic key and manual export`, async () => {
      await assertReady({ label, total: 2 }, key);
    });
  }
});
