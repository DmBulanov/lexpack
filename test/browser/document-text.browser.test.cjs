const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");
const { documentShell, documentFrame, summary } = require("../fixtures/online-document.cjs");
const BODY = ["АРБИТРАЖНЫЙ СУД", "ПОСТАНОВЛЕНИЕ", "установил:",
  "Полный текст **без экранирования** & <символы> 😀.", "постановил:",
  "Решение оставить без изменения.", "Судья И.И.ИВАНОВ",
  "КонсультантПлюс: примечание. Примечание сохранено."];
const SOURCE = "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=AMS&n=590632";

test("online text extraction reads the complete inner act, never reference/AI panels", async (t) => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  t.after(() => browser.close());
  async function fixture(st, { frame = documentFrame(BODY), shell } = {}) {
    const page = await browser.newPage();
    st.after(() => page.close());
    await page.route("https://online.consultant.ru/**", (route) => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: route.request().url().includes("document_inner.htm") ? frame :
        shell || documentShell("Постановление суда", "/riv/static-test/document_inner.htm?"),
    }));
    await page.goto(SOURCE);
    for (const relative of ["shared/content-cleaner.js", "content/adapters/online-app.js"]) {
      await page.addScriptTag({ path: path.resolve(__dirname, "../../extension", relative) });
    }
    return page;
  }

  await t.test("the real iframe layout yields all paragraphs through the signature", async (st) => {
    const page = await fixture(st);
    const before = await page.locator("iframe").evaluate(e => e.contentDocument.body.innerHTML);
    const doc = await page.evaluate(() => ConsAdapters.onlineApp.extractCurrentDocument({format:"md"}));
    assert.equal(doc.text, BODY.join("\n\n"));
    assert.doesNotMatch(doc.text, /SUMMARY_ONLY|Краткий пересказ|Справка к документу|BANNER_SENTINEL|ИИ/u);
    assert.match(doc.html, /Судья И\.И\.ИВАНОВ/u);
    assert.equal(await page.locator("iframe").evaluate(e => e.contentDocument.body.innerHTML), before);
  });

  await t.test("delayed body and a visible loader cannot be mistaken for a complete act", async (st) => {
    const page = await fixture(st, {frame: documentFrame(["АРБИТРАЖНЫЙ СУД"])});
    const doc = await page.evaluate(async (last) => {
      const frame = document.querySelector("iframe").contentDocument;
      frame.querySelector(".documentLoader").style.display = "block";
      setTimeout(() => {
        frame.querySelector("#z0").insertAdjacentHTML("beforeend", `<div parnum="1">${last}</div>`);
        frame.querySelector(".documentLoader").style.display = "none";
      }, 1700);
      return ConsAdapters.onlineApp.extractCurrentDocument({format:"md"});
    }, "ПОСТАНОВИЛ: оставить без изменения. Судья.");
    assert.match(doc.text, /ПОСТАНОВИЛ: оставить без изменения\. Судья\./u);
  });

  await t.test("stability restarts when the body changes without a loader", async (st) => {
    const page = await fixture(st, {frame: documentFrame(["Начало акта"])});
    const doc = await page.evaluate(async () => {
      const frame = document.querySelector("iframe").contentDocument;
      setTimeout(() => frame.querySelector("#z0").insertAdjacentHTML("beforeend", '<div parnum="1">Конец акта</div>'), 800);
      return ConsAdapters.onlineApp.extractCurrentDocument({format:"md"});
    });
    assert.equal(doc.text, "Начало акта\n\nКонец акта");
  });

  await t.test("summary-only, inaccessible and partial sources are not accepted", async (st) => {
    const page = await fixture(st);
    for (const scenario of ["unrendered", "gap", "virtualized", "no-body", "two-frames", "cross-origin", "summary-only"]) {
      await page.goto(SOURCE);
      for (const relative of ["shared/content-cleaner.js", "content/adapters/online-app.js"]) {
        await page.addScriptTag({ path: path.resolve(__dirname, "../../extension", relative) });
      }
      const snapshot = await page.evaluate((scenario) => {
        const frame = document.querySelector("iframe");
        const inner = frame.contentDocument;
        if (scenario === "unrendered") inner.querySelector("#z0").setAttribute("rendered", "0");
        if (scenario === "gap") inner.querySelector('[parnum="1"]').remove();
        if (scenario === "virtualized") inner.querySelector(".document.content").classList.remove("flat");
        if (scenario === "no-body") inner.querySelector(".document.content").remove();
        if (scenario === "two-frames") { const other = frame.cloneNode(); other.srcdoc = inner.documentElement.outerHTML; document.body.append(other); }
        if (scenario === "cross-origin") frame.src = "https://unavailable.invalid/document_inner.htm";
        if (scenario === "summary-only") frame.remove();
        return Boolean(ConsAdapters.onlineApp._documentTextSnapshot());
      }, scenario);
      assert.equal(snapshot, false, scenario);
    }
  });

  await t.test("legal text mentioning AI remains intact inside the actual act", async (st) => {
    const paragraphs = ["Суд установил:", "Подготовлено с использованием искусственного интеллекта", "Эта надпись исследована судом как доказательство."];
    const page = await fixture(st, {frame:documentFrame(paragraphs)});
    const doc = await page.evaluate(() => ConsAdapters.onlineApp.extractCurrentDocument({format:"md"}));
    assert.equal(doc.text, paragraphs.join("\n\n"));
  });

  await t.test("legacy inline layout is supported but a bare reference panel is rejected", async (st) => {
    const page = await fixture(st, {shell:'<main class="pageContainer x-page-document-content"><p>Полный inline текст</p><div hidden>Скрытая панель</div></main>'});
    const doc = await page.evaluate(() => ConsAdapters.onlineApp.extractCurrentDocument({format:"md"}));
    assert.equal(doc.text, "Полный inline текст");
    await page.evaluate((summary) => { document.querySelector("main").innerHTML = summary; }, summary);
    assert.equal(await page.evaluate(() => ConsAdapters.onlineApp._documentTextSnapshot()), null);
  });
});
