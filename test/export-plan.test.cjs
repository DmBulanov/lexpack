const assert = require("node:assert/strict");
const test = require("node:test");

const { consBuildExportPlan, consRebuildExportPlan } = require("../extension/shared/export-plan.js");
const { consCreateDefaultProfile } = require("../extension/shared/profile-storage.js");

test("arbitrary selection preserves source order and renumbers only selected rows", () => {
  const items = Array.from({ length: 5 }, (_value, index) => ({
    index: index + 1,
    title: `Документ ${index + 1}`,
    url: `https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=ARB&n=${index + 1}`,
  }));
  const plan = consBuildExportPlan({
    adapter: "online-app",
    items,
    selectedSourceIndexes: [2, 5],
    profile: consCreateDefaultProfile({}, Date.UTC(2026, 6, 21)),
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.selectedCount, 2);
  assert.deepEqual(plan.items.map((item) => item.sourceIndex), [2, 5]);
  assert.deepEqual(plan.items.map((item) => item.exportIndex), [1, 2]);
  assert.deepEqual(plan.items.map((item) => item.plannedFilename), [
    "01 - Документ 2.docx", "02 - Документ 5.docx",
  ]);
  assert.deepEqual(consRebuildExportPlan(plan).items, plan.items);
});

test("Markdown plans derive English and Russian filenames from source document names", () => {
  const profile = {
    ...consCreateDefaultProfile({}, Date.UTC(2026, 6, 21)),
    format: "md",
    filenameTemplate: "{title}",
  };
  const plan = consBuildExportPlan({
    adapter: "online-app",
    items: [
      {
        index: 1,
        title: "document.pdf",
        url: "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=ARB&n=1",
      },
      {
        index: 2,
        title: "Решение суда.docx",
        url: "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=ARB&n=2",
      },
    ],
    profile,
  });

  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.items.map((item) => item.plannedFilename),
    ["document.md", "Решение суда.md"]
  );
});

test("a zero selection is blocked and missing metadata is visible in a custom plan", () => {
  const profile = {
    ...consCreateDefaultProfile({}, Date.UTC(2026, 6, 21)),
    format: "pdf",
    filenameTemplate: "{date}_{case}_{documentType}",
    folderTemplate: "LexPack/{query}/{instance}",
  };
  const none = consBuildExportPlan({ items: [{ index: 1, title: "x" }], selectedSourceIndexes: [], profile });
  assert.equal(none.ok, false);
  assert.ok(none.errors.some((error) => error.code === "NO_SELECTED_ITEMS"));

  const plan = consBuildExportPlan({
    adapter: "online-app",
    query: "аренда",
    items: [{
      index: 2,
      title: "Решение по делу А40-1/2025",
      instanceLabel: "Первая инстанция",
      url: "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=ARB&n=2",
    }],
    profile,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.items[0].plannedRelativeFolder, "LexPack/аренда/Первая инстанция");
  assert.match(plan.items[0].plannedFilename, /А40-1 2025_Решение\.pdf$/u);
  assert.ok(plan.items[0].warnings.some((warning) => warning.token === "date"));
});

for (const [format, extension] of [["docx-one", "docx"], ["md-one", "md"]]) {
  test(`${format} plans one file without internal collisions and preserve selection order`, () => {
    const profile = {
      ...consCreateDefaultProfile(), format,
      filenameTemplate: "{title}", folderTemplate: "LexPack/{instance}",
    };
    const items = Array.from({ length: 5 }, (_, offset) => ({
      index: offset + 1, title: `Документ ${offset + 1}.pdf`,
      url: `https://online.consultant.ru/?req=doc&base=ARB&n=${offset + 1}`,
      instance: null, instanceLabel: "Неизвестная судебная ветка",
    }));
    const plan = consBuildExportPlan({ adapter: "online-app", items, selectedSourceIndexes: [5, 2], profile });
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.items.map((item) => item.sourceIndex), [2, 5]);
    assert.equal(plan.mergedFile.plannedFilename, `Неизвестная судебная ветка.${extension}`);
    assert.equal(plan.mergedFile.plannedRelativeFolder, "LexPack/Неизвестная судебная ветка");
    assert.equal(new Set(plan.items.map((item) => item.plannedRelativePath)).size, 1);
    assert.ok(plan.items.every((item) => item.collisionResolution.internal === false));
    assert.deepEqual(consRebuildExportPlan(plan).items, plan.items);
    assert.deepEqual(consRebuildExportPlan(plan).mergedFile, plan.mergedFile);
  });
}

test("merged collection names use the query and their folder uses only a common prefix", () => {
  const plan = consBuildExportPlan({
    query: "Русский запрос", adapter: "online-app",
    profile: { ...consCreateDefaultProfile(), format: "md-one", filenameTemplate: "{title}", folderTemplate: "LexPack/{instance}/Акты" },
    items: [
      { index: 1, title: "First", instanceLabel: "Первая ветка" },
      { index: 2, title: "Второй", instanceLabel: "Другая ветка" },
    ],
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.mergedFile.plannedRelativePath, "LexPack/Русский запрос.md");
  assert.equal(plan.reportRelativeFolder, "LexPack");
});

test("one-document merged plans replace English and Russian source extensions", () => {
  for (const title of ["document.pdf", "Решение.docx"]) {
    for (const format of ["docx-one", "md-one"]) {
      const plan = consBuildExportPlan({
        items: [{ index: 1, title }],
        profile: { ...consCreateDefaultProfile(), format, filenameTemplate: "{title}" },
      });
      assert.equal(plan.ok, true);
      assert.equal(plan.mergedFile.plannedFilename, title.replace(/\.[^.]+$/u, format === "docx-one" ? ".docx" : ".md"));
    }
  }
});

test("merged warnings describe the shared filename rather than discarded per-source names", () => {
  const plan = consBuildExportPlan({
    query: "Подборка",
    profile: { ...consCreateDefaultProfile(), format: "md-one", filenameTemplate: "{date}_{title}" },
    items: [{ index: 1, title: "Первый" }, { index: 2, title: "Второй" }],
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.mergedFile.plannedFilename, "Подборка.md");
  for (const item of plan.items) {
    assert.equal(item.warnings.filter((warning) => warning.token === "date").length, 1);
    assert.ok(item.cleanupRulesApplied.filename.includes("missing-token-components-removed"));
  }
});

test("a tree group keeps its own name when merging materials from different courts", () => {
  for (const format of ["docx-one", "md-one"]) {
    const plan = consBuildExportPlan({
      collection: { scope: "tree-branch", label: "Кассационные суды общей юрисдикции" },
      profile: { ...consCreateDefaultProfile(), format, filenameTemplate: "{title}" },
      items: [
        { index: 1, title: "Первый акт", instanceLabel: "1 кассационный суд" },
        { index: 2, title: "Другой акт", instanceLabel: "Неизвестный суд" },
      ],
    });
    assert.equal(plan.ok, true);
    assert.equal(plan.mergedFile.title, "Кассационные суды общей юрисдикции");
    assert.deepEqual(plan.items.map((item) => item.instanceLabel), ["1 кассационный суд", "Неизвестный суд"]);
    assert.deepEqual(consRebuildExportPlan(plan).mergedFile, plan.mergedFile);
    assert.deepEqual(consRebuildExportPlan(plan).collection, plan.collection);
  }
});
