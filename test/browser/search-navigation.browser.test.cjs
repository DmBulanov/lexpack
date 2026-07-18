const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");

const extensionPath = path.resolve(__dirname, "../../extension");
const SEARCH_QUERY = "навигационная регрессия";
const expectedSearchUrl = new URL("https://online.consultant.ru/riv/cgi/online.cgi");
expectedSearchUrl.searchParams.set("req", "card");
expectedSearchUrl.searchParams.set("page", "splus");
expectedSearchUrl.searchParams.set("splusFind", SEARCH_QUERY);
expectedSearchUrl.hash = "splus";
const SEARCH_URL = expectedSearchUrl.href;
const SEARCH_REQUEST_URL = SEARCH_URL.replace("#splus", "");
const FULL_RESULTS_URL =
  "https://online.consultant.ru/riv/cgi/online.cgi?req=query&mode=fullsplus&cacheid=fixture";

function escapeAttribute(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function quickPageHtml({ scope, query }) {
  const isPractice = scope === "practice";
  const title = isPractice ? "POST-SCOPE краткая практика" : "PRE-SCOPE все документы";
  const activeAll = isPractice ? "" : " x-page-search-plus-presets__preset--active";
  const activePractice = isPractice ? " x-page-search-plus-presets__preset--active" : "";
  return `<!doctype html>
    <meta charset="utf-8">
    <title>Синтетический быстрый поиск</title>
    <input class="x-page-components-search-panel__filter" value="${escapeAttribute(query)}">
    <button type="button">Найти</button>
    <div class="x-page-search-plus-presets">
      <button class="x-page-search-plus-presets__preset${activeAll}" data-preset="1">Все документы</button>
      <button class="x-page-search-plus-presets__preset${activePractice}" data-preset="2">Судебная практика</button>
    </div>
    <main class="x-page-search-plus-results">
      <a class="x-page-components-search-result-item__extra-title" href="?req=doc&base=LAW&n=99">${title}</a>
      <a class="x-pages-search-plus-results-link" target="_blank" href="${FULL_RESULTS_URL}">
        Все результаты поиска
      </a>
    </main>
    <script>
      document.querySelector('[data-preset="2"]').addEventListener("click", () => {
        window.name = "cons-export-scope-click";
        location.reload();
      });
    </script>`;
}

function fullResultsPageHtml(query) {
  const groups = {
    law: [
      { base: "LAW", n: "10", title: "НЕ СУДЕБНЫЙ результат законодательства" },
    ],
    "higher-courts": [
      { base: "ARB", n: "1", title: "Определение Верховного Суда" },
      { base: "AMS", n: "2", title: "Общий судебный акт" },
    ],
    "arbitration-circuit": [
      { base: "AMS", n: "2", title: "Общий судебный акт" },
      { base: "AMS", n: "3", title: "Постановление окружного суда 1" },
      { base: "AMS", n: "4", title: "Постановление окружного суда 2" },
    ],
  };
  return `<!doctype html>
    <meta charset="utf-8">
    <title>Полная сгруппированная выдача</title>
    <div class="x-page-search-title__value"><div class="x-ellipsis__content">"${query}"</div></div>
    <aside>
      <div class="x-page-search-tree-item x-page-search-tree-item--current" data-index="0">
        <span class="x-page-search-tree-item__name">Российское законодательство</span>
      </div>
      <div class="x-page-search-tree-item x-page-search-tree-item--no-select" data-index="1">
        <span data-expanded="1"></span><span class="x-page-search-tree-item__name">Судебная практика</span>
      </div>
      <div class="x-page-search-tree-item" data-index="2" data-category="higher-courts">
        <span class="x-page-search-tree-item__name">Решения высших судов</span>
        <span class="x-page-search-tree-item-count">2</span>
      </div>
      <div class="x-page-search-tree-item x-page-search-tree-item--no-select" data-index="3">
        <span data-expanded="1"></span><span class="x-page-search-tree-item__name">Арбитражные суды</span>
      </div>
      <div class="x-page-search-tree-item" data-index="4" data-category="arbitration-circuit">
        <span class="x-page-search-tree-item__name">Арбитражные суды округов</span>
        <span class="x-page-search-tree-item-count">3</span>
      </div>
    </aside>
    <div class="x-page-search-results-header__name"></div>
    <div class="x-page-search-results-header__counter"></div>
    <div class="x-list x-page-search-results__list" style="height:120px;overflow:auto"></div>
    <script>
      const groups = ${JSON.stringify(groups)};
      const labels = {
        law: "Российское законодательство",
        "higher-courts": "Решения высших судов",
        "arbitration-circuit": "Арбитражные суды округов",
      };
      function activate(key) {
        document.querySelectorAll('.x-page-search-tree-item').forEach((row) => {
          row.classList.toggle('x-page-search-tree-item--current', row.dataset.category === key || (key === 'law' && row.dataset.index === '0'));
        });
        document.querySelector('.x-page-search-results-header__name').textContent = labels[key];
        document.querySelector('.x-page-search-results-header__counter').textContent = '[1:' + groups[key].length + ']';
      }
      function renderItems(key) {
        document.querySelector('.x-page-search-results__list').innerHTML = groups[key].map((item) =>
          '<a class="x-page-components-search-result-item__extra-title" href="?req=doc&base=' + item.base + '&n=' + item.n + '"><div class="TH">' + item.title + '</div></a>'
        ).join('');
      }
      document.querySelectorAll('[data-category]').forEach((row) => {
        row.addEventListener('click', () => {
          activate(row.dataset.category);
          setTimeout(() => renderItems(row.dataset.category), 1200);
        });
      });
      activate('law');
      renderItems('law');
    </script>`;
}

function virtualCurrentCategoryHtml(query, total = 65) {
  const items = Array.from({ length: total }, (_, index) => ({
    base: "ACM",
    n: String(index + 1),
    title: `Решение первой инстанции ${index + 1}`,
  }));
  return `<!doctype html>
    <meta charset="utf-8">
    <title>Открытая пользователем категория</title>
    <div class="x-page-search-title__value"><div class="x-ellipsis__content">"${query}"</div></div>
    <div class="x-page-search-tree-item x-page-search-tree-item--no-select" data-index="0">
      <span data-expanded="1"></span><span class="x-page-search-tree-item__name">Судебная практика</span>
    </div>
    <div class="x-page-search-tree-item x-page-search-tree-item--no-select" data-index="1">
      <span data-expanded="1"></span><span class="x-page-search-tree-item__name">Арбитражные суды</span>
    </div>
    <div class="x-page-search-tree-item x-page-search-tree-item--current" data-index="2">
      <span class="x-page-search-tree-item__name">Арбитражные суды первой инстанции</span>
      <span class="x-page-search-tree-item-count">${total}</span>
    </div>
    <div class="x-page-search-results-header__name">Арбитражные суды первой инстанции</div>
    <div class="x-page-search-results-header__counter">[1:${total}]</div>
    <div class="x-list x-page-search-results__list" style="height:140px;overflow-y:auto;position:relative">
      <div class="x-list__inner" style="height:${total * 52}px;position:relative"></div>
    </div>
    <script>
      const items = ${JSON.stringify(items)};
      const list = document.querySelector('.x-page-search-results__list');
      const inner = list.querySelector('.x-list__inner');
      let renderTimer = null;
      function renderWindow() {
        const start = Math.max(0, Math.floor(list.scrollTop / 52) - 2);
        const end = Math.min(items.length, start + Math.ceil(list.clientHeight / 52) + 2);
        inner.innerHTML = items.slice(start, end).map((item, offset) => {
          const index = start + offset;
          return '<a class="x-page-components-search-result-item__extra-title" ' +
            'style="position:absolute;left:0;right:0;top:' + (index * 52) + 'px;height:50px" ' +
            'href="?req=doc&base=' + item.base + '&n=' + item.n + '">' +
            '<div class="TH">' + item.title + '</div></a>';
        }).join('');
      }
      list.addEventListener('scroll', () => {
        clearTimeout(renderTimer);
        renderTimer = setTimeout(renderWindow, 260);
      });
      renderWindow();
    </script>`;
}

test("online all-scope still opens full results and deduplicates selected instances", async (t) => {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cons-export-search-flow-"));
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

  const requests = [];
  await context.route("https://online.consultant.ru/**", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.href);
    if (url.searchParams.get("req") === "query") {
      await route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: fullResultsPageHtml(SEARCH_QUERY),
      });
      return;
    }
    const query = url.searchParams.get("splusFind") || "";
    const searchLoads = requests.filter((entry) => {
      const candidate = new URL(entry);
      return candidate.searchParams.get("splusFind") === SEARCH_QUERY;
    }).length;
    await route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: quickPageHtml({
        query,
        scope: query === SEARCH_QUERY && searchLoads > 1 ? "practice" : "all",
      }),
    });
  });

  const consultant = await context.newPage();
  await consultant.goto("https://online.consultant.ru/riv/cgi/online.cgi?req=home");
  await consultant.locator(".x-page-components-search-panel__filter").waitFor();

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popup.locator("#btnFind").waitFor();
  await popup.locator("#query").fill(SEARCH_QUERY);
  await popup.locator("#scope").selectOption("all");
  await popup.locator("#maxItems").fill("3");
  await popup.locator("#btnFind").click();

  try {
    await popup.waitForFunction(() => {
      const progress = document.querySelector("#progressText")?.textContent || "";
      return /^найдено:\s*3\b/.test(progress);
    }, undefined, { timeout: 15000 });
  } catch (error) {
    const state = await popup.evaluate(() => ({
      progress: document.querySelector("#progressText")?.textContent,
      log: document.querySelector("#log")?.textContent,
    }));
    const browserTabs = await worker.evaluate(async () =>
      (await chrome.tabs.query({})).map((tab) => ({
        id: tab.id,
        openerTabId: tab.openerTabId,
        windowId: tab.windowId,
        status: tab.status,
        url: tab.url,
      }))
    );
    const pageStates = await Promise.all(
      context.pages().map(async (page) => ({
        url: page.url(),
        title: await page.title(),
      }))
    );
    error.message += `; popup state: ${JSON.stringify(state)}; requests: ${requests.length}; tabs: ${JSON.stringify(browserTabs)}; pages: ${JSON.stringify(pageStates)}`;
    throw error;
  }

  const resultLog = await popup.locator("#log").textContent();
  assert.match(resultLog, /Определение Верховного Суда/);
  assert.match(resultLog, /Постановление окружного суда 1/);
  assert.doesNotMatch(resultLog, /Постановление окружного суда 2/);
  assert.doesNotMatch(resultLog, /НЕ СУДЕБНЫЙ|краткая практика|PRE-SCOPE/);

  const searchRequests = requests.filter((entry) =>
    new URL(entry).searchParams.get("splusFind") === SEARCH_QUERY
  );
  assert.equal(searchRequests.length, 1);
  assert.equal(searchRequests[0], SEARCH_REQUEST_URL);

  const fullPages = context.pages().filter((page) =>
    page.url().includes("req=query")
  );
  assert.equal(fullPages.length, 1, "«Все результаты поиска» must open exactly one tab");
  assert.match(
    await fullPages[0].locator(".x-page-search-results-header__name").textContent(),
    /Арбитражные суды округов/
  );
  assert.equal(await consultant.evaluate(() => window.name), "");
  assert.equal(consultant.url(), SEARCH_URL);
});

test("manual collection harvests the whole virtualized category selected by the user", async (t) => {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cons-export-current-list-"));
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
  await context.route("https://online.consultant.ru/**", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: virtualCurrentCategoryHtml(SEARCH_QUERY),
    })
  );
  const page = await context.newPage();
  await page.goto(FULL_RESULTS_URL);
  await page.locator(".x-page-search-results__list").waitFor();

  const collect = (maxItems) =>
    worker.evaluate(async ({ query, maxItems }) => {
      const [tab] = await chrome.tabs.query({ url: ["https://online.consultant.ru/*"] });
      let lastError = null;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
          return await chrome.tabs.sendMessage(tab.id, {
            type: "COLLECT_LIST",
            allResults: true,
            maxItems,
            query,
          });
        } catch (error) {
          lastError = String(error?.message || error);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      throw new Error(lastError || "content script unavailable");
    }, { query: SEARCH_QUERY, maxItems });

  const response = await collect(100);

  assert.equal(response.ok, true);
  assert.equal(response.count, 65);
  assert.equal(response.query, SEARCH_QUERY);
  assert.equal(response.category.key, "arbitration-first");
  assert.equal(response.categoryTotal, 65);
  assert.equal(response.categoryTotalKnown, true);
  assert.equal(response.truncated, false);
  assert.equal(response.incomplete, false);
  assert.equal(response.items[0].title, "Решение первой инстанции 1");
  assert.equal(response.items.at(-1).title, "Решение первой инстанции 65");
  assert.equal(new Set(response.items.map((item) => item.url)).size, 65);
  assert.equal(await page.locator(".x-page-search-results__list").evaluate((node) => node.scrollTop), 0);

  const limited = await collect(50);
  assert.equal(limited.ok, true);
  assert.equal(limited.count, 50);
  assert.equal(limited.categoryTotal, 65);
  assert.equal(limited.truncated, true);
  assert.equal(limited.truncatedByLimit, true);
  assert.equal(limited.incomplete, false);
  assert.equal(await page.locator(".x-page-search-results__list").evaluate((node) => node.scrollTop), 0);
});
