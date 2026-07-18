const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");

const helperPath = path.resolve(__dirname, "../../extension/shared/safe-html.js");

test("Chromium parser cannot reactivate exported markup and static content works without JS", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  const builderPage = await browser.newPage();
  await builderPage.addScriptTag({ path: helperPath });
  const unsafeHtml = `<!doctype html><html><head>
    <script>document.documentElement.dataset.scriptExecuted = "yes"</script>
    <style>body{background:url(https://example.invalid/style-beacon)}</style>
  </head><body>
    <h1>Судебный акт</h1><p>Обычный <strong>текст</strong></p>
    <img src="https://example.invalid/image-beacon" onerror="document.documentElement.dataset.eventExecuted='yes'">
    <a href="javascript:document.documentElement.dataset.urlExecuted='yes'">ссылка</a>
    <svg><g onload="document.documentElement.dataset.svgExecuted='yes'"></g></svg>
    <math><a href="javascript:document.documentElement.dataset.mathExecuted='yes'">x</a></math>
    <iframe srcdoc="<script>parent.document.documentElement.dataset.frameExecuted='yes'</script>"></iframe>
    <form action="https://example.invalid/form-beacon"><button>submit</button></form>
  </body></html>`;
  const exported = await builderPage.evaluate(
    ({ unsafeHtml }) =>
      globalThis.consBuildSafeHtmlDocument(
        "Тестовый документ",
        unsafeHtml,
        "https://online.consultant.ru/document/test",
        document
      ),
    { unsafeHtml }
  );

  assert.doesNotMatch(exported, /<script\b/i);
  assert.doesNotMatch(exported, /https:\/\/example\.invalid/i);

  const externalRequests = [];
  const page = await browser.newPage();
  page.on("request", (request) => {
    if (/^https?:/i.test(request.url())) externalRequests.push(request.url());
  });
  await page.setContent(exported, { waitUntil: "load" });
  await page.locator("#cons-export-content h1").waitFor();
  const result = await page.evaluate(() => ({
    markers: { ...document.documentElement.dataset },
    heading: document.querySelector("#cons-export-content h1")?.textContent,
    strong: document.querySelector("#cons-export-content strong")?.textContent,
    activeNodes: document.querySelectorAll(
      "#cons-export-content script, #cons-export-content style, iframe, object, embed, svg, math, form, button"
    ).length,
    eventAttributes: [...document.querySelectorAll("#cons-export-content *")].flatMap((node) =>
      [...node.attributes].filter((attribute) => /^on/i.test(attribute.name))
    ).length,
  }));
  assert.deepEqual(result.markers, {});
  assert.equal(result.heading, "Судебный акт");
  assert.equal(result.strong, "текст");
  assert.equal(result.activeNodes, 0);
  assert.equal(result.eventAttributes, 0);
  assert.deepEqual(externalRequests, []);

  const noScriptContext = await browser.newContext({ javaScriptEnabled: false });
  const noScriptPage = await noScriptContext.newPage();
  await noScriptPage.setContent(exported, { waitUntil: "load" });
  assert.equal(await noScriptPage.locator("#cons-export-content h1").textContent(), "Судебный акт");
  await noScriptContext.close();
});
