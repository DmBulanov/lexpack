const assert = require("node:assert/strict");
const test = require("node:test");

const { consNormalizeDocumentMetadata } = require("../extension/shared/metadata-parser.js");

test("one common case number is parsed and competing numbers are ambiguous", () => {
  assert.equal(
    consNormalizeDocumentMetadata({ title: "Решение по делу № А40-12345/2024" }).case.value,
    "А40-12345/2024"
  );
  const ambiguous = consNormalizeDocumentMetadata({
    title: "Дела А40-12345/2024 и А41-999/2024",
  }).case;
  assert.equal(ambiguous.value, null);
  assert.equal(ambiguous.confidence, "ambiguous");
});

test("one obvious date is normalized and competing dates are ambiguous", () => {
  assert.equal(
    consNormalizeDocumentMetadata({ title: "Решение от 14 марта 2025 года" }).date.value,
    "2025-03-14"
  );
  const ambiguous = consNormalizeDocumentMetadata({
    title: "от 14.03.2025, изменено 15.03.2025",
  }).date;
  assert.equal(ambiguous.value, null);
  assert.equal(ambiguous.confidence, "ambiguous");
});

test("document type and explicit court are conservative", () => {
  const parsed = consNormalizeDocumentMetadata({
    title: "Апелляционное определение Арбитражного суда города Москвы от 14.03.2025 по делу А40-1/2025",
  });
  assert.equal(parsed.documentType.value, "Апелляционное определение");
  assert.match(parsed.court.value, /Арбитражного суда города Москвы/u);
  assert.equal(consNormalizeDocumentMetadata({ title: "Материал по спору" }).documentType.confidence, "missing");
  assert.equal(consNormalizeDocumentMetadata({ title: "Материал по спору" }).court.value, null);
});

test("structured adapter metadata wins and Unicode is normalized", () => {
  const parsed = consNormalizeDocumentMetadata({
    title: "Решение по делу А40-1/2025",
    metadata: {
      case: { value: "А41-2/2025", source: "adapter", confidence: "exact" },
      court: "Арбитражныи\u0306 суд",
    },
  });
  assert.deepEqual(parsed.case, { value: "А41-2/2025", source: "adapter", confidence: "exact" });
  assert.equal(parsed.court.value, "Арбитражный суд");
  assert.equal(parsed.court.confidence, "exact");
});
