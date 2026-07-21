const assert = require("node:assert/strict");
const test = require("node:test");

const {
  consRenderFilenameTemplate,
  consRenderFolderTemplate,
  consResolvePathCollisions,
  consValidateTemplate,
} = require("../extension/shared/template-engine.js");

const context = {
  index: 1,
  total: 120,
  title: "Решение по аренде",
  query: "аренда",
  instance: "Первая инстанция",
  date: { value: "2025-03-14" },
  court: { value: "Арбитражный суд Москвы" },
  case: { value: "А40-12345/2024" },
  documentType: { value: "Решение" },
};

test("filename templates render every supported token and add one extension", () => {
  const result = consRenderFilenameTemplate(
    "{index}_{title}_{query}_{instance}_{date}_{court}_{case}_{documentType}_{format}.pdf",
    {
      ...context,
      title: "Акт",
      query: "иск",
      instance: "I",
      court: { value: "АС" },
      case: { value: "А1-2/25" },
      documentType: { value: "Решение" },
    },
    "pdf"
  );
  assert.equal(result.ok, true);
  assert.equal(result.filename, "001_Акт_иск_I_2025-03-14_АС_А1-2 25_Решение_pdf.pdf");
  assert.doesNotMatch(result.filename, /\.pdf\.pdf$/u);
});

test("unknown tokens block a profile", () => {
  const result = consValidateTemplate("{client} - {title}", "filename");
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, "UNKNOWN_TOKEN");
  assert.equal(result.errors[0].token, "client");
});

test("missing known values are removed with separators and reported", () => {
  const result = consRenderFilenameTemplate(
    "{date}_{case}_{documentType}",
    { ...context, date: { value: null }, case: { value: null } },
    "docx"
  );
  assert.equal(result.filename, "Решение.docx");
  assert.deepEqual(result.missingTokens, ["date", "case"]);
  assert.ok(result.warnings.every((warning) => warning.code === "MISSING_TOKEN_VALUE"));
});

test("empty output falls back, whitespace is stable, and names are bounded", () => {
  const fallback = consRenderFilenameTemplate("{date}___", {
    index: 2,
    total: 5,
    title: "  Документ   с   пробелами  ",
    date: { value: null },
  }, "txt");
  assert.equal(fallback.filename, "02 - Документ с пробелами.txt");
  assert.equal(fallback.fallbackUsed, true);

  const long = consRenderFilenameTemplate("{title}", {
    title: "Ю".repeat(500), index: 1, total: 1,
  }, "pdf");
  assert.ok(new TextEncoder().encode(long.filename).byteLength <= 240);
});

test("reserved names, Unicode normalization, and index widths are deterministic", () => {
  assert.equal(
    consRenderFilenameTemplate("{title}", { title: "CON", index: 1, total: 1 }, "txt").filename,
    "_CON.txt"
  );
  assert.equal(
    consRenderFilenameTemplate("{index}-{title}", { title: "е\u0308ж", index: 7, total: 9 }, "txt").filename,
    "07-ёж.txt"
  );
  assert.equal(
    consRenderFilenameTemplate("{index}", { index: 12, total: 99 }, "txt").filename,
    "12.txt"
  );
  assert.equal(
    consRenderFilenameTemplate("{index}", { index: 100, total: 200 }, "txt").filename,
    "100.txt"
  );
});

test("folder templates allow bounded nesting and sanitize token values", () => {
  const result = consRenderFolderTemplate("LexPack/{query}\\{instance}", {
    query: "аренда/лизинг",
    instance: "Первая",
  });
  assert.equal(result.ok, true);
  assert.equal(result.folder, "LexPack/аренда_лизинг/Первая");
});

test("folder templates reject traversal, absolute, drive, UNC, URL, and excess nesting", () => {
  for (const value of ["../secret", "/tmp", "C:\\tmp", "\\\\server\\share", "https://host/path"] ) {
    assert.equal(consRenderFolderTemplate(value, {}).ok, false, value);
  }
  assert.equal(consRenderFolderTemplate("a/b/c/d/e/f", {}).errors[0].code, "FOLDER_SEGMENT_LIMIT");
});

test("empty/missing folder segments collapse, long paths warn, and reserved segments are prefixed", () => {
  assert.equal(
    consRenderFolderTemplate("LexPack//{court}/NUL", { court: null }).folder,
    "LexPack/_NUL"
  );
  const long = consRenderFolderTemplate("{query}/{court}/{case}", {
    query: "я".repeat(80), court: "с".repeat(80), case: "д".repeat(80),
  });
  assert.ok(long.warnings.some((warning) => warning.code === "LONG_RELATIVE_PATH"));
  assert.equal(consRenderFolderTemplate("a////b", {}).folder, "a/b");
});

test("internal collision resolution is stable by folder and extension", () => {
  const input = [
    { plannedRelativeFolder: "A", plannedFilename: "Решение.pdf" },
    { plannedRelativeFolder: "A", plannedFilename: "Решение.pdf" },
    { plannedRelativeFolder: "A", plannedFilename: "Решение.pdf" },
    { plannedRelativeFolder: "B", plannedFilename: "Решение.pdf" },
    { plannedRelativeFolder: "A", plannedFilename: "Решение.docx" },
  ];
  const first = consResolvePathCollisions(input);
  const second = consResolvePathCollisions(input);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((item) => item.plannedFilename), [
    "Решение.pdf", "Решение (2).pdf", "Решение (3).pdf", "Решение.pdf", "Решение.docx",
  ]);
  assert.equal(first[1].collisionResolution.internal, true);
});
