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
        <w:p><w:r><w:t>НЕИЗМЕННЫЙ ТЕКСТ РЕШЕНИЯ</w:t></w:r></w:p>
        <w:p><w:r><w:drawing><a:blip xmlns:a="urn:a" r:embed="rIdBodyImage"/></w:drawing></w:r></w:p>
        <w:sectPr><w:headerReference r:id="rIdHeader"/><w:footerReference r:id="rIdFooter"/></w:sectPr>
      </w:body></w:document>`,
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

test("DOCX cleanup removes ConsultantPlus package data and preserves the legal body", async () => {
  const sourceParts = fixtureParts();
  const sourceBytes = consCreateStoredZip(sourceParts);
  const result = await consSanitizeDocxArchive(sourceBytes);
  const cleaned = await consInspectDocxArchive(result.bytes);

  assert.equal(result.mime, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.deepEqual(cleaned["word/document.xml"], new TextEncoder().encode(sourceParts["word/document.xml"]));

  const header = text(cleaned, "word/header1.xml");
  assert.match(header, /Решение Арбитражного суда Московской области/);
  assert.match(header, /Справочная карточка/);
  assert.doesNotMatch(header, /Консультант|Consultant|consultant\.ru|Дата сохранения/iu);
  assert.doesNotMatch(header, /w:(?:drawing|pict|object|hyperlink)/u);

  const footer = text(cleaned, "word/footer1.xml");
  assert.match(footer, /Страница/);
  assert.match(footer, /w:instr=" PAGE "/);
  assert.match(footer, /w:instr=" NUMPAGES "/);
  assert.doesNotMatch(footer, /Консультант|Consultant|consultant\.ru|Дата сохранения/iu);
  assert.doesNotMatch(footer, /w:(?:drawing|pict|object|hyperlink)/u);

  const core = text(cleaned, "docProps/core.xml");
  assert.match(core, /<dc:title>Решение суда<\/dc:title>/);
  assert.match(core, /<dc:creator><\/dc:creator>/);
  assert.match(core, /<dc:description><\/dc:description>/);
  assert.doesNotMatch(text(cleaned, "docProps/custom.xml"), /consultant/iu);

  assert.equal(cleaned["word/_rels/header1.xml.rels"], undefined);
  assert.equal(cleaned["word/_rels/footer1.xml.rels"], undefined);
  assert.equal(cleaned["word/media/consultant-logo.png"], undefined);
  assert.equal(cleaned["word/media/footer-logo.png"], undefined);
  assert.deepEqual(cleaned["word/media/body.png"], sourceParts["word/media/body.png"]);
  assert.equal(cleaned["docProps/thumbnail.jpeg"], undefined);
  assert.doesNotMatch(text(cleaned, "_rels/.rels"), /thumbnail/iu);
  assert.doesNotMatch(text(cleaned, "[Content_Types].xml"), /thumbnail/iu);

  assert.deepEqual(result.stats, {
    headersCleaned: 1,
    footersCleaned: 1,
    propertiesCleared: 2,
    mediaRemoved: 2,
    thumbnailsRemoved: 1,
  });
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
