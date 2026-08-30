const assert = require("node:assert/strict");
const test = require("node:test");

const { consSafeFilename } = require("../extension/shared/filename.js");

test("safe filenames remove path syntax and Windows reserved device names", () => {
  assert.equal(consSafeFilename("../Дело: 42", 1, ".PDF"), "01 - .. Дело 42.pdf");
  assert.equal(consSafeFilename("CON", 2, "docx"), "02 - _CON.docx");
  assert.equal(consSafeFilename("LPT1.report", 3, "pdf"), "03 - _LPT1.report.pdf");
});

test("Markdown filenames replace PDF and DOCX extensions for English and Russian names", () => {
  assert.equal(consSafeFilename("document.pdf", undefined, "md"), "document.md");
  assert.equal(consSafeFilename("Решение суда.docx", undefined, "md"), "Решение суда.md");
  assert.equal(consSafeFilename("АРХИВ.PDF", undefined, "md"), "АРХИВ.md");
  assert.equal(consSafeFilename("notes.md", undefined, "md"), "notes.md");
});

test("safe filenames constrain extension and tolerate invalid indexes", () => {
  assert.equal(consSafeFilename("Документ", -1, "ht!ml"), "Документ.html");
  assert.equal(consSafeFilename("***", 4, ""), "04 - document.txt");
});
