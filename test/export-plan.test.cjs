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
