/** Local assembly of ordered, cleaned document texts. No source text is persisted. */
(function () {
  const cleaner = typeof module !== "undefined" && module.exports
    ? require("./content-cleaner.js") : globalThis;
  const zip = typeof module !== "undefined" && module.exports
    ? require("./docx-sanitizer.js") : globalThis;
  const MAX_MERGED_BYTES = 32 * 1024 * 1024;
  const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const SIZE_ERROR = "Единый документ превышает безопасный лимит 32 МБ";
  const TAB_XML = '</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t xml:space="preserve">';
  const encoder = new TextEncoder();

  function consMergedDocumentPart(doc = {}) {
    const title = cleaner.consRemoveConsultantMentions(doc.title || "Документ").text
      .replace(/[\r\n]/gu, " ").trim() || "Документ";
    const body = String(doc.markdown ?? doc.text ?? "");
    if (encoder.encode(title + body).byteLength > MAX_MERGED_BYTES) {
      throw new Error(SIZE_ERROR);
    }
    if (!body.trim()) throw new Error("Документ не содержит текста для объединения");
    cleaner.consAssertConsultantTextClean(body);
    return { title, body };
  }

  function xmlText(value) {
    const text = String(value);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u.test(text)) {
      throw new Error("Текст содержит символы, недопустимые в DOCX");
    }
    return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
  }

  function paragraph(text, properties, remainingBytes) {
    const value = String(text);
    const prefix = `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ""}<w:r><w:t xml:space="preserve">`;
    const suffix = "</w:t></w:r></w:p>";
    let bytes = encoder.encode(prefix + suffix + value).byteLength;
    // Check the expanded XML size before allocating markup for many tabs or
    // ampersands. A small plain-text input can otherwise expand dramatically.
    for (const match of value.matchAll(/[&<>\t]/gu)) {
      bytes += match[0] === "\t" ? TAB_XML.length - 1 : match[0] === "&" ? 4 : 3;
    }
    if (bytes > remainingBytes) throw new Error(SIZE_ERROR);
    return prefix + xmlText(value).replace(/\t/gu, TAB_XML) + suffix;
  }

  function consBuildMergedDocument(parts, format) {
    if (!Array.isArray(parts) || !parts.length || parts.length > 200) {
      throw new Error("Для объединения требуется от 1 до 200 документов");
    }
    const clean = parts.map((part) => consMergedDocumentPart({ title: part.title, text: part.body }));
    const sections = clean.map((part, index) =>
      `# ${index + 1}. ${part.title}\n\n${part.body}`
    );
    const size = sections.reduce((bytes, section) => bytes + encoder.encode(section).byteLength, 0) +
      (sections.length - 1) * 7;
    if (size > MAX_MERGED_BYTES) {
      throw new Error(SIZE_ERROR);
    }
    if (format === "md-one") return { data: sections.join("\n\n---\n\n"), mime: "text/markdown; charset=utf-8" };
    if (format !== "docx-one") throw new Error("Неподдерживаемый формат единого документа");

    const paragraphs = [];
    let xmlBytes = 0;
    const appendParagraph = (text, properties = "") => {
      const xml = paragraph(text, properties, MAX_MERGED_BYTES - xmlBytes);
      xmlBytes += encoder.encode(xml).byteLength;
      paragraphs.push(xml);
    };
    clean.forEach((part, index) => {
      appendParagraph(`${index + 1}. ${part.title}`, '<w:pStyle w:val="Heading1"/>' + (index ? "<w:pageBreakBefore/>" : ""));
      let start = 0;
      for (const match of part.body.matchAll(/\r\n|\r|\n/gu)) {
        appendParagraph(part.body.slice(start, match.index));
        start = match.index + match[0].length;
      }
      appendParagraph(part.body.slice(start));
    });
    const body = paragraphs.join("");
    const data = zip.consCreateStoredZip({
      "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
      "_rels/.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`,
      "word/_rels/document.xml.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
      "word/styles.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/><w:lang w:val="ru-RU"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style></w:styles>',
    });
    if (data.byteLength > MAX_MERGED_BYTES) throw new Error(SIZE_ERROR);
    return { data, mime: DOCX_MIME };
  }

  const api = { MAX_MERGED_BYTES, consMergedDocumentPart, consBuildMergedDocument };
  Object.assign(globalThis, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
