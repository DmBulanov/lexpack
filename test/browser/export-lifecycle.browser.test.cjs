const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");

const TITLE = "Решение от 14.03.2025 по делу А40-1/2025";
const SOURCE_URL =
  "https://www.consultant.ru/document/cons_doc_LAW_701/";

function documentHtml() {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${TITLE}</title></head>
    <body><main class="pageContainer x-page-document-content">
      <h1>${TITLE}</h1><p>Тестовое содержимое судебного акта.</p>
    </main></body></html>`;
}

async function runningWorkerVersion(context, page, scriptUrl) {
  const cdp = await context.newCDPSession(page);
  let timeout;
  const version = await new Promise(async (resolve, reject) => {
    const onUpdate = ({ versions }) => {
      const match = versions.find(
        (candidate) =>
          candidate.scriptURL === scriptUrl && candidate.runningStatus === "running"
      );
      if (!match) return;
      clearTimeout(timeout);
      cdp.off("ServiceWorker.workerVersionUpdated", onUpdate);
      resolve(match);
    };
    cdp.on("ServiceWorker.workerVersionUpdated", onUpdate);
    timeout = setTimeout(() => {
      cdp.off("ServiceWorker.workerVersionUpdated", onUpdate);
      reject(new Error("MV3 service worker version was not reported by Chromium"));
    }, 10000);
    try {
      await cdp.send("ServiceWorker.enable");
    } catch (error) {
      clearTimeout(timeout);
      cdp.off("ServiceWorker.workerVersionUpdated", onUpdate);
      reject(error);
    }
  });
  return { cdp, version };
}

test("planned TXT export survives an MV3 worker restart and writes report v2 plus safe history", async (t) => {
  const extensionPath = path.resolve(__dirname, "../../build/chrome");
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lexpack-lifecycle-"));
  const userDataDir = path.join(testRoot, "profile");
  const downloadsPath = path.join(testRoot, "downloads");
  await fs.mkdir(downloadsPath, { recursive: true });

  let context = null;
  t.after(async () => {
    await context?.close();
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    acceptDownloads: true,
    downloadsPath,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  await context.route("https://www.consultant.ru/**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({ contentType: "text/html; charset=utf-8", body: documentHtml() });
  });

  let [worker] = context.serviceWorkers();
  worker ||= await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extensionId = new URL(worker.url()).hostname;
  const now = "2026-07-21T10:00:00.000Z";

  await worker.evaluate(
    async ({ now, sourceUrl, title }) => {
      const defaultProfile = {
        schemaVersion: 1,
        id: "default",
        name: "По умолчанию",
        format: "txt",
        filenameTemplate: "{date}_{case}_{documentType}",
        folderTemplate: "LexPack/{instance}",
        collisionPolicy: "ordered-suffix",
        builtIn: true,
        createdAt: now,
        updatedAt: now,
      };
      await chrome.storage.local.set({
        historyMode: "safe",
        exportProfileState: {
          schemaVersion: 1,
          selectedProfileId: "default",
          profiles: [defaultProfile],
        },
      });
      await chrome.storage.session.set({
        searchCollection: {
          status: "ready",
          source: "search",
          adapter: "public-site",
          query: "чувствительный тестовый запрос",
          scope: "all",
          items: [
            {
              index: 7,
              sourceIndex: 7,
              title,
              url: sourceUrl,
              instance: "arbitration-circuit",
              instanceLabel: "Арбитражные суды округов (кассация)",
            },
          ],
          total: 1,
          totalKnown: true,
          truncated: false,
          createdAt: now,
        },
      });
    },
    { now, sourceUrl: SOURCE_URL, title: TITLE }
  );

  const planner = await context.newPage();
  await planner.goto(`chrome-extension://${extensionId}/planner/planner.html`);
  await planner.locator("#documentRows tr").waitFor();
  const previewPath = await planner.locator("#documentRows tr td.path").innerText();
  assert.match(previewPath, /^LexPack\//);
  assert.match(previewPath, /2025-03-14/);
  assert.match(previewPath, /Решение\.txt$/);

  const { cdp, version } = await runningWorkerVersion(context, planner, worker.url());

  await planner.locator("#startExport").click();
  await planner.getByText(/Задача запущена: 1/).waitFor();
  const beforeRestart = await planner.evaluate(async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const { exportJob } = await chrome.storage.session.get("exportJob");
      if (exportJob?.phase === "loading_tab" && exportJob.current?.tabId) {
        return {
          jobId: exportJob.id,
          plannedRelativePath: exportJob.items[0].plannedRelativePath,
          profileSnapshot: exportJob.profileSnapshot,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return null;
  });
  assert.ok(beforeRestart, "job must persist its plan before the worker restart");
  assert.equal(beforeRestart.plannedRelativePath, previewPath);

  let sawStopped = false;
  let restartTimeout;
  const workerRestarted = new Promise((resolve, reject) => {
    const onUpdate = ({ versions }) => {
      const match = versions.find((candidate) => candidate.scriptURL === worker.url());
      if (!match) return;
      if (match.runningStatus === "stopped") sawStopped = true;
      if (!sawStopped || match.runningStatus !== "running") return;
      clearTimeout(restartTimeout);
      cdp.off("ServiceWorker.workerVersionUpdated", onUpdate);
      resolve(match);
    };
    cdp.on("ServiceWorker.workerVersionUpdated", onUpdate);
    restartTimeout = setTimeout(() => {
      cdp.off("ServiceWorker.workerVersionUpdated", onUpdate);
      reject(new Error("MV3 service worker did not complete stopped → running"));
    }, 10000);
  });
  await cdp.send("ServiceWorker.stopWorker", { versionId: version.versionId });
  await planner.evaluate(() => chrome.runtime.sendMessage({ type: "GET_PROGRESS" }));
  await workerRestarted;
  await cdp.detach();

  await planner.waitForFunction(
    async () => {
      const response = await chrome.runtime.sendMessage({ type: "GET_PROGRESS" });
      return response?.ok && !response.running && response.progress?.status === "done";
    },
    undefined,
    { timeout: 30000 }
  );

  const completed = await planner.evaluate(async (jobId) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const [{ exportJob }, local] = await Promise.all([
        chrome.storage.session.get("exportJob"),
        chrome.storage.local.get("exportHistory"),
      ]);
      const history = local.exportHistory?.records?.find((record) => record.id === jobId);
      if (exportJob?.historySaved && history) return { exportJob, history };
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return null;
  }, beforeRestart.jobId);
  assert.ok(completed, "completed job and safe history must both be persisted");
  assert.equal(completed.exportJob.items[0].plannedRelativePath, previewPath);
  assert.deepEqual(completed.exportJob.profileSnapshot, beforeRestart.profileSnapshot);
  assert.equal(
    completed.exportJob.items[0].status,
    "completed",
    JSON.stringify({
      item: completed.exportJob.items[0],
      phase: completed.exportJob.phase,
      lastError: completed.exportJob.lastError,
      log: completed.exportJob.log,
    })
  );
  assert.equal(completed.exportJob.report.status, "completed");

  const history = completed.history;
  assert.equal(history.mode, "safe");
  assert.equal(history.selectedCount, 1);
  assert.equal(history.successful, 1);
  for (const sensitiveKey of ["query", "items", "title", "sourceUrl", "case", "court"]) {
    assert.equal(Object.hasOwn(history, sensitiveKey), false);
  }

  const downloads = await planner.evaluate(async () =>
    (await chrome.downloads.search({})).map((item) => ({
      filename: item.filename,
      state: item.state,
    }))
  );
  const textDownload = downloads.find(
    (item) => path.basename(item.filename) === completed.exportJob.items[0].actualFilename
  );
  const reportDownload = downloads.find(
    (item) => path.basename(item.filename) === completed.exportJob.report.filename
  );
  assert.equal(textDownload?.state, "complete");
  assert.equal(reportDownload?.state, "complete");
  assert.ok(textDownload.filename.startsWith(downloadsPath));
  assert.ok(reportDownload.filename.startsWith(downloadsPath));

  const report = JSON.parse(await fs.readFile(reportDownload.filename, "utf8"));
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.extensionVersion, "0.9.0-chrome");
  assert.equal(report.variant, "chrome");
  assert.equal(report.jobId, beforeRestart.jobId);
  assert.equal(report.query, null);
  assert.deepEqual(report.privacy, { historyMode: "safe", queryIncluded: false });
  assert.equal(report.selectedCount, 1);
  assert.equal(report.resultCounters.completed, 1);
  assert.equal(report.items[0].exportIndex, 1);
  assert.equal(report.items[0].sourceIndex, 7);
  assert.equal(report.items[0].plannedRelativePath, previewPath);
  assert.equal(report.items[0].actualFilename, path.basename(textDownload.filename));
  assert.equal(report.items[0].normalizedMetadata.date.value, "2025-03-14");
  assert.equal(report.items[0].normalizedMetadata.case.value, "А40-1/2025");
  assert.equal(report.items[0].normalizedMetadata.documentType.value, "Решение");
  assert.doesNotMatch(JSON.stringify(report), /downloadId|чувствительный тестовый запрос/);
});
