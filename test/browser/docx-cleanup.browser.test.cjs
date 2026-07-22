const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");

const {
  consCreateStoredZip,
  consInspectDocxArchive,
} = require("../../extension/shared/docx-sanitizer.js");

const SOURCE_URL =
  "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=ARB&n=42";

function brandedDocx() {
  return consCreateStoredZip({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rDoc" Target="word/document.xml" Type="officeDocument"/></Relationships>`,
    "docProps/core.xml": `<?xml version="1.0"?><cp:coreProperties xmlns:cp="urn:cp" xmlns:dc="urn:dc"><dc:creator>КонсультантПлюс</dc:creator></cp:coreProperties>`,
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Текст судебного решения</w:t></w:r></w:p></w:body></w:document>`,
    "word/header1.xml": `<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Документ предоставлен КонсультантПлюс</w:t></w:r></w:p><w:p><w:r><w:t>Решение суда</w:t></w:r></w:p></w:hdr>`,
    "word/footer1.xml": `<?xml version="1.0"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>www.consultant.ru</w:t></w:r></w:p></w:ftr>`,
  });
}

function documentHtml(bytesBase64) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Решение суда — КонсультантПлюс</title></head>
    <body><main class="pageContainer x-page-document-content">Текст судебного решения</main>
      <button class="word" type="button">Word</button>
      <script>
        window.__lexpackUseBrokenDocx = false;
        document.querySelector("button.word").addEventListener("click", () => {
          const bytes = window.__lexpackUseBrokenDocx
            ? new TextEncoder().encode("not a DOCX")
            : Uint8Array.from(
                atob(${JSON.stringify(bytesBase64)}),
                (char) => char.charCodeAt(0)
              );
          const blob = new Blob([bytes], {
            type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          });
          const anchor = document.createElement("a");
          anchor.href = URL.createObjectURL(blob);
          anchor.download = "branded-source.docx";
          document.body.append(anchor);
          anchor.click();
          anchor.remove();
        });
      </script>
    </body></html>`;
}

for (const variant of ["chrome", "chromium-gost"]) {
test(`the ${variant} online Word path downloads only the locally cleaned DOCX`, async (t) => {
  const extensionPath = path.resolve(__dirname, `../../build/${variant}`);
  const testRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), `lexpack-docx-cleanup-${variant}-`)
  );
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

  const source = brandedDocx();
  await context.route("https://online.consultant.ru/**", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: documentHtml(Buffer.from(source).toString("base64")),
    })
  );

  let [worker] = context.serviceWorkers();
  worker ||= await context.waitForEvent("serviceworker", { timeout: 15000 });
  const page = await context.newPage();
  await page.goto(SOURCE_URL);
  await page.locator("button.word").waitFor();

  const extractDocx = () => worker.evaluate(async (sourceUrl) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === sourceUrl);
    if (!tab?.id) throw new Error("test ConsultantPlus tab was not found");
    return sendToTab(tab.id, {
      type: "EXTRACT_DOCUMENT",
      format: "docx",
    });
  }, SOURCE_URL);
  const responsePromise = extractDocx();
  const [download, response] = await Promise.all([
    page.waitForEvent("download", { timeout: 15000 }),
    responsePromise,
  ]);

  assert.equal(response.ok, true, JSON.stringify(response));
  assert.deepEqual(response.doc.contentCleanup, {
    consultantDataRemoved: true,
    pageNumberPreserved: true,
    documentBodyPreserved: true,
  });
  assert.equal(download.suggestedFilename(), "branded-source.docx");

  const downloadedPath = await download.path();
  const cleanedBytes = await fs.readFile(downloadedPath);
  const cleaned = await consInspectDocxArchive(cleanedBytes);
  const decode = (name) => new TextDecoder().decode(cleaned[name]);
  assert.match(decode("word/document.xml"), /Текст судебного решения/);
  assert.match(decode("word/header1.xml"), /Решение суда/);
  assert.doesNotMatch(decode("word/header1.xml"), /Консультант|Consultant/iu);
  assert.match(decode("word/footer1.xml"), /w:instr=" PAGE "/);
  assert.match(decode("word/footer1.xml"), /w:instr=" NUMPAGES "/);
  assert.doesNotMatch(decode("word/footer1.xml"), /consultant\.ru/iu);
  assert.doesNotMatch(decode("docProps/core.xml"), /Консультант|Consultant/iu);

  await page.evaluate(() => {
    window.__lexpackUseBrokenDocx = true;
  });
  const unexpectedDownload = page
    .waitForEvent("download", { timeout: 1500 })
    .then(() => true, () => false);
  const failed = await extractDocx();
  assert.equal(failed.ok, false);
  assert.match(failed.error, /DOCX|Word|очист/iu);
  assert.equal(await unexpectedDownload, false, "the unclean source must stay blocked");
});
}
