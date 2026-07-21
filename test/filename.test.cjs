const assert = require("node:assert/strict");
const test = require("node:test");

const {
  consSafeDownloadFilename,
  consSafeFilename,
  consUtf8Length,
} = require("../extension/shared/filename.js");

test("safe filenames remove path syntax and Windows reserved device names", () => {
  assert.equal(consSafeFilename("../Дело: 42", 1, ".PDF"), "01 - .. Дело 42.pdf");
  assert.equal(consSafeFilename("CON", 2, "docx"), "02 - _CON.docx");
  assert.equal(consSafeFilename("LPT1.report", 3, "rtf"), "03 - _LPT1.report.rtf");
});

test("safe filenames constrain extension and tolerate invalid indexes", () => {
  assert.equal(consSafeFilename("Документ", -1, "ht!ml"), "Документ.html");
  assert.equal(consSafeFilename("***", 4, ""), "04 - document.txt");
});

test("download-boundary filenames cannot smuggle paths or reserved device names", () => {
  assert.equal(consSafeDownloadFilename("../../CON.pdf"), "_CON.pdf");
  assert.equal(consSafeDownloadFilename("folder\\акт.docx"), "акт.docx");
  assert.equal(consSafeDownloadFilename("NUL", "json"), "_NUL.json");
  assert.ok(consUtf8Length(consSafeDownloadFilename(`${"界".repeat(300)}.pdf`)) <= 240);
});
