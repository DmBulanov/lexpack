const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");

const NOW = "2026-07-21T10:00:00.000Z";

function profile(id, name, overrides = {}) {
  return {
    schemaVersion: 1,
    id,
    name,
    format: "docx",
    filenameTemplate: "{index} - {title}",
    folderTemplate: "LexPack",
    collisionPolicy: "ordered-suffix",
    builtIn: id === "default",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function sourceItem(index, title, instanceLabel = "Кассация") {
  return {
    index,
    sourceIndex: index,
    title,
    instance: "arbitration-circuit",
    instanceLabel,
    url:
      `https://online.consultant.ru/riv/cgi/online.cgi?` +
      `req=doc&base=ARB&n=${index}`,
  };
}

test("planner previews arbitrary selection, profiles, history retry, and immutable launch", async (t) => {
  const extensionPath = path.resolve(__dirname, "../../build/chrome");
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lexpack-planner-"));
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
  await context.route("https://online.consultant.ru/**", (route) => route.abort());

  let [worker] = context.serviceWorkers();
  worker ||= await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extensionId = new URL(worker.url()).hostname;
  const items = [
    sourceItem(1, "Постановление по делу А40-1/2025"),
    sourceItem(2, "Решение от 14.03.2025 по делу А40-2/2025"),
    sourceItem(3, "Определение по делу А40-3/2025"),
    sourceItem(4, "Решение от 15.03.2025 по делу А40-4/2025"),
    sourceItem(5, "Решение по делу А40-5/2025"),
  ];

  await worker.evaluate(async ({ items: seededItems, now }) => {
    const defaultProfile = {
      schemaVersion: 1,
      id: "default",
      name: "По умолчанию",
      format: "docx",
      filenameTemplate: "{index} - {title}",
      folderTemplate: "LexPack",
      collisionPolicy: "ordered-suffix",
      builtIn: true,
      createdAt: now,
      updatedAt: now,
    };
    const customProfile = {
      ...defaultProfile,
      id: "court-profile",
      name: "По делам",
      format: "pdf",
      filenameTemplate: "{date}_{case}_{documentType}",
      folderTemplate: "LexPack/{query}/{instance}",
      builtIn: false,
    };
    await chrome.storage.local.set({
      exportProfileState: {
        schemaVersion: 1,
        selectedProfileId: "default",
        profiles: [defaultProfile, customProfile],
      },
      historyMode: "safe",
      exportHistory: {
        schemaVersion: 1,
        records: [
          {
            schemaVersion: 1,
            id: "safe-history",
            mode: "safe",
            startedAt: now,
            finishedAt: "2026-07-21T10:01:00.000Z",
            extensionVersion: "0.9.2-chrome",
            variant: "chrome",
            status: "done",
            format: "pdf",
            profileName: "Безопасный",
            selectedCount: 2,
            successful: 2,
            reviewRequired: 0,
            failed: 0,
            stopped: 0,
            reportFilename: "LexPack-report-20260721-100000Z.json",
          },
          {
            schemaVersion: 1,
            id: "detailed-history",
            mode: "detailed",
            startedAt: now,
            finishedAt: "2026-07-21T10:02:00.000Z",
            extensionVersion: "0.9.2-chrome",
            variant: "chrome",
            status: "done",
            format: "pdf",
            profileName: "Snapshot",
            selectedCount: 3,
            successful: 1,
            reviewRequired: 1,
            failed: 1,
            stopped: 0,
            reportFilename: "LexPack-report-20260721-100100Z.json",
            adapter: "online-app",
            query: "локальный подробный запрос",
            scope: "practice",
            profileSnapshot: customProfile,
            collection: { source: "search", total: 3, totalKnown: true },
            items: seededItems.slice(0, 3).map((item, offset) => ({
              exportIndex: offset + 1,
              sourceIndex: item.sourceIndex,
              originalTitle: item.title,
              metadata: {},
              instance: item.instance,
              instanceLabel: item.instanceLabel,
              safeSourceUrl: item.url,
              plannedRelativeFolder: "LexPack",
              plannedFilename: `${offset + 1}.pdf`,
              plannedRelativePath: `LexPack/${offset + 1}.pdf`,
              expectedFilename: `${offset + 1}.pdf`,
              actualFilename: offset === 0 ? `${offset + 1}.pdf` : null,
              attempts: 1,
              status: ["completed", "failed", "unconfirmed"][offset],
              error: offset === 1 ? "timeout" : null,
              warnings: [],
              cleanupRulesApplied: { folder: [], filename: [] },
              collisionResolution: { type: "none", internal: false, external: false },
            })),
          },
        ],
      },
    });
    await chrome.storage.session.set({
      searchCollection: {
        version: 1,
        status: "ready",
        source: "search",
        tabId: 1,
        adapter: "online-app",
        query: "аренда",
        categoryKey: "arbitration-circuit",
        scope: "practice",
        items: seededItems,
        total: 5,
        totalKnown: true,
        truncated: false,
        createdAt: now,
      },
    });
  }, { items, now: NOW });

  const pageErrors = [];
  const planner = await context.newPage();
  planner.on("pageerror", (error) => pageErrors.push(String(error)));
  await planner.goto(`chrome-extension://${extensionId}/planner/planner.html`);
  await planner.locator("#documentRows tr").nth(4).waitFor();
  assert.equal(await planner.locator("#documentRows tr").count(), 5);
  assert.match(await planner.locator("#selectedCount").innerText(), /5 из 5/);

  for (const index of [1, 3, 4]) {
    await planner.locator(`input[data-source-index="${index}"]`).uncheck();
  }
  await planner.locator("#selectedCount").getByText("Выбрано: 2 из 5").waitFor();
  const row2 = planner.locator("#documentRows tr").nth(1);
  const row5 = planner.locator("#documentRows tr").nth(4);
  assert.equal(await row2.locator("td").nth(1).innerText(), "01");
  assert.equal(await row2.locator("td").nth(2).innerText(), "2");
  assert.equal(await row5.locator("td").nth(1).innerText(), "02");
  assert.equal(await row5.locator("td").nth(2).innerText(), "5");

  await planner.locator("#profileSelect").selectOption("court-profile");
  await planner.waitForFunction(
    () => document.querySelector("#filenameTemplate")?.value === "{date}_{case}_{documentType}"
  );
  await planner.waitForFunction(
    () => document.querySelector("#documentRows tr:nth-child(2) td.path")?.textContent?.includes("LexPack/аренда/Кассация")
  );
  assert.match(await row2.locator("td.path").innerText(), /LexPack\/аренда\/Кассация\/2025-03-14_/);
  assert.match(await row5.locator("td.warning").innerText(), /Нет значения для \{date\}/);

  await planner.locator("#filenameTemplate").fill("{client}-{title}");
  await planner.waitForFunction(
    () => document.querySelector("#planErrors")?.textContent?.includes("Неизвестный токен")
  );
  assert.equal(await planner.locator("#startExport").isDisabled(), true);

  await planner.locator("#filenameTemplate").fill("Решение");
  await planner.locator("#folderTemplate").fill("LexPack/{query}/{instance}");
  await planner.waitForFunction(
    () => document.querySelector("#documentRows tr:nth-child(5) td.path")?.textContent?.endsWith("Решение (2).pdf")
  );
  assert.equal(await row2.locator("td.path").innerText(), "LexPack/аренда/Кассация/Решение.pdf");
  assert.equal(await row5.locator("td.path").innerText(), "LexPack/аренда/Кассация/Решение (2).pdf");

  const details = planner.locator("details.history-details");
  assert.equal(await details.count(), 1);
  await details.locator("summary").click();
  await details.getByText("Запрос: локальный подробный запрос", { exact: true }).waitFor();
  assert.match(await details.innerText(), /Источник: https:\/\/online\.consultant\.ru/);
  assert.equal(await planner.getByRole("button", { name: "Повторить всё" }).count(), 1);
  assert.equal(await planner.getByRole("button", { name: "Повторить ошибки" }).count(), 1);
  await planner.getByRole("button", { name: "Повторить ошибки" }).click();
  await planner.locator("#collectionSummary").getByText(/Повтор failed\/unconfirmed/).waitFor();
  assert.match(await planner.locator("#selectedCount").innerText(), /2 из 3/);
  assert.equal(await planner.locator("#profileSelect").inputValue(), "__retry_snapshot__");

  await planner.reload();
  await planner.locator("#documentRows tr").nth(4).waitFor();
  for (const index of [1, 3, 4]) {
    await planner.locator(`input[data-source-index="${index}"]`).uncheck();
  }
  await planner.locator("#profileSelect").selectOption("court-profile");
  await planner.waitForFunction(
    () => document.querySelector("#filenameTemplate")?.value === "{date}_{case}_{documentType}"
  );
  planner.once("dialog", (dialog) => dialog.accept());
  await planner.locator("#historyMode").selectOption("detailed");
  await planner.waitForFunction(
    () => document.querySelector("#historyMode")?.dataset.previous === "detailed"
  );

  await planner.locator("#startExport").click();
  await planner.getByText(/Задача запущена: 2/).waitFor();
  const launchedJob = await worker.evaluate(async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { exportJob } = await chrome.storage.session.get("exportJob");
      if (exportJob?.items?.length === 2) return exportJob;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return null;
  });
  assert.ok(launchedJob, "planned export job should be persisted before runner completion");
  assert.deepEqual(launchedJob.items.map((item) => item.sourceIndex), [2, 5]);
  assert.deepEqual(launchedJob.items.map((item) => item.exportIndex), [1, 2]);
  assert.equal(launchedJob.profileSnapshot.id, "court-profile");
  const plannedPaths = launchedJob.items.map((item) => item.plannedRelativePath);

  await worker.evaluate(async () => {
    const stored = await chrome.storage.local.get("exportProfileState");
    const state = stored.exportProfileState;
    const profile = state.profiles.find((entry) => entry.id === "court-profile");
    profile.folderTemplate = "Changed/After/Launch";
    await chrome.storage.local.set({ exportProfileState: state });
  });
  const pathsAfterProfileChange = await worker.evaluate(async () => {
    const { exportJob } = await chrome.storage.session.get("exportJob");
    return exportJob.items.map((item) => item.plannedRelativePath);
  });
  assert.deepEqual(pathsAfterProfileChange, plannedPaths);
  await planner.evaluate(() => chrome.runtime.sendMessage({ type: "STOP_EXPORT" }));
  assert.deepEqual(pageErrors, []);
});
