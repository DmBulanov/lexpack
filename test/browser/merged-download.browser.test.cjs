const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");
const { consInspectDocxArchive } = require("../../extension/shared/docx-sanitizer.js");
const { documentShell, documentFrame } = require("../fixtures/online-document.cjs");

const TITLES = ["Решение суда.pdf", "Excluded act", "English act.docx"];
const BODY = (index) => `BODY_SENTINEL_${index}: **сырой** & <raw-tag> 😀. Источник: КонсультантПлюс.`;
const CLEAN_BODY = (index) => BODY(index).replace("КонсультантПлюс", "");
const NOTE = (index) => `КонсультантПлюс: примечание. Примечание ${index} сохраняется.`;

async function fixture(t, { format = "md-one", query = "Подборка", emptyIndex, slowIndex, selected = [1, 3] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lexpack-merged-"));
  const downloadsPath = path.join(root, "downloads");
  await fs.mkdir(downloadsPath);
  const userDataDir = path.join(root, "profile");
  await fs.mkdir(path.join(userDataDir, "Default"), { recursive: true });
  await fs.writeFile(path.join(userDataDir, "Default/Preferences"), JSON.stringify({
    download: { default_directory: downloadsPath, prompt_for_download: false, directory_upgrade: true },
  }));
  const extensionPath = path.resolve(__dirname, "../../build/chrome");
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium", headless: true, acceptDownloads: true, downloadsPath,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  t.after(async () => {
    await context.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const reads = new Map();
  let nativeRequests = 0;
  await context.route("https://online.consultant.ru/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("native")) nativeRequests += 1;
    const index = Number(url.searchParams.get("n"));
    if (url.pathname.endsWith("/document_inner.htm")) {
      // The outer shell and its AI panel finish first; the full act arrives later.
      await new Promise((resolve) => setTimeout(resolve, 350));
      await route.fulfill({ contentType: "text/html; charset=utf-8",
        body: documentFrame([BODY(index), NOTE(index)], { empty: index === emptyIndex }),
      }).catch(() => {});
      return;
    }
    reads.set(index, (reads.get(index) || 0) + 1);
    if (index === slowIndex) await new Promise((resolve) => setTimeout(resolve, 1800));
    await route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: documentShell(TITLES[index - 1], `/riv/static-test/document_inner.htm?n=${index}`),
    }).catch(() => {}); // A stop/restart can close a delayed temporary tab.
  });
  let [worker] = context.serviceWorkers();
  worker ||= await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extensionId = new URL(worker.url()).hostname;
  await worker.evaluate(async ({ format, query, titles }) => {
    const now = "2026-10-01T10:00:00.000Z";
    await chrome.storage.local.set({
      historyMode: "safe",
      exportProfileState: {
        schemaVersion: 1, selectedProfileId: "default",
        profiles: [{ schemaVersion: 1, id: "default", name: "По умолчанию", format,
          filenameTemplate: "{title}", folderTemplate: "LexPack", collisionPolicy: "ordered-suffix",
          builtIn: true, createdAt: now, updatedAt: now }],
      },
    });
    await chrome.storage.session.set({
      searchCollection: {
        status: "ready", source: "current-list", adapter: "online-app", query, scope: "current-list",
        items: titles.map((title, offset) => ({
          index: offset + 1, sourceIndex: offset + 1, title,
          url: `https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=ARB&n=${offset + 1}`,
          instance: null, instanceLabel: "Произвольная судебная ветка",
        })),
        total: titles.length, totalKnown: true, truncated: false, createdAt: now,
      },
    });
  }, { format, query, titles: TITLES });
  const planner = await context.newPage();
  await planner.goto(`chrome-extension://${extensionId}/planner/planner.html`);
  // Playwright's allowAndName policy stores GUIDs without extensions. Use
  // Chrome's ordinary download policy to check the real user-facing names.
  const downloadPolicy = await context.newCDPSession(planner);
  await downloadPolicy.send("Browser.setDownloadBehavior", {
    behavior: "allow", downloadPath: downloadsPath, eventsEnabled: true,
  });
  await downloadPolicy.detach();
  await planner.locator("#documentRows tr").nth(2).waitFor();
  for (let index = 1; index <= TITLES.length; index += 1) {
    if (!selected.includes(index)) await planner.locator(`input[data-source-index="${index}"]`).uncheck();
  }
  await planner.waitForFunction(({count, merged}) => document.querySelector("#launchSummary")?.textContent?.startsWith(`${count} документ(ов)${merged ? " → 1 файл" : ""}`), {count:selected.length, merged:format.endsWith("-one")});
  return { context, planner, worker, downloadsPath, reads, nativeRequests: () => nativeRequests };
}

async function waitForJob(planner, condition = "completed") {
  return planner.evaluate(async (condition) => {
    const deadline = Date.now() + 30000;
    let job;
    while (Date.now() < deadline) {
      job = (await chrome.storage.session.get("exportJob")).exportJob;
      if (condition === "prepared") {
        if (job?.items[0].status === "prepared" && job.current?.itemIndex === 1 && job.current.tabId) return job;
        if (job && !["running", "stopping"].includes(job.status)) break;
      } else if (job && !["running", "stopping"].includes(job.status) && job.historySaved) {
        const offscreen = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
        if (!offscreen.length) return job;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const tabs = await chrome.tabs.query({});
    throw new Error(`Job did not reach ${condition}: ${JSON.stringify({ phase: job?.phase, status: job?.status, lastError: job?.lastError, tabs })}; ${document.querySelector("#status")?.textContent}`);
  }, condition);
}

async function downloads(planner) {
  return planner.evaluate(() => chrome.downloads.search({}));
}

async function workerVersion(context, planner, scriptUrl) {
  const cdp = await context.newCDPSession(planner);
  const version = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Worker version was not reported")), 5000);
    const updated = ({ versions }) => {
      const running = versions.find((item) => item.scriptURL === scriptUrl && item.runningStatus === "running");
      if (!running) return;
      clearTimeout(timeout);
      cdp.off("ServiceWorker.workerVersionUpdated", updated);
      resolve(running);
    };
    cdp.on("ServiceWorker.workerVersionUpdated", updated);
    cdp.send("ServiceWorker.enable").catch(reject);
  });
  return { cdp, version };
}

async function stopWorker(cdp, version) {
  const stopped = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Worker did not stop")), 5000);
    const updated = ({ versions }) => {
      if (!versions.some((item) => item.versionId === version.versionId && item.runningStatus === "stopped")) return;
      clearTimeout(timeout);
      cdp.off("ServiceWorker.workerVersionUpdated", updated);
      resolve();
    };
    cdp.on("ServiceWorker.workerVersionUpdated", updated);
  });
  await cdp.send("ServiceWorker.stopWorker", { versionId: version.versionId });
  await stopped;
}

test("merged formats download one ordered document with English and Russian filenames", async (t) => {
  for (const format of ["md-one", "docx-one"]) {
    for (const query of ["English collection", "Судебная подборка"]) {
      await t.test(`${format}: ${query}`, async (st) => {
        const env = await fixture(st, { format, query });
        const extension = format === "md-one" ? "md" : "docx";
        const plannedPaths = await env.planner.locator("#documentRows tr td.path").allTextContents();
        assert.equal(plannedPaths[0], `LexPack/${query}.${extension}`);
        assert.equal(plannedPaths[0], plannedPaths[2]);
        assert.equal(await env.planner.locator("#mergedFormatHint").isVisible(), true);
        for (const native of ["docx", "pdf"]) {
          assert.equal(await env.planner.locator(`#format option[value='${native}']`).isDisabled(), false);
        }
        await env.planner.locator("#startExport").click();
        const job = await waitForJob(env.planner);
        assert.equal(job.status, "done", JSON.stringify({ lastError: job.lastError, log: job.log }));
        assert.deepEqual(job.items.map((item) => item.sourceIndex), [1, 3]);
        assert.ok(job.items.every((item) => item.status === "completed" && item.downloadId === job.mergedResult.downloadId));
        assert.ok(job.items.every((item) => item.actualFilename === `${query}.${extension}`), JSON.stringify({ result: job.mergedResult, files: await downloads(env.planner) }));
        assert.equal(env.reads.get(1), 1);
        assert.equal(env.reads.has(2), false);
        assert.equal(env.reads.get(3), 1);
        assert.equal(env.nativeRequests(), 0);

        const files = await downloads(env.planner);
        const material = files.filter((item) => item.filename.endsWith(`.${extension}`));
        assert.equal(material.length, 1);
        assert.equal(material[0].state, "complete");
        assert.ok(
          (await fs.realpath(material[0].filename)).startsWith(`${await fs.realpath(env.downloadsPath)}${path.sep}`),
          `${material[0].filename} is outside ${env.downloadsPath}`
        );
        const bytes = await fs.readFile(material[0].filename);
        if (format === "md-one") {
          const expected = `# 1. ${TITLES[0]}\n\n${CLEAN_BODY(1)}\n\n${NOTE(1)}\n\n---\n\n# 2. ${TITLES[2]}\n\n${CLEAN_BODY(3)}\n\n${NOTE(3)}`;
          assert.deepEqual(bytes, Buffer.from(expected, "utf8"));
          assert.equal(material[0].mime, "text/markdown");
        } else {
          const archive = await consInspectDocxArchive(bytes);
          const xml = new TextDecoder("utf-8", { fatal: true }).decode(archive["word/document.xml"]);
          const paragraphs = await env.planner.evaluate((xml) => {
            const document = new DOMParser().parseFromString(xml, "application/xml");
            if (document.querySelector("parsererror")) throw new Error("Malformed Word XML");
            return Array.from(document.getElementsByTagNameNS("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "p"), (paragraph) => paragraph.textContent);
          }, xml);
          assert.deepEqual(paragraphs.filter(Boolean), [
            `1. ${TITLES[0]}`, CLEAN_BODY(1), NOTE(1),
            `2. ${TITLES[2]}`, CLEAN_BODY(3), NOTE(3),
          ]);
          assert.equal((xml.match(/<w:pageBreakBefore\/>/gu) || []).length, 1);
        }
        const reportFile = files.find((item) => item.filename.endsWith(".json"));
        assert.equal(files.length, 2, "one merged document plus the existing control report");
        const report = JSON.parse(await fs.readFile(reportFile.filename, "utf8"));
        assert.equal(report.resultCounters.completed, 2);
        assert.equal(new Set(report.items.map((item) => item.actualFilename)).size, 1);
        const stored = await env.planner.evaluate(async () => ({
          session: await chrome.storage.session.get(null), local: await chrome.storage.local.get(null),
          offscreen: await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }),
        }));
        assert.doesNotMatch(JSON.stringify(stored), /BODY_SENTINEL/u);
        assert.equal(stored.offscreen.length, 0, "memory-only document buffer must be released");
      });
    }
  }
});

test("an empty source aborts the merged export without saving a partial document", async (t) => {
  const env = await fixture(t, { emptyIndex: 3 });
  await env.planner.locator("#startExport").click();
  const job = await waitForJob(env.planner);
  assert.equal(job.status, "failed");
  assert.match(job.lastError, /Полный текст документа/u);
  assert.ok(job.items.every((item) => item.status === "failed" && !item.downloadId));
  assert.equal((await downloads(env.planner)).length, 0);
});

test("individual Markdown also saves the inner act and never the outer AI summary", async (t) => {
  const env = await fixture(t, { format: "md", selected: [1] });
  await env.planner.locator("#startExport").click();
  const job = await waitForJob(env.planner);
  assert.equal(job.status, "done", job.lastError);
  const files = await downloads(env.planner);
  const file = files.find((item) => item.filename.endsWith(".md"));
  assert.ok(file);
  assert.deepEqual(await fs.readFile(file.filename), Buffer.from(`${CLEAN_BODY(1)}\n\n${NOTE(1)}`, "utf8"));
  assert.equal(env.nativeRequests(), 0);
});

test("stopping while reading a later source releases the buffer without downloading", async (t) => {
  const env = await fixture(t, { slowIndex: 3 });
  await env.planner.locator("#startExport").click();
  await waitForJob(env.planner, "prepared");
  const response = await env.planner.evaluate(() => chrome.runtime.sendMessage({ type: "STOP_EXPORT" }));
  assert.equal(response.stopped, true);
  const job = await waitForJob(env.planner);
  assert.equal(job.status, "stopped");
  assert.ok(job.items.every((item) => item.status === "stopped" && !item.downloadId));
  assert.equal((await downloads(env.planner)).length, 0);
  assert.equal(await env.planner.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length), 0);
});

test("merged export resumes after an MV3 restart with or without the memory buffer", async (t) => {
  for (const loseBuffer of [false, true]) {
    await t.test(loseBuffer ? "lost buffer rereads sources" : "live buffer keeps prepared sources", async (st) => {
      const env = await fixture(st, { slowIndex: 3 });
      const { cdp, version } = await workerVersion(env.context, env.planner, env.worker.url());
      await env.planner.locator("#startExport").click();
      const before = await waitForJob(env.planner, "prepared");
      await stopWorker(cdp, version);
      if (loseBuffer) await env.planner.evaluate(() => chrome.offscreen.closeDocument());
      await env.planner.evaluate(() => chrome.runtime.sendMessage({ type: "GET_PROGRESS" }));
      const job = await waitForJob(env.planner);
      await cdp.detach();
      assert.equal(job.id, before.id);
      assert.equal(job.status, "done", job.lastError);
      assert.ok(job.items.every((item) => item.status === "completed"));
      assert.equal(env.reads.get(1), loseBuffer ? 2 : 1);
      assert.equal((await downloads(env.planner)).filter((item) => item.filename.endsWith(".md")).length, 1);
      const output = (await downloads(env.planner)).find((item) => item.filename.endsWith(".md"));
      const text = await fs.readFile(output.filename, "utf8");
      assert.equal((text.match(/BODY_SENTINEL_1/gu) || []).length, 1);
      assert.equal((text.match(/BODY_SENTINEL_3/gu) || []).length, 1);
      assert.ok(text.indexOf("BODY_SENTINEL_1") < text.indexOf("BODY_SENTINEL_3"));
    });
  }
});
