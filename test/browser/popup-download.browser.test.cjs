const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright");
const { consInspectDocxArchive } = require("../../extension/shared/docx-sanitizer.js");
const { documentShell, documentFrame } = require("../fixtures/online-document.cjs");
const LABEL = "Акты специального судебного состава";
const TITLES = ["Решение суда.pdf", "English act.docx"];
const BODY = (index) => `FULL_ACT_${index}: русский текст **без экранирования** & <tag>. Судья.`;

function listPage() {
  return `<!doctype html><meta charset="utf-8"><title>Ручная судебная подборка</title>
  <aside><div class="x-page-search-tree-item x-page-search-tree-item--no-select" aria-level="1"><span class="x-page-search-tree-item__name">Судебная практика</span></div>
  <div class="x-page-search-tree-item x-page-search-tree-item--current" aria-level="2"><span class="x-page-search-tree-item__name">${LABEL}</span></div></aside>
  <div class="x-page-search-results-header__name">${LABEL}</div>
  <div class="x-page-search-results-header__counter">[1:2]</div>
  <div class="x-list x-page-search-results__list">${TITLES.map((title,index) => `<a class="x-page-components-search-result-item__extra-title" href="?req=doc&base=ARB&n=${index+1}"><div class="TH">${title}</div></a>`).join("")}</div>`;
}

for (const variant of ["chrome", "chromium-gost"]) {
test(`${variant}: collection actions live in the popup and Download now exports its visible settings`, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lexpack-popup-download-"));
  const downloadsPath = path.join(root, "downloads");
  const profile = path.join(root, "profile");
  await fs.mkdir(downloadsPath);
  await fs.mkdir(path.join(profile, "Default"), { recursive: true });
  await fs.writeFile(path.join(profile, "Default/Preferences"), JSON.stringify({
    download: { default_directory: downloadsPath, prompt_for_download: false, directory_upgrade: true },
  }));
  const extensionPath = path.resolve(__dirname, `../../build/${variant}`);
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true, acceptDownloads: true, downloadsPath,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  t.after(async () => { await context.close(); await fs.rm(root, {recursive:true,force:true}); });
  await context.route("https://online.consultant.ru/**", (route) => {
    const url = new URL(route.request().url());
    const index = Number(url.searchParams.get("n"));
    const body = url.pathname.endsWith("document_inner.htm")
      ? documentFrame([BODY(index)])
      : url.searchParams.get("req") === "doc"
        ? documentShell(TITLES[index-1], `/riv/static-test/document_inner.htm?n=${index}`)
        : listPage();
    return route.fulfill({contentType:"text/html; charset=utf-8",body});
  });
  let [worker] = context.serviceWorkers();
  worker ||= await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).hostname;
  const source = await context.newPage();
  let popup = await context.newPage();
  const policy = await context.newCDPSession(source);
  await policy.send("Browser.setDownloadBehavior", {behavior:"allow",downloadPath:downloadsPath});
  await policy.detach();

  async function open() {
    await worker.evaluate(() => chrome.storage.session.remove("searchCollection"));
    await source.goto("https://online.consultant.ru/riv/cgi/online.cgi?page=list&cacheid=popup");
    if (popup.isClosed()) popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await source.bringToFront();
    await popup.reload();
    await popup.waitForFunction(() => !document.querySelector("#btnExport").disabled);
  }
  async function snapshot() {
    return worker.evaluate(async () => ({
      jobId: (await chrome.storage.session.get("exportJob")).exportJob?.id,
      downloads: (await chrome.downloads.search({})).map(file=>file.id),
    }));
  }
  async function finished(previous) {
    return worker.evaluate(async (previous) => {
      for (let attempt=0;attempt<400;attempt++) {
        const job=(await chrome.storage.session.get("exportJob")).exportJob;
        if (job?.id !== previous && job?.historySaved) {
          if(job.status!=="done")throw new Error(job.lastError || JSON.stringify(job));
          return job;
        }
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      throw new Error("Download did not finish");
    },previous);
  }

  await t.test("two stacked popup buttons replace the hover toolbar; Configure opens only the planner", async () => {
    await open();
    const quick = popup.locator("#btnDownloadNow");
    const configure = popup.locator("#btnExport");
    assert.equal(await quick.innerText(), "Скачать сразу · 2");
    assert.equal(await configure.innerText(), "Настроить выгрузку · 2");
    const top = await quick.boundingBox();
    const bottom = await configure.boundingBox();
    assert.ok(top.y+top.height < bottom.y);
    assert.equal(top.x,bottom.x);
    assert.equal(top.width,bottom.width);
    await source.locator(".x-page-search-tree-item--current").hover();
    assert.equal(await source.locator("[data-lexpack-tree-download]").count(),0);
    const before=await snapshot();
    const created=context.waitForEvent("page");
    await configure.click();
    const planner=await created;
    await planner.locator("#documentRows tr").nth(1).waitFor();
    assert.equal(await planner.locator("#startExport").isEnabled(),true);
    assert.deepEqual(await snapshot(),before);
    await planner.close();
  });

  for (const format of ["md","md-one","docx-one"]) {
    await t.test(`Download now saves ${format} without a planner and honors format/folder controls`, async () => {
      await open();
      await worker.evaluate(async () => {
        const now=new Date().toISOString();
        const profile={schemaVersion:1,id:"quick",name:"Шаблон юриста",format:"pdf",filenameTemplate:"{title}",folderTemplate:"Wrong-profile-folder",collisionPolicy:"ordered-suffix",createdAt:now,updatedAt:now};
        const state=(await chrome.storage.local.get("exportProfileState")).exportProfileState;
        await chrome.storage.local.set({exportProfileState:{...state,selectedProfileId:"quick",profiles:[...state.profiles.filter(saved=>saved.id!=="quick"),profile]}});
      });
      await popup.locator("#format").selectOption(format);
      await popup.locator("#downloadFolder").fill("LexPack/Выбранная папка");
      const before=await snapshot();
      const pages=[];
      const opened=page=>pages.push(page);
      context.on("page",opened);
      try {
        await popup.locator("#btnDownloadNow").click();
        assert.equal(await popup.locator("#btnExport").isEnabled(),false);
        assert.equal(await popup.locator("#btnDownloadNow").isEnabled(),false);
        const job=await finished(before.jobId);
        assert.equal(job.format,format);
        assert.equal(job.profileSnapshot.id,"quick");
        assert.equal(job.profileSnapshot.folderTemplate,"LexPack/Выбранная папка");
        assert.equal(job.items.length,2);
        assert.ok(job.items.every(item=>item.status==="completed"));
        assert.equal(pages.some(page=>page.url().includes("/planner/planner.html")),false);
        const files=(await worker.evaluate(()=>chrome.downloads.search({})))
          .filter(file=>!before.downloads.includes(file.id)&&!file.filename.endsWith(".json"));
        assert.equal(files.length,format==="md"?2:1);
        for(const file of files)assert.ok((await fs.realpath(file.filename)).startsWith(path.join(await fs.realpath(downloadsPath),"LexPack","Выбранная папка")+path.sep));
        if(format==="md") {
          assert.deepEqual(files.map(file=>path.basename(file.filename)).sort(),["English act.md","Решение суда.md"]);
          for(const [index,title] of TITLES.entries()) {
            const file=files.find(file=>path.basename(file.filename)===title.replace(/\.(pdf|docx)$/,".md"));
            assert.deepEqual(await fs.readFile(file.filename),Buffer.from(BODY(index+1),"utf8"));
          }
        } else {
          assert.equal(path.basename(files[0].filename),`${LABEL}.${format==="md-one"?"md":"docx"}`);
          const bytes=await fs.readFile(files[0].filename);
          const text=format==="md-one"?bytes.toString("utf8"):new TextDecoder().decode((await consInspectDocxArchive(bytes))["word/document.xml"]);
          assert.ok(text.indexOf("FULL_ACT_1")<text.indexOf("FULL_ACT_2"));
          assert.doesNotMatch(text,/SUMMARY_ONLY_SENTINEL|Краткий пересказ|Справка к документу/u);
        }
      } finally {context.off("page",opened);}
    });
  }

  await t.test("changing the selected court cannot silently export the old collection", async () => {
    await open();
    const before=await snapshot();
    await source.evaluate(() => {
      document.querySelector(".x-page-search-tree-item--current .x-page-search-tree-item__name").textContent="Другой суд";
      document.querySelector(".x-page-search-results-header__name").textContent="Другой суд";
    });
    await popup.locator("#btnDownloadNow").click();
    await popup.waitForFunction(()=>document.querySelector("#log").textContent.includes("Выдача изменилась"));
    assert.deepEqual(await snapshot(),before);
  });

  await t.test("an incomplete cached collection does not start an export", async () => {
    await open();
    const before=await snapshot();
    await worker.evaluate(async () => {
      const collection=(await chrome.storage.session.get("searchCollection")).searchCollection;
      await chrome.storage.session.set({searchCollection:{...collection,incomplete:true,totalKnown:true,total:14}});
    });
    await popup.locator("#btnDownloadNow").click();
    await popup.waitForFunction(()=>document.querySelector("#log").textContent.includes("Подборка собрана не полностью"));
    assert.deepEqual(await snapshot(),before);
  });
});
}
