const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MAX_MERGED_BYTES,
  consMergedDocumentPart,
  consBuildMergedDocument,
} = require("../extension/shared/merged-document.js");
const { consInspectDocxArchive } = require("../extension/shared/docx-sanitizer.js");

const RAW = "# Русский заголовок\r\n\r\n**жирный** & <raw-tag>\r\n`код_[x]` 😀 е\u0308\t42\r\n";
const NOTE = "> КонсультантПлюс: примечание.\nВ примечании КонсультантПлюс остаётся **без изменений**.\n";
const PARTS = [{ title: "Решение суда", body: RAW }, { title: "English act", body: NOTE }];

test("merged Markdown adds only ordered headings and separators, preserving raw UTF-8 bodies", () => {
  const result = consBuildMergedDocument(PARTS, "md-one");
  const expected = `# 1. Решение суда\n\n${RAW}\n\n---\n\n# 2. English act\n\n${NOTE}`;
  assert.equal(result.mime, "text/markdown; charset=utf-8");
  assert.deepEqual(Buffer.from(result.data, "utf8"), Buffer.from(expected, "utf8"));
  assert.doesNotMatch(result.data, /&amp;|&lt;|\\\*/u);
});

test("merged parts prefer converted Markdown, clean only the heading, and protect notes", () => {
  const part = consMergedDocumentPart({
    title: "Решение\r\nКонсультантПлюс",
    markdown: RAW,
    text: "fallback must not replace converted Markdown",
  });
  assert.equal(part.title, "Решение");
  assert.equal(part.body, RAW);
  assert.equal(consMergedDocumentPart({ text: NOTE }).body, NOTE);
  assert.throws(() => consMergedDocumentPart({ text: "Источник КонсультантПлюс" }), /неочищ/u);
  assert.throws(() => consMergedDocumentPart({ text: " \n\t" }), /не содержит текста/u);
});

test("merged DOCX is a valid OOXML package with ordered texts, UTF-8, tabs and page breaks", async () => {
  const result = consBuildMergedDocument(PARTS, "docx-one");
  assert.equal(result.mime, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const archive = await consInspectDocxArchive(result.data);
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(archive["word/document.xml"]);
  for (const name of ["[Content_Types].xml", "_rels/.rels", "word/styles.xml", "word/_rels/document.xml.rels"]) {
    assert.ok(archive[name], `missing ${name}`);
  }
  assert.match(xml, /&amp; &lt;raw-tag&gt;/u);
  assert.match(xml, /😀 е\u0308/u);
  assert.match(xml, /<w:tab\/>/u);
  assert.equal((xml.match(/<w:pageBreakBefore\/>/gu) || []).length, 1);
  assert.equal((xml.match(/w:pStyle w:val="Heading1"/gu) || []).length, 2);
  assert.ok(xml.indexOf("1. Решение суда") < xml.indexOf("2. English act"));
  assert.ok(xml.indexOf("2. English act") < xml.indexOf("КонсультантПлюс: примечание"));
  assert.match(xml, /В примечании КонсультантПлюс остаётся \*\*без изменений\*\*\./u);
});

test("merged exports reject missing items, unsupported formats and invalid DOCX characters", () => {
  assert.throws(() => consBuildMergedDocument([], "md-one"), /от 1 до 200/u);
  assert.throws(() => consBuildMergedDocument(Array(201).fill(PARTS[0]), "md-one"), /от 1 до 200/u);
  assert.throws(() => consBuildMergedDocument(PARTS, "pdf"), /Неподдерживаемый формат/u);
  for (const body of ["invalid\u0001", "invalid\ud800", "invalid\uffff"]) {
    assert.throws(() => consBuildMergedDocument([{ title: "Act", body }], "docx-one"), /недопустимые/u);
  }
});

test("merged exports bound both source size and the expanded DOCX markup", () => {
  assert.throws(() => consMergedDocumentPart({ text: "x".repeat(MAX_MERGED_BYTES) }), /32 МБ/u);
  const oversized = [{ title: "Act", body: "x".repeat(MAX_MERGED_BYTES / 2) }];
  assert.throws(() => consBuildMergedDocument([...oversized, ...oversized], "md-one"), /32 МБ/u);
  // The raw source is small enough, but tabs expand into much larger Word XML.
  assert.throws(() => consBuildMergedDocument([{ title: "Act", body: `x${"\t".repeat(600000)}` }], "docx-one"), /32 МБ/u);
});
