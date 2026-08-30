const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");

const MARKDOWN =
  "# Русский заголовок\r\n\r\n**жирный** & <raw-tag>\r\n`код_[x]` 😀 е\u0308\r\n";
const CLEANUP_SOURCE_URL =
  "https://www.consultant.ru/document/cons_doc_LAW_777/";

test("Markdown downloads preserve UTF-8 bytes and English/Russian source filenames", async (t) => {
  const extensionPath = path.resolve(__dirname, "../../build/chrome");
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lexpack-markdown-"));
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

  let [worker] = context.serviceWorkers();
  worker ||= await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extensionId = new URL(worker.url()).hostname;
  const extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  for (const { sourceName, expectedName } of [
    { sourceName: "document.pdf", expectedName: "document.md" },
    { sourceName: "Решение суда.docx", expectedName: "Решение суда.md" },
  ]) {
    const response = await extensionPage.evaluate(
      async ({ sourceName, markdown }) =>
        chrome.runtime.sendMessage({
          type: "SAVE_EXTRACTED",
          format: "md",
          doc: {
            title: sourceName,
            text: "fallback text must not replace converted Markdown",
            markdown,
            url: "https://www.consultant.ru/document/cons_doc_LAW_1/",
          },
        }),
      { sourceName, markdown: MARKDOWN }
    );

    assert.equal(response?.ok, true, response?.error);
    assert.equal(response.filename, expectedName);

    const download = await worker.evaluate(async (downloadId) => {
      const [item] = await chrome.downloads.search({ id: downloadId });
      return item;
    }, response.downloadId);
    assert.equal(download.state, "complete");
    assert.ok(download.filename.startsWith(downloadsPath));
    assert.equal(download.mime, "text/markdown");

    const actualBytes = await fs.readFile(download.filename);
    assert.deepEqual(actualBytes, Buffer.from(MARKDOWN, "utf8"));
  }

  const unsafeMarkdown = await extensionPage.evaluate(async () =>
    chrome.runtime.sendMessage({
      type: "SAVE_EXTRACTED",
      format: "md",
      doc: {
        title: "uncleaned.docx",
        markdown: "Обычный абзац с КонсультантПлюс",
        url: "https://www.consultant.ru/document/cons_doc_LAW_2/",
      },
    })
  );
  assert.equal(unsafeMarkdown?.ok, false);
  assert.equal(unsafeMarkdown?.code, "CONTENT_CLEANUP_INCOMPLETE");

  const noteMarkdown =
    "> КонсультантПлюс: примечание.\r\nВ примечании КонсультантПлюс остаётся **без изменений**.\r\n";
  const noteResponse = await extensionPage.evaluate(
    async (markdown) =>
      chrome.runtime.sendMessage({
        type: "SAVE_EXTRACTED",
        format: "md",
        doc: {
          title: "Примечание.docx",
          markdown,
          url: "https://www.consultant.ru/document/cons_doc_LAW_4/",
        },
      }),
    noteMarkdown
  );
  assert.equal(noteResponse?.ok, true, noteResponse?.error);
  const noteDownload = await worker.evaluate(async (downloadId) => {
    const [item] = await chrome.downloads.search({ id: downloadId });
    return item;
  }, noteResponse.downloadId);
  assert.deepEqual(await fs.readFile(noteDownload.filename), Buffer.from(noteMarkdown, "utf8"));

  const htmlResponse = await extensionPage.evaluate(async () =>
    chrome.runtime.sendMessage({
      type: "SAVE_EXTRACTED",
      format: "html",
      doc: {
        title: "HTML документ",
        html: `<main><p id="ordinary-html">Источник: <span>Консультант</span><b>Плюс</b>.</p><p id="note-html">КонсультантПлюс: примечание. КонсультантПлюс сохраняется.</p></main>`,
        url: "https://www.consultant.ru/document/cons_doc_LAW_3/",
      },
    })
  );
  assert.equal(htmlResponse?.ok, true, htmlResponse?.error);
  const htmlDownload = await worker.evaluate(async (downloadId) => {
    const [item] = await chrome.downloads.search({ id: downloadId });
    return item;
  }, htmlResponse.downloadId);
  const htmlBody = await fs.readFile(htmlDownload.filename, "utf8");
  assert.match(htmlBody, /Источник: исходный документ/u);
  assert.doesNotMatch(htmlBody, /www\.consultant\.ru/iu);
  assert.match(htmlBody, /<p>Источник: <span><\/span><b><\/b>\.<\/p>/u);
  assert.match(
    htmlBody,
    /<p>КонсультантПлюс: примечание\. КонсультантПлюс сохраняется\.<\/p>/u
  );

  await context.route(CLEANUP_SOURCE_URL, (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Русский документ.docx</title></head><body><main class="document-page__main"><h1>Русский документ.docx</h1><p>Обычный текст из <span>Консультант</span><b>Плюс</b>: **сырой** &amp; &lt;tag&gt;.</p><p>КонсультантПлюс: примечание. КонсультантПлюс сохраняется.</p></main></body></html>`,
    })
  );
  const sourcePage = await context.newPage();
  await sourcePage.goto(CLEANUP_SOURCE_URL);
  const extracted = await worker.evaluate(async (sourceUrl) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === sourceUrl);
    if (!tab?.id) throw new Error("test document tab was not found");
    return sendToTab(tab.id, { type: "EXTRACT_DOCUMENT", format: "md" });
  }, CLEANUP_SOURCE_URL);
  assert.equal(extracted.ok, true, extracted.error);
  assert.match(extracted.doc.text, /Обычный текст из : \*\*сырой\*\* & <tag>\./u);
  assert.match(
    extracted.doc.text,
    /КонсультантПлюс: примечание\. КонсультантПлюс сохраняется\./u
  );
  assert.equal(extracted.doc.contentCleanup.consultantDataRemoved, true);
  assert.equal(extracted.doc.contentCleanup.protectedNotesPreserved, true);

  const cleanedResponse = await extensionPage.evaluate(
    async (doc) => chrome.runtime.sendMessage({ type: "SAVE_EXTRACTED", format: "md", doc }),
    extracted.doc
  );
  assert.equal(cleanedResponse?.ok, true, cleanedResponse?.error);
  assert.equal(cleanedResponse.filename, "Русский документ.md");
  const cleanedDownload = await worker.evaluate(async (downloadId) => {
    const [item] = await chrome.downloads.search({ id: downloadId });
    return item;
  }, cleanedResponse.downloadId);
  const cleanedBytes = await fs.readFile(cleanedDownload.filename);
  assert.deepEqual(cleanedBytes, Buffer.from(extracted.doc.text, "utf8"));
});
