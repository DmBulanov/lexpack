const assert = require("node:assert/strict");
const test = require("node:test");
const { deflateRawSync } = require("node:zlib");

const {
  consCreateStoredZip,
  consInspectDocxArchive,
  consSanitizeDocxArchive,
} = require("../extension/shared/docx-sanitizer.js");

const decoder = new TextDecoder();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function deflatedZip(parts) {
  const entries = Object.entries(parts).map(([name, value]) => {
    const nameBytes = Buffer.from(name, "utf8");
    const bytes = Buffer.from(typeof value === "string" ? value : value);
    const compressed = deflateRawSync(bytes);
    return { nameBytes, bytes, compressed, crc: crc32(bytes) };
  });
  const localSize = entries.reduce(
    (sum, entry) => sum + 30 + entry.nameBytes.length + entry.compressed.length,
    0
  );
  const centralSize = entries.reduce(
    (sum, entry) => sum + 46 + entry.nameBytes.length,
    0
  );
  const output = Buffer.alloc(localSize + centralSize + 22);
  const offsets = [];
  let cursor = 0;
  for (const entry of entries) {
    offsets.push(cursor);
    output.writeUInt32LE(0x04034b50, cursor);
    output.writeUInt16LE(20, cursor + 4);
    output.writeUInt16LE(0x0800, cursor + 6);
    output.writeUInt16LE(8, cursor + 8);
    output.writeUInt32LE(entry.crc, cursor + 14);
    output.writeUInt32LE(entry.compressed.length, cursor + 18);
    output.writeUInt32LE(entry.bytes.length, cursor + 22);
    output.writeUInt16LE(entry.nameBytes.length, cursor + 26);
    entry.nameBytes.copy(output, cursor + 30);
    entry.compressed.copy(output, cursor + 30 + entry.nameBytes.length);
    cursor += 30 + entry.nameBytes.length + entry.compressed.length;
  }
  const centralOffset = cursor;
  entries.forEach((entry, index) => {
    output.writeUInt32LE(0x02014b50, cursor);
    output.writeUInt16LE(20, cursor + 4);
    output.writeUInt16LE(20, cursor + 6);
    output.writeUInt16LE(0x0800, cursor + 8);
    output.writeUInt16LE(8, cursor + 10);
    output.writeUInt32LE(entry.crc, cursor + 16);
    output.writeUInt32LE(entry.compressed.length, cursor + 20);
    output.writeUInt32LE(entry.bytes.length, cursor + 24);
    output.writeUInt16LE(entry.nameBytes.length, cursor + 28);
    output.writeUInt32LE(offsets[index], cursor + 42);
    entry.nameBytes.copy(output, cursor + 46);
    cursor += 46 + entry.nameBytes.length;
  });
  output.writeUInt32LE(0x06054b50, cursor);
  output.writeUInt16LE(entries.length, cursor + 8);
  output.writeUInt16LE(entries.length, cursor + 10);
  output.writeUInt32LE(cursor - centralOffset, cursor + 12);
  output.writeUInt32LE(centralOffset, cursor + 16);
  return output;
}

function text(parts, name) {
  assert.ok(parts[name], `missing DOCX part ${name}`);
  return decoder.decode(parts[name]);
}

function wordText(xml) {
  return [...String(xml).matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/giu)]
    .map((match) =>
      match[1]
        .replace(/&lt;/gu, "<")
        .replace(/&gt;/gu, ">")
        .replace(/&amp;/gu, "&")
    )
    .join("");
}

function minimalParts(documentXml, extra = {}) {
  return {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="xml" ContentType="application/xml"/>
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      </Types>`,
    "word/document.xml": documentXml,
    ...extra,
  };
}

function fixtureParts() {
  return {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
        <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
        <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
        <Override PartName="/docProps/thumbnail.jpeg" ContentType="image/jpeg"/>
      </Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rIdDoc" Type="officeDocument" Target="word/document.xml"/>
        <Relationship Id="rIdThumb" Type="metadata/thumbnail" Target="docProps/thumbnail.jpeg"/>
      </Relationships>`,
    "docProps/core.xml": `<?xml version="1.0" encoding="UTF-8"?>
      <cp:coreProperties xmlns:cp="urn:core" xmlns:dc="urn:dc">
        <dc:title>Решение суда</dc:title>
        <dc:creator>Consultant Plus</dc:creator>
        <dc:description>Документ предоставлен КонсультантПлюс</dc:description>
      </cp:coreProperties>`,
    "docProps/custom.xml": `<?xml version="1.0" encoding="UTF-8"?>
      <Properties xmlns="urn:custom" xmlns:vt="urn:vt">
        <property name="source"><vt:lpwstr>https://www.consultant.ru</vt:lpwstr></property>
      </Properties>`,
    "docProps/thumbnail.jpeg": Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?>
      <w:document xmlns:w="urn:w" xmlns:r="urn:r"><w:body>
        <w:p><w:r><w:t>НЕИЗМЕННЫЙ ТЕКСТ РЕШЕНИЯ: evilconsultant.ru</w:t></w:r></w:p>
        <w:p><w:r><w:t>Источник: Консультант</w:t></w:r><w:r><w:t>Плюс, основной текст сохранён.</w:t></w:r></w:p>
        <w:p><w:r><w:t>См. КонсультантПлюс: примечание в цитате.</w:t></w:r></w:p>
        <w:p><w:r><w:t>Консультант</w:t></w:r><w:r><w:t>Плюс: примечание. Этот блок КонсультантПлюс сохраняется.</w:t></w:r></w:p>
        <w:p><w:r><w:drawing><a:blip xmlns:a="urn:a" r:embed="rIdBodyImage"/></w:drawing></w:r></w:p>
        <w:sectPr><w:headerReference r:id="rIdHeader"/><w:footerReference r:id="rIdFooter"/></w:sectPr>
      </w:body></w:document>`,
    "word/footnotes.xml": `<?xml version="1.0" encoding="UTF-8"?>
      <w:footnotes xmlns:w="urn:w"><w:footnote w:id="1"><w:p><w:r><w:t>Consultant Plus указан в сноске</w:t></w:r></w:p></w:footnote></w:footnotes>`,
    "word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rIdHeader" Type="header" Target="header1.xml"/>
        <Relationship Id="rIdFooter" Type="footer" Target="footer1.xml"/>
        <Relationship Id="rIdBodyImage" Type="image" Target="media/body.png"/>
      </Relationships>`,
    "word/header1.xml": `<?xml version="1.0" encoding="UTF-8"?>
      <w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="urn:r">
        <w:p><w:r><w:drawing><a:blip xmlns:a="urn:a" r:embed="rIdLogo"/></w:drawing></w:r></w:p>
        <w:p><w:r><w:t>Документ предоставлен </w:t></w:r><w:r><w:t>Консультант</w:t></w:r><w:r><w:t>Плюс</w:t></w:r></w:p>
        <w:p><w:r><w:t>Дата сохранения: 22.07.2026</w:t></w:r></w:p>
        <w:p><w:r><w:t>Решение Арбитражного суда Московской области</w:t></w:r></w:p>
        <w:p><w:hyperlink r:id="rIdReference"><w:r><w:t>Справочная карточка</w:t></w:r></w:hyperlink></w:p>
      </w:hdr>`,
    "word/_rels/header1.xml.rels": `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rIdLogo" Type="image" Target="media/consultant-logo.png"/>
        <Relationship Id="rIdReference" Type="hyperlink" Target="https://www.consultant.ru" TargetMode="External"/>
      </Relationships>`,
    "word/footer1.xml": `<?xml version="1.0" encoding="UTF-8"?>
      <w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="urn:r">
        <w:p><w:r><w:t>КонсультантПлюс — надежная правовая поддержка</w:t></w:r></w:p>
        <w:p><w:r><w:drawing><a:blip xmlns:a="urn:a" r:embed="rIdFooterLogo"/></w:drawing></w:r></w:p>
        <w:p><w:r><w:t>www.consultant.ru</w:t></w:r></w:p>
        <w:p><w:r><w:t>Страница </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple><w:r><w:t> из </w:t></w:r><w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>5</w:t></w:r></w:fldSimple></w:p>
      </w:ftr>`,
    "word/_rels/footer1.xml.rels": `<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rIdFooterLogo" Type="image" Target="media/footer-logo.png"/>
      </Relationships>`,
    "word/media/consultant-logo.png": Uint8Array.from([1, 2, 3]),
    "word/media/footer-logo.png": Uint8Array.from([4, 5, 6]),
    "word/media/body.png": Uint8Array.from([7, 8, 9]),
  };
}

test("DOCX cleanup removes brand mentions and preserves ConsultantPlus notes", async () => {
  const sourceParts = fixtureParts();
  const sourceBytes = consCreateStoredZip(sourceParts);
  const result = await consSanitizeDocxArchive(sourceBytes);
  const cleaned = await consInspectDocxArchive(result.bytes);

  assert.equal(result.mime, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const documentXml = text(cleaned, "word/document.xml");
  const documentBody = wordText(documentXml);
  assert.match(documentBody, /НЕИЗМЕННЫЙ ТЕКСТ РЕШЕНИЯ: evilconsultant\.ru/);
  assert.match(documentBody, /Источник: , основной текст сохранён\./);
  assert.match(documentBody, /См\. : примечание в цитате\./);
  assert.match(
    documentBody,
    /КонсультантПлюс: примечание\. Этот блок КонсультантПлюс сохраняется\./
  );
  assert.doesNotMatch(wordText(text(cleaned, "word/footnotes.xml")), /Consultant\s*Plus/iu);

  const header = text(cleaned, "word/header1.xml");
  assert.match(header, /Решение Арбитражного суда Московской области/);
  assert.match(header, /Справочная карточка/);
  assert.doesNotMatch(header, /Консультант|Consultant|consultant\.ru|Дата сохранения/iu);
  assert.doesNotMatch(header, /w:(?:drawing|pict|object)/u);
  assert.match(header, /w:hyperlink/u);

  const footer = text(cleaned, "word/footer1.xml");
  assert.match(footer, /Страница/);
  assert.match(footer, /w:instr=" PAGE "/);
  assert.match(footer, /w:instr=" NUMPAGES "/);
  assert.doesNotMatch(footer, /Консультант|Consultant|consultant\.ru|Дата сохранения/iu);
  assert.doesNotMatch(footer, /w:(?:drawing|pict|object)/u);

  const core = text(cleaned, "docProps/core.xml");
  assert.match(core, /<dc:title>Решение суда<\/dc:title>/);
  assert.match(core, /<dc:creator><\/dc:creator>/);
  assert.match(core, /<dc:description><\/dc:description>/);
  assert.doesNotMatch(text(cleaned, "docProps/custom.xml"), /consultant/iu);

  assert.match(text(cleaned, "word/_rels/header1.xml.rels"), /rIdReference/);
  assert.doesNotMatch(text(cleaned, "word/_rels/header1.xml.rels"), /rIdLogo/);
  assert.doesNotMatch(text(cleaned, "word/_rels/footer1.xml.rels"), /rIdFooterLogo/);
  assert.equal(cleaned["word/media/consultant-logo.png"], undefined);
  assert.equal(cleaned["word/media/footer-logo.png"], undefined);
  assert.deepEqual(cleaned["word/media/body.png"], sourceParts["word/media/body.png"]);
  assert.equal(cleaned["docProps/thumbnail.jpeg"], undefined);
  assert.doesNotMatch(text(cleaned, "_rels/.rels"), /thumbnail/iu);
  assert.doesNotMatch(text(cleaned, "[Content_Types].xml"), /thumbnail/iu);

  assert.equal(result.stats.headersCleaned, 1);
  assert.equal(result.stats.footersCleaned, 1);
  assert.equal(result.stats.propertiesCleared, 2);
  assert.equal(result.stats.mediaRemoved, 2);
  assert.equal(result.stats.thumbnailsRemoved, 1);
  assert.equal(result.stats.bodyPartsCleaned, 2);
  assert.equal(result.stats.protectedNotes, 1);
  assert.equal(result.stats.remainingMentions, 0);
  assert.ok(
    result.stats.brandMentionsRemoved >= 7,
    JSON.stringify(result.stats)
  );
});

test("DOCX cleanup handles alternate Word text carriers without decoding entities twice", async () => {
  const sourceBytes = consCreateStoredZip(
    minimalParts(
      `<w:document xmlns:w="urn:w"><w:body>
        <w:p><w:r><w:t>Консультант&#x41F;люс</w:t></w:r><w:r><w:t>&amp;lt;важно&amp;gt;</w:t></w:r></w:p>
        <w:p><w:r><w:instrText xml:space="preserve"> HYPERLINK "https://consultant.ru/document" </w:instrText></w:r></w:p>
      </w:body></w:document>`,
      {
        "word/comments.xml": `<w:comments xmlns:w="urn:w"><w:comment w:id="1"><w:p><w:r><w:delText>Консультант</w:delText></w:r><w:r><w:delText>Плюс</w:delText></w:r></w:p></w:comment></w:comments>`,
        "word/charts/chart1.xml": `<c:chart xmlns:c="urn:c" xmlns:a="urn:a"><a:p><a:r><a:t>Consultant </a:t></a:r><a:r><a:t>Plus</a:t></a:r></a:p></c:chart>`,
      }
    )
  );

  const result = await consSanitizeDocxArchive(sourceBytes);
  const cleaned = await consInspectDocxArchive(result.bytes);
  const documentXml = text(cleaned, "word/document.xml");

  assert.match(documentXml, /<w:t>&amp;lt;важно&amp;gt;<\/w:t>/u);
  assert.doesNotMatch(documentXml, /Консультант(?:Плюс)?|consultant\.ru/iu);
  assert.doesNotMatch(text(cleaned, "word/comments.xml"), /Консультант|Плюс/iu);
  assert.doesNotMatch(text(cleaned, "word/charts/chart1.xml"), /Consultant|Plus/iu);
  assert.equal(result.stats.bodyPartsCleaned, 3);
  assert.equal(result.stats.remainingMentions, 0);
  assert.ok(result.stats.brandMentionsRemoved >= 4);
});

test("DOCX cleanup sanitizes Word text attributes but preserves attributes in notes", async () => {
  const protectedNote = `<w:p data-source="КонсультантПлюс"><w:r><w:t>КонсультантПлюс: примечание. Текст сохраняется.</w:t><w:drawing><wp:docPr descr="Консультант-Плюс" title="Consultant＋" name="КонсультантПлюс"/></w:drawing></w:r></w:p>`;
  const documentXml = `<w:document xmlns:w="urn:w" xmlns:wp="urn:wp" data-source="КонсультантПлюс"><w:body>
    <w:p data-source="Источник Консультант-Плюс">
      <w:fldSimple w:instr=" MERGEFIELD Консультант＋ "><w:r><w:t>Обычный Консультант-Плюс и consultant＋.</w:t></w:r></w:fldSimple>
      <w:r><w:drawing><wp:docPr descr="Лого Консультант-Плюс" title="Consultant＋" name="КонсультантПлюс"/></w:drawing></w:r>
    </w:p>
    ${protectedNote}
  </w:body></w:document>`;
  const result = await consSanitizeDocxArchive(
    consCreateStoredZip(minimalParts(documentXml))
  );
  const cleaned = await consInspectDocxArchive(result.bytes);
  const cleanedDocument = text(cleaned, "word/document.xml");
  const unprotectedXml = cleanedDocument.replace(protectedNote, "");

  assert.doesNotMatch(unprotectedXml, /Консультант|Consultant|consultant\.ru/iu);
  assert.match(cleanedDocument, /data-source="Источник "/u);
  assert.match(cleanedDocument, /w:instr=" MERGEFIELD  "/u);
  assert.match(
    cleanedDocument,
    /<wp:docPr descr="Лого " title="" name=""\/>/u
  );
  assert.ok(cleanedDocument.includes(protectedNote), "note attributes must stay unchanged");
  assert.equal(result.stats.protectedNotes, 1);
  assert.equal(result.stats.remainingMentions, 0);
  assert.ok(result.stats.brandMentionsRemoved >= 8);
});

test("DOCX cleanup removes Consultant domains before punctuation and on subdomains", async () => {
  const result = await consSanitizeDocxArchive(
    consCreateStoredZip(
      minimalParts(
        `<w:document xmlns:w="urn:w" data-source="consultant.ru."><w:body><w:p><w:r><w:t>Источники: consultant.ru. online.consultant.ru и https://online.consultant.ru/document; evilconsultant.ru оставить.</w:t></w:r></w:p></w:body></w:document>`
      )
    )
  );
  const cleaned = await consInspectDocxArchive(result.bytes);
  const documentXml = text(cleaned, "word/document.xml");
  const withoutAllowedHostname = documentXml.replaceAll("evilconsultant.ru", "");

  assert.match(documentXml, /evilconsultant\.ru оставить/u);
  assert.doesNotMatch(withoutAllowedHostname, /consultant\.ru/iu);
  assert.match(documentXml, /data-source="\."/u);
  assert.equal(result.stats.remainingMentions, 0);
  assert.equal(result.stats.brandMentionsRemoved, 4);
});

test("DOCX cleanup preserves CDATA structure while cleaning Word text and properties", async () => {
  const result = await consSanitizeDocxArchive(
    consCreateStoredZip(
      minimalParts(
        `<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t><![CDATA[До КонсультантПлюс & после]]></w:t></w:r></w:p></w:body></w:document>`,
        {
          "docProps/core.xml": `<p:core xmlns:p="urn:p"><p:title><![CDATA[Метаданные Consultant Plus & сохранены]]></p:title></p:core>`,
        }
      )
    )
  );
  const cleaned = await consInspectDocxArchive(result.bytes);
  const documentXml = text(cleaned, "word/document.xml");
  const coreXml = text(cleaned, "docProps/core.xml");

  assert.match(documentXml, /<w:t><!\[CDATA\[До  & после\]\]><\/w:t>/u);
  assert.match(coreXml, /<p:title><!\[CDATA\[Метаданные  & сохранены\]\]><\/p:title>/u);
  assert.doesNotMatch(`${documentXml}${coreXml}`, /Консультант|Consultant/iu);
  assert.equal(result.stats.propertiesCleared, 1);
  assert.equal(result.stats.remainingMentions, 0);
  assert.equal(result.stats.brandMentionsRemoved, 2);
});

test("DOCX cleanup treats explicit line breaks as barriers but still joins split runs", async () => {
  const breakParagraph = `<w:p><w:r><w:t>Консультант</w:t><w:br/><w:t>Плюс</w:t></w:r></w:p>`;
  const splitRunParagraph = `<w:p><w:r><w:t>Консультант</w:t></w:r><w:r><w:t>-Плюс</w:t></w:r></w:p>`;
  const falseNoteParagraph = `<w:p><w:r><w:t>Консультант</w:t><w:br/><w:t>Плюс: примечание. Удалить КонсультантПлюс.</w:t></w:r></w:p>`;
  const result = await consSanitizeDocxArchive(
    consCreateStoredZip(
      minimalParts(
        `<w:document xmlns:w="urn:w"><w:body>${breakParagraph}${splitRunParagraph}${falseNoteParagraph}</w:body></w:document>`
      )
    )
  );
  const cleaned = await consInspectDocxArchive(result.bytes);
  const cleanedDocument = text(cleaned, "word/document.xml");

  assert.ok(cleanedDocument.includes(breakParagraph), "text across w:br must stay intact");
  assert.doesNotMatch(cleanedDocument, /<w:t>-Плюс<\/w:t>/u);
  assert.match(
    cleanedDocument,
    /<w:t>Плюс: примечание\. Удалить \.<\/w:t>/u,
    "a note marker split by w:br must not protect the paragraph"
  );
  assert.equal(result.stats.protectedNotes, 0);
  assert.equal(result.stats.remainingMentions, 0);
  assert.equal(result.stats.brandMentionsRemoved, 2);
});

test("DOCX cleanup leaves a nested ConsultantPlus note paragraph byte-for-byte intact", async () => {
  const note = `<w:p w:rsidR="note"><w:r><w:t>Консультант</w:t></w:r><w:r><w:t>Плюс: примечание. КонсультантПлюс сохраняется.</w:t></w:r></w:p>`;
  const documentXml = `<w:document xmlns:w="urn:w"><w:body>
    <w:p><w:r><w:t>Якорь КонсультантПлюс</w:t><w:drawing><w:txbxContent>${note}</w:txbxContent></w:drawing></w:r></w:p>
  </w:body></w:document>`;
  const result = await consSanitizeDocxArchive(
    consCreateStoredZip(minimalParts(documentXml))
  );
  const cleaned = await consInspectDocxArchive(result.bytes);
  const cleanedDocument = text(cleaned, "word/document.xml");

  assert.match(cleanedDocument, /<w:t>Якорь <\/w:t>/u);
  assert.ok(cleanedDocument.includes(note), "the nested note XML must stay unchanged");
  assert.equal(result.stats.protectedNotes, 1);
  assert.equal(result.stats.remainingMentions, 0);
});

test("DOCX cleanup removes brand text from property attributes and nested values", async () => {
  const customProperties = `<Properties xmlns="urn:custom" xmlns:vt="urn:vt">
    <property name="Источник КонсультантПлюс" marker="&amp;lt;keep&amp;gt;">
      <vt:vector>
        <vt:lpwstr>Консультант</vt:lpwstr>
        <vt:lpwstr>Плюс</vt:lpwstr>
      </vt:vector>
    </property>
  </Properties>`;
  const result = await consSanitizeDocxArchive(
    consCreateStoredZip(
      minimalParts(
        `<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Текст</w:t></w:r></w:p></w:body></w:document>`,
        { "docProps/custom.xml": customProperties }
      )
    )
  );
  const cleaned = await consInspectDocxArchive(result.bytes);
  const properties = text(cleaned, "docProps/custom.xml");

  assert.doesNotMatch(properties, /Консультант|Плюс/iu);
  assert.match(properties, /name="Источник "/u);
  assert.match(properties, /marker="&amp;lt;keep&amp;gt;"/u);
  assert.equal(result.stats.propertiesCleared, 1);
  assert.equal(result.stats.remainingMentions, 0);
  assert.ok(result.stats.brandMentionsRemoved >= 2);
});

test("DOCX cleanup keeps media referenced through prefixed relationships and decodes IDs", async () => {
  const officeRelationshipNamespace =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const packageRelationshipNamespace =
    "http://schemas.openxmlformats.org/package/2006/relationships";
  const sharedMedia = Uint8Array.from([7, 8, 9]);
  const result = await consSanitizeDocxArchive(
    consCreateStoredZip(
      minimalParts(
        `<w:document xmlns:w="urn:w" xmlns:r="${officeRelationshipNamespace}"><w:body><w:p><w:r><w:drawing><a:blip xmlns:a="urn:a" r:embed="body"/></w:drawing></w:r></w:p></w:body></w:document>`,
        {
          "word/_rels/document.xml.rels": `<pr:Relationships xmlns:pr="${packageRelationshipNamespace}"><pr:Relationship Id="body" Type="image" Target="media/shared.png"/></pr:Relationships>`,
          "word/header1.xml": `<w:hdr xmlns:w="urn:w" xmlns:r="${officeRelationshipNamespace}"><w:p><w:hyperlink r:id="keep"><w:r><w:t>Ссылка</w:t></w:r></w:hyperlink></w:p><w:p><w:drawing r:embed="drop"/></w:p></w:hdr>`,
          "word/_rels/header1.xml.rels": `<pr:Relationships xmlns:pr="${packageRelationshipNamespace}"><pr:Relationship Id="k&#x65;ep" Type="hyperlink" Target="https://example.test" TargetMode="External"/><pr:Relationship Id="drop" Type="image" Target="media/shared.png"/></pr:Relationships>`,
          "word/media/shared.png": sharedMedia,
        }
      )
    )
  );
  const cleaned = await consInspectDocxArchive(result.bytes);
  const headerRelationships = text(cleaned, "word/_rels/header1.xml.rels");

  assert.match(headerRelationships, /Id="k&#x65;ep"/u);
  assert.doesNotMatch(headerRelationships, /Id="drop"/u);
  assert.deepEqual(cleaned["word/media/shared.png"], sharedMedia);
  assert.equal(result.stats.mediaRemoved, 0);
});

test("DOCX cleanup expands a self-closing footer before adding page fields", async () => {
  const result = await consSanitizeDocxArchive(
    consCreateStoredZip(
      minimalParts(
        `<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Текст</w:t></w:r></w:p></w:body></w:document>`,
        { "word/footer1.xml": `<w:ftr xmlns:w="urn:w"/>` }
      )
    )
  );
  const cleaned = await consInspectDocxArchive(result.bytes);
  const footer = text(cleaned, "word/footer1.xml");

  assert.match(footer, /^<w:ftr xmlns:w="urn:w"><w:p>/u);
  assert.equal((footer.match(/w:instr=" PAGE "/gu) || []).length, 1);
  assert.equal((footer.match(/w:instr=" NUMPAGES "/gu) || []).length, 1);
  assert.match(footer, /<\/w:ftr>$/u);
  assert.equal(result.stats.footersCleaned, 1);
});

test("DOCX cleanup preserves alternate-prefix relationships and removes self-closing objects", async () => {
  const relationshipNamespace =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const result = await consSanitizeDocxArchive(
    consCreateStoredZip(
      minimalParts(
        `<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Текст</w:t></w:r></w:p></w:body></w:document>`,
        {
          "word/header1.xml": `<w:hdr xmlns:w="urn:w" xmlns:rel="${relationshipNamespace}">
            <w:p><w:hyperlink rel:id="keep"><w:r><w:t>Ссылка</w:t></w:r></w:hyperlink></w:p>
            <w:p><w:drawing rel:embed="drop"/></w:p>
          </w:hdr>`,
          "word/_rels/header1.xml.rels": `<Relationships>
            <Relationship Id="keep" Type="hyperlink" Target="https://example.test" TargetMode="External"/>
            <Relationship Id="drop" Type="image" Target="media/drop.png"/>
          </Relationships>`,
          "word/footer1.xml": `<w:ftr xmlns:w="urn:w"><w:p><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`,
          "word/media/drop.png": Uint8Array.from([1, 2, 3]),
        }
      )
    )
  );
  const cleaned = await consInspectDocxArchive(result.bytes);
  const header = text(cleaned, "word/header1.xml");
  const relationships = text(cleaned, "word/_rels/header1.xml.rels");
  const footer = text(cleaned, "word/footer1.xml");

  assert.doesNotMatch(header, /<w:drawing\b/iu);
  assert.match(header, /rel:id="keep"/u);
  assert.match(relationships, /Id="keep"/u);
  assert.doesNotMatch(relationships, /Id="drop"/u);
  assert.equal(cleaned["word/media/drop.png"], undefined);
  assert.equal((footer.match(/w:instr=" PAGE "/gu) || []).length, 2);
  assert.equal((footer.match(/w:instr=" NUMPAGES "/gu) || []).length, 1);
});

test("DOCX cleanup rejects an arbitrary ZIP that is not a Word document", async () => {
  const archive = consCreateStoredZip({ "notes.txt": "not a document" });
  await assert.rejects(consSanitizeDocxArchive(archive), /корректным DOCX/);
});

test("DOCX cleanup handles the deflated ZIP parts used by real Word files", async () => {
  const sourceParts = fixtureParts();
  const result = await consSanitizeDocxArchive(deflatedZip(sourceParts));
  const cleaned = await consInspectDocxArchive(result.bytes);
  assert.match(text(cleaned, "word/document.xml"), /НЕИЗМЕННЫЙ ТЕКСТ РЕШЕНИЯ/);
  assert.doesNotMatch(text(cleaned, "word/header1.xml"), /Консультант|Consultant/iu);
  assert.match(text(cleaned, "word/footer1.xml"), /NUMPAGES/);
});

test("DOCX cleanup aborts deflation when actual output exceeds the declared size", async () => {
  const archive = Buffer.from(deflatedZip(fixtureParts()));
  archive.writeUInt32LE(1, 22);
  const centralOffset = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(centralOffset > 0);
  archive.writeUInt32LE(1, centralOffset + 24);
  await assert.rejects(
    consSanitizeDocxArchive(archive),
    /Распакованный размер DOCX не совпал/
  );
});
