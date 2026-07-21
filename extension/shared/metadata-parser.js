/** Conservative Russian legal-document metadata normalization. */
(function () {
  const MONTHS = Object.freeze({
    января: 1,
    февраля: 2,
    марта: 3,
    апреля: 4,
    мая: 5,
    июня: 6,
    июля: 7,
    августа: 8,
    сентября: 9,
    октября: 10,
    ноября: 11,
    декабря: 12,
  });
  const DOCUMENT_TYPES = Object.freeze([
    ["Апелляционное определение", /(?:^|[^\p{L}])апелляционное\s+определение(?:$|[^\p{L}])/iu],
    ["Решение", /(?:^|[^\p{L}])решение(?:$|[^\p{L}])/iu],
    ["Постановление", /(?:^|[^\p{L}])постановление(?:$|[^\p{L}])/iu],
    ["Определение", /(?:^|[^\p{L}])определение(?:$|[^\p{L}])/iu],
    ["Приговор", /(?:^|[^\p{L}])приговор(?:$|[^\p{L}])/iu],
  ]);

  function normalizedText(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/gu, " ")
      .trim();
  }

  function missingMetadata() {
    return { value: null, source: null, confidence: "missing" };
  }

  function ambiguousMetadata(source = "title-parser") {
    return { value: null, source, confidence: "ambiguous" };
  }

  function parsedMetadata(value, confidence = "high") {
    return { value, source: "title-parser", confidence };
  }

  function structuredMetadata(value) {
    if (value === null || value === undefined) return null;
    const raw = value && typeof value === "object" && "value" in value
      ? value.value
      : value;
    const cleaned = normalizedText(raw);
    if (!cleaned) return null;
    const source = value && typeof value === "object" && value.source
      ? cleanSource(value.source)
      : "adapter";
    const requestedConfidence = value && typeof value === "object"
      ? value.confidence
      : "exact";
    const confidence = ["exact", "high", "medium"].includes(requestedConfidence)
      ? requestedConfidence
      : "exact";
    return { value: cleaned.slice(0, 240), source, confidence };
  }

  function cleanSource(value) {
    return normalizedText(value).slice(0, 80) || "adapter";
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function validIsoDate(year, month, day) {
    const y = Number(year);
    const m = Number(month);
    const d = Number(day);
    if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return "";
    const date = new Date(Date.UTC(y, m - 1, d));
    if (
      date.getUTCFullYear() !== y ||
      date.getUTCMonth() !== m - 1 ||
      date.getUTCDate() !== d
    ) {
      return "";
    }
    return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  function parseCases(title) {
    const values = [];
    const pattern = /(?:^|[^\p{L}\p{N}])((?:[А-ЯЁA-Z]{1,4}\d{1,3}|\d{1,3})-\d{1,12}\/\d{2,4}(?:-[А-ЯЁA-Z0-9]+)?)(?=$|[^\p{L}\p{N}])/giu;
    for (const match of title.matchAll(pattern)) {
      values.push(match[1].toLocaleUpperCase("ru-RU"));
    }
    const found = unique(values);
    if (found.length > 1) return ambiguousMetadata();
    return found.length === 1 ? parsedMetadata(found[0]) : missingMetadata();
  }

  function parseDates(title) {
    const values = [];
    for (const match of title.matchAll(/(?:^|[^\d])(19\d{2}|20\d{2}|2100)-([01]?\d)-([0-3]?\d)(?=$|[^\d])/gu)) {
      values.push(validIsoDate(match[1], match[2], match[3]));
    }
    for (const match of title.matchAll(/(?:^|[^\d])([0-3]?\d)[./]([01]?\d)[./](19\d{2}|20\d{2}|2100)(?=$|[^\d])/gu)) {
      values.push(validIsoDate(match[3], match[2], match[1]));
    }
    const monthPattern = new RegExp(
      `(?:^|[^\\p{L}\\d])([0-3]?\\d)\\s+(${Object.keys(MONTHS).join("|")})\\s+(19\\d{2}|20\\d{2}|2100)(?:\\s*г(?:ода|\\.)?)?(?=$|[^\\p{L}\\d])`,
      "giu"
    );
    for (const match of title.matchAll(monthPattern)) {
      values.push(validIsoDate(match[3], MONTHS[match[2].toLocaleLowerCase("ru-RU")], match[1]));
    }
    const found = unique(values);
    if (found.length > 1) return ambiguousMetadata();
    return found.length === 1 ? parsedMetadata(found[0]) : missingMetadata();
  }

  function parseDocumentType(title) {
    for (const [value, pattern] of DOCUMENT_TYPES) {
      if (pattern.test(title)) return parsedMetadata(value);
    }
    return missingMetadata();
  }

  function parseCourts(title) {
    const values = [];
    const pattern = /((?:Арбитражн(?:ый|ого)\s+суд(?:а)?|Верховн(?:ый|ого)\s+Суд(?:а)?|Конституционн(?:ый|ого)\s+Суд(?:а)?|[\p{L}-]+\s+(?:районн(?:ый|ого)|городск(?:ой|ого))\s+суд(?:а)?|(?:\p{L}+\s+){0,3}арбитражн(?:ый|ого)\s+апелляционн(?:ый|ого)\s+суд(?:а)?)[^,;\n]{0,120}?)(?=\s+(?:от|по\s+делу|№)|[,;\n]|$)/giu;
    for (const match of title.matchAll(pattern)) {
      const value = normalizedText(match[1]).replace(/[. ]+$/gu, "").slice(0, 200);
      if (value) values.push(value);
    }
    const found = unique(values);
    if (found.length > 1) return ambiguousMetadata();
    return found.length === 1 ? parsedMetadata(found[0]) : missingMetadata();
  }

  function fieldValue(structured, field, parser, title) {
    const exact = structuredMetadata(structured?.[field]);
    return exact || parser(title);
  }

  function consNormalizeDocumentMetadata(item = {}) {
    const title = normalizedText(item.exactTitle || item.title || item.originalTitle);
    const structured = item.metadata && typeof item.metadata === "object"
      ? item.metadata
      : {};
    return {
      date: fieldValue(structured, "date", parseDates, title),
      case: fieldValue(structured, "case", parseCases, title),
      court: fieldValue(structured, "court", parseCourts, title),
      documentType: fieldValue(structured, "documentType", parseDocumentType, title),
    };
  }

  const api = {
    consNormalizeDocumentMetadata,
  };
  Object.assign(globalThis, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
