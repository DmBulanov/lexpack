const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");

const cleanerPath = path.resolve(
  __dirname,
  "../../extension/shared/content-cleaner.js"
);

test("DOM cleanup respects structural boundaries and preserves only explicit notes", async (t) => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html lang="ru"><body>
    <main id="document">
      <p id="ordinary">Источник: <span>Консультант</span><b>Плюс</b>, текст.</p>
      <p id="quoted">См. КонсультантПлюс: примечание в цитате.</p>
      <p id="note"><span>Консультант</span><b>Плюс</b>: примечание. КонсультантПлюс сохраняется.</p>
      <div class="note" id="multi-note">
        <p>КонсультантПлюс: примечание.</p>
        <p>Весь блок с КонсультантПлюс и consultant.ru сохраняется.</p>
        <mark class="search-highlight">Выделение внутри примечания</mark>
      </div>
      <div id="generic-following-clean">
        <p id="marked-paragraph">КонсультантПлюс: примечание. КонсультантПлюс сохраняется.</p>
        <p id="clean-after-note">Обычный юридический абзац без бренда.</p>
      </div>
      <div class="notebook" id="notebook">
        <p id="notebook-ordinary">Обычный Consultant Plus удаляется.</p>
      </div>
      <p id="first">Консультант</p><p id="second">Плюс</p>
      <p id="line-boundary">Юридический Консультант<br>Плюс новый подход.</p>
      <div id="nested-boundary">Консультант<p>вложенный текст</p>Плюс</div>
      <p id="domain">Сайт www.consultant.ru удаляется.</p>
      <img id="image" alt="Логотип Консультант +" title="КонсультантПлюс: примечание">
      <p><mark id="ordinary-mark"><span id="ordinary-hit">важный текст</span></mark></p>
      <p><mark id="search-mark" class="search-highlight"><span id="search-hit">найденный текст</span></mark></p>
      <button id="junk">Скачать КонсультантПлюс</button>
    </main>
  </body></html>`);
  await page.addScriptTag({ path: cleanerPath });

  const result = await page.evaluate(() => {
    const root = document.querySelector("#document");
    const stats = consCleanConsultantDocument(root, {
      removeSelectors: ["button"],
    });
    const serialized = consSerializeConsultantText(root);
    return {
      stats,
      serialized,
      validatedSame: consAssertConsultantTextClean(serialized) === serialized,
      ordinary: document.querySelector("#ordinary").textContent,
      quoted: document.querySelector("#quoted").textContent,
      note: document.querySelector("#note").textContent,
      multiNote: document.querySelector("#multi-note").textContent,
      multiNoteMark: Boolean(document.querySelector("#multi-note mark.search-highlight")),
      singleNote: document.querySelector("#marked-paragraph").textContent,
      cleanAfterNote: document.querySelector("#clean-after-note").textContent,
      notebookOrdinary: document.querySelector("#notebook-ordinary").textContent,
      first: document.querySelector("#first").textContent,
      second: document.querySelector("#second").textContent,
      lineBoundary: document.querySelector("#line-boundary").innerHTML,
      nestedBoundary: document.querySelector("#nested-boundary").innerHTML,
      domain: document.querySelector("#domain").textContent,
      alt: document.querySelector("#image").getAttribute("alt"),
      title: document.querySelector("#image").getAttribute("title"),
      ordinaryMarkExists: Boolean(document.querySelector("#ordinary-mark")),
      ordinaryHitExists: Boolean(document.querySelector("#ordinary-hit")),
      searchMarkExists: Boolean(document.querySelector("#search-mark")),
      searchHitExists: Boolean(document.querySelector("#search-hit")),
      junkExists: Boolean(document.querySelector("#junk")),
    };
  });

  assert.equal(result.ordinary, "Источник: , текст.");
  assert.equal(result.quoted, "См. : примечание в цитате.");
  assert.equal(
    result.note,
    "КонсультантПлюс: примечание. КонсультантПлюс сохраняется."
  );
  assert.match(result.multiNote, /Весь блок с КонсультантПлюс и consultant\.ru сохраняется\./u);
  assert.equal(result.multiNoteMark, true);
  assert.equal(
    result.singleNote,
    "КонсультантПлюс: примечание. КонсультантПлюс сохраняется."
  );
  assert.equal(result.cleanAfterNote, "Обычный юридический абзац без бренда.");
  assert.equal(result.validatedSame, true);
  assert.match(
    result.serialized,
    /КонсультантПлюс: примечание\.\nВесь блок с КонсультантПлюс и consultant\.ru сохраняется\.\nВыделение внутри примечания/u
  );
  assert.match(
    result.serialized,
    /КонсультантПлюс: примечание\. КонсультантПлюс сохраняется\.\n\nОбычный юридический абзац без бренда\./u
  );
  assert.equal(result.notebookOrdinary, "Обычный  удаляется.");
  assert.equal(result.first, "Консультант");
  assert.equal(result.second, "Плюс");
  assert.equal(result.lineBoundary, "Юридический Консультант<br>Плюс новый подход.");
  assert.equal(result.nestedBoundary, "Консультант<p>вложенный текст</p>Плюс");
  assert.equal(result.domain, "Сайт  удаляется.");
  assert.equal(result.alt, "Логотип ");
  assert.equal(result.title, ": примечание");
  assert.equal(result.ordinaryMarkExists, true);
  assert.equal(result.ordinaryHitExists, true);
  assert.equal(result.searchMarkExists, false);
  assert.equal(result.searchHitExists, true);
  assert.equal(result.junkExists, false);
  assert.equal(result.stats.remainingMentions, 0);
  assert.equal(result.stats.protectedNotes, 3);
  assert.equal(result.stats.searchMarksUnwrapped, 1);
  assert.ok(result.stats.mentionsRemoved >= 6);
});

test("ambiguous generic multi-paragraph notes fail before mutating the document", async (t) => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html lang="ru"><body>
    <main id="document">
      <p>КонсультантПлюс: примечание. Начало примечания.</p>
      <p id="note-body">Продолжение примечания с КонсультантПлюс.</p>
    </main>
  </body></html>`);
  await page.addScriptTag({ path: cleanerPath });

  const result = await page.evaluate(() => {
    const root = document.querySelector("#document");
    try {
      consCleanConsultantDocument(root);
      return { code: null, body: document.querySelector("#note-body").textContent };
    } catch (error) {
      return { code: error.code, body: document.querySelector("#note-body").textContent };
    }
  });

  assert.equal(result.code, "CONTENT_NOTE_BOUNDARY_AMBIGUOUS");
  assert.equal(result.body, "Продолжение примечания с КонсультантПлюс.");
});

test("a heading is an explicit boundary after a standalone note", async (t) => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html lang="ru"><body>
    <main id="document">
      <p id="note">КонсультантПлюс: примечание. КонсультантПлюс сохраняется.</p>
      <h2>Следующий раздел</h2>
      <p id="ordinary">Обычный текст с online.consultant.ru.</p>
    </main>
  </body></html>`);
  await page.addScriptTag({ path: cleanerPath });

  const result = await page.evaluate(() => {
    const root = document.querySelector("#document");
    const stats = consCleanConsultantDocument(root);
    return {
      stats,
      note: document.querySelector("#note").textContent,
      ordinary: document.querySelector("#ordinary").textContent,
    };
  });

  assert.equal(
    result.note,
    "КонсультантПлюс: примечание. КонсультантПлюс сохраняется."
  );
  assert.equal(result.ordinary, "Обычный текст с .");
  assert.equal(result.stats.protectedNotes, 1);
  assert.equal(result.stats.remainingMentions, 0);
});

test("a nested heading wrapper is an explicit boundary after a note", async (t) => {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html lang="ru"><body>
    <main id="document">
      <p id="note">КонсультантПлюс: примечание. КонсультантПлюс сохраняется.</p>
      <div><span aria-hidden="true"></span><header><h2>Следующий раздел</h2></header><p id="ordinary">Обычный Consultant Plus.</p></div>
    </main>
  </body></html>`);
  await page.addScriptTag({ path: cleanerPath });

  const result = await page.evaluate(() => {
    const root = document.querySelector("#document");
    const stats = consCleanConsultantDocument(root);
    return {
      stats,
      note: document.querySelector("#note").textContent,
      ordinary: document.querySelector("#ordinary").textContent,
    };
  });

  assert.equal(
    result.note,
    "КонсультантПлюс: примечание. КонсультантПлюс сохраняется."
  );
  assert.equal(result.ordinary, "Обычный .");
  assert.equal(result.stats.protectedNotes, 1);
  assert.equal(result.stats.remainingMentions, 0);
});
