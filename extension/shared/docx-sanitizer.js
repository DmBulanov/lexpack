/**
 * Local DOCX sanitizer for ConsultantPlus exports.
 *
 * The module keeps the document body intact. It clears branded header parts,
 * replaces branded footer layouts with a page counter, removes brand-bearing
 * package properties, and drops media that was referenced only by the removed
 * header/footer relationships.
 */
(function () {
  "use strict";

  const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
  const MAX_ENTRY_COUNT = 4096;
  const MAX_TOTAL_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
  const MAX_XML_BYTES = 16 * 1024 * 1024;
  const ZIP_LOCAL_SIGNATURE = 0x04034b50;
  const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
  const ZIP_EOCD_SIGNATURE = 0x06054b50;
  const UTF8_FLAG = 0x0800;
  const DOCX_MIME =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const WORD_NS =
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });

  function toBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    throw new Error("DOCX должен быть передан как ArrayBuffer или Uint8Array");
  }

  function viewOf(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  function assertRange(bytes, offset, length, label) {
    if (
      !Number.isInteger(offset) ||
      !Number.isInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > bytes.byteLength
    ) {
      throw new Error(`Повреждённый DOCX: ${label}`);
    }
  }

  function safeEntryName(name) {
    const normalized = String(name || "").replace(/\\/g, "/");
    if (
      !normalized ||
      normalized.startsWith("/") ||
      normalized.includes("\0") ||
      normalized.split("/").some((segment) => segment === "..")
    ) {
      throw new Error("DOCX содержит небезопасный путь внутри архива");
    }
    return normalized;
  }

  function findEndOfCentralDirectory(bytes) {
    const view = viewOf(bytes);
    const minimum = Math.max(0, bytes.byteLength - 65557);
    for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
      if (view.getUint32(offset, true) === ZIP_EOCD_SIGNATURE) return offset;
    }
    throw new Error("DOCX не содержит завершённый ZIP-каталог");
  }

  function parseZip(bytesLike) {
    const bytes = toBytes(bytesLike);
    if (bytes.byteLength < 22 || bytes.byteLength > MAX_ARCHIVE_BYTES) {
      throw new Error("Размер DOCX выходит за безопасный предел 64 МБ");
    }
    const view = viewOf(bytes);
    const eocdOffset = findEndOfCentralDirectory(bytes);
    assertRange(bytes, eocdOffset, 22, "конец ZIP-каталога");
    const diskNumber = view.getUint16(eocdOffset + 4, true);
    const directoryDisk = view.getUint16(eocdOffset + 6, true);
    const entryCount = view.getUint16(eocdOffset + 10, true);
    const centralSize = view.getUint32(eocdOffset + 12, true);
    const centralOffset = view.getUint32(eocdOffset + 16, true);
    if (diskNumber !== 0 || directoryDisk !== 0) {
      throw new Error("Многотомные DOCX-архивы не поддерживаются");
    }
    if (entryCount > MAX_ENTRY_COUNT) {
      throw new Error("DOCX содержит слишком много частей");
    }
    assertRange(bytes, centralOffset, centralSize, "центральный ZIP-каталог");

    const entries = [];
    const names = new Set();
    let cursor = centralOffset;
    let totalUncompressed = 0;
    for (let index = 0; index < entryCount; index += 1) {
      assertRange(bytes, cursor, 46, "запись центрального каталога");
      if (view.getUint32(cursor, true) !== ZIP_CENTRAL_SIGNATURE) {
        throw new Error("Повреждённая запись центрального ZIP-каталога");
      }
      const flags = view.getUint16(cursor + 8, true);
      const method = view.getUint16(cursor + 10, true);
      const modTime = view.getUint16(cursor + 12, true);
      const modDate = view.getUint16(cursor + 14, true);
      const crc = view.getUint32(cursor + 16, true);
      const compressedSize = view.getUint32(cursor + 20, true);
      const uncompressedSize = view.getUint32(cursor + 24, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const commentLength = view.getUint16(cursor + 32, true);
      const externalAttributes = view.getUint32(cursor + 38, true);
      const localOffset = view.getUint32(cursor + 42, true);
      const centralLength = 46 + nameLength + extraLength + commentLength;
      assertRange(bytes, cursor, centralLength, "имя ZIP-части");
      if (flags & 0x0001) throw new Error("Зашифрованные DOCX не поддерживаются");
      if (![0, 8].includes(method)) {
        throw new Error(`DOCX использует неподдерживаемое ZIP-сжатие: ${method}`);
      }
      const name = safeEntryName(
        decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
      );
      if (names.has(name)) throw new Error(`DOCX содержит повторяющуюся часть: ${name}`);
      names.add(name);
      totalUncompressed += uncompressedSize;
      if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
        throw new Error("Распакованный DOCX превышает безопасный предел 256 МБ");
      }

      assertRange(bytes, localOffset, 30, `локальный заголовок ${name}`);
      if (view.getUint32(localOffset, true) !== ZIP_LOCAL_SIGNATURE) {
        throw new Error(`Повреждён локальный ZIP-заголовок: ${name}`);
      }
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      assertRange(bytes, dataOffset, compressedSize, `данные ${name}`);
      entries.push({
        name,
        method,
        modTime,
        modDate,
        crc,
        compressedSize,
        uncompressedSize,
        externalAttributes,
        compressedData: bytes.subarray(dataOffset, dataOffset + compressedSize),
      });
      cursor += centralLength;
    }
    if (cursor > centralOffset + centralSize) {
      throw new Error("Центральный ZIP-каталог выходит за объявленные границы");
    }
    return entries;
  }

  let crcTable = null;
  function crc32(bytesLike) {
    const bytes = toBytes(bytesLike);
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let index = 0; index < 256; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) {
          value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        }
        crcTable[index] = value >>> 0;
      }
    }
    let value = 0xffffffff;
    for (const byte of bytes) {
      value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
    }
    return (value ^ 0xffffffff) >>> 0;
  }

  async function inflateEntry(entry) {
    if (entry.uncompressedSize > MAX_XML_BYTES && /\.(?:xml|rels)$/i.test(entry.name)) {
      throw new Error(`XML-часть DOCX слишком велика: ${entry.name}`);
    }
    let bytes;
    if (entry.method === 0) {
      bytes = entry.compressedData.slice();
    } else {
      if (typeof DecompressionStream !== "function") {
        throw new Error("Браузер не поддерживает локальную распаковку DOCX");
      }
      const stream = new Blob([entry.compressedData])
        .stream()
        .pipeThrough(new DecompressionStream("deflate-raw"));
      const reader = stream.getReader();
      const chunks = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = toBytes(value);
          total += chunk.byteLength;
          if (total > entry.uncompressedSize) {
            throw new Error(`Распакованный размер DOCX не совпал: ${entry.name}`);
          }
          chunks.push(chunk.slice());
        }
      } catch (error) {
        await reader.cancel(error).catch(() => {});
        throw error;
      }
      bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
    if (bytes.byteLength !== entry.uncompressedSize || crc32(bytes) !== entry.crc) {
      throw new Error(`Контрольная сумма DOCX не совпала: ${entry.name}`);
    }
    return bytes;
  }

  async function entryText(entry) {
    const bytes = await inflateEntry(entry);
    if (bytes.byteLength > MAX_XML_BYTES) {
      throw new Error(`XML-часть DOCX слишком велика: ${entry.name}`);
    }
    return decoder.decode(bytes);
  }

  function storedEntry(name, bytesLike, source = {}) {
    const bytes = toBytes(bytesLike).slice();
    return {
      name: safeEntryName(name),
      method: 0,
      modTime: source.modTime || 0,
      modDate: source.modDate || 0,
      crc: crc32(bytes),
      compressedSize: bytes.byteLength,
      uncompressedSize: bytes.byteLength,
      externalAttributes: source.externalAttributes || 0,
      compressedData: bytes,
    };
  }

  function buildZip(entries) {
    const prepared = entries.map((entry) => ({
      ...entry,
      nameBytes: encoder.encode(safeEntryName(entry.name)),
    }));
    let localSize = 0;
    let centralSize = 0;
    for (const entry of prepared) {
      localSize += 30 + entry.nameBytes.byteLength + entry.compressedData.byteLength;
      centralSize += 46 + entry.nameBytes.byteLength;
    }
    if (localSize + centralSize + 22 > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error("Очищенный DOCX превышает безопасный размер");
    }
    const output = new Uint8Array(localSize + centralSize + 22);
    const view = viewOf(output);
    const localOffsets = [];
    let cursor = 0;
    for (const entry of prepared) {
      localOffsets.push(cursor);
      view.setUint32(cursor, ZIP_LOCAL_SIGNATURE, true);
      view.setUint16(cursor + 4, 20, true);
      view.setUint16(cursor + 6, UTF8_FLAG, true);
      view.setUint16(cursor + 8, entry.method, true);
      view.setUint16(cursor + 10, entry.modTime, true);
      view.setUint16(cursor + 12, entry.modDate, true);
      view.setUint32(cursor + 14, entry.crc, true);
      view.setUint32(cursor + 18, entry.compressedSize, true);
      view.setUint32(cursor + 22, entry.uncompressedSize, true);
      view.setUint16(cursor + 26, entry.nameBytes.byteLength, true);
      view.setUint16(cursor + 28, 0, true);
      output.set(entry.nameBytes, cursor + 30);
      output.set(entry.compressedData, cursor + 30 + entry.nameBytes.byteLength);
      cursor += 30 + entry.nameBytes.byteLength + entry.compressedData.byteLength;
    }

    const centralOffset = cursor;
    prepared.forEach((entry, index) => {
      view.setUint32(cursor, ZIP_CENTRAL_SIGNATURE, true);
      view.setUint16(cursor + 4, 20, true);
      view.setUint16(cursor + 6, 20, true);
      view.setUint16(cursor + 8, UTF8_FLAG, true);
      view.setUint16(cursor + 10, entry.method, true);
      view.setUint16(cursor + 12, entry.modTime, true);
      view.setUint16(cursor + 14, entry.modDate, true);
      view.setUint32(cursor + 16, entry.crc, true);
      view.setUint32(cursor + 20, entry.compressedSize, true);
      view.setUint32(cursor + 24, entry.uncompressedSize, true);
      view.setUint16(cursor + 28, entry.nameBytes.byteLength, true);
      view.setUint16(cursor + 30, 0, true);
      view.setUint16(cursor + 32, 0, true);
      view.setUint16(cursor + 34, 0, true);
      view.setUint16(cursor + 36, 0, true);
      view.setUint32(cursor + 38, entry.externalAttributes >>> 0, true);
      view.setUint32(cursor + 42, localOffsets[index], true);
      output.set(entry.nameBytes, cursor + 46);
      cursor += 46 + entry.nameBytes.byteLength;
    });

    view.setUint32(cursor, ZIP_EOCD_SIGNATURE, true);
    view.setUint16(cursor + 4, 0, true);
    view.setUint16(cursor + 6, 0, true);
    view.setUint16(cursor + 8, prepared.length, true);
    view.setUint16(cursor + 10, prepared.length, true);
    view.setUint32(cursor + 12, cursor - centralOffset, true);
    view.setUint32(cursor + 16, centralOffset, true);
    view.setUint16(cursor + 20, 0, true);
    return output;
  }

  function containsBrand(value) {
    return /(?:Консультант\s*(?:\+|Плюс)|Consultant\s*Plus|consultant\.ru|Документ\s+предоставлен|Дата\s+сохранения|надежная\s+правовая\s+поддержка)/iu.test(
      String(value || "")
    );
  }

  function xmlText(xml) {
    const values = [];
    const pattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/giu;
    let match;
    while ((match = pattern.exec(String(xml || "")))) {
      values.push(
        decodeXmlAttribute(match[1]).replace(/&#(?:x([0-9a-f]+)|(\d+));/giu, (_full, hex, dec) => {
          const point = Number.parseInt(hex || dec, hex ? 16 : 10);
          return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
            ? String.fromCodePoint(point)
            : "";
        })
      );
    }
    return values.join("");
  }

  function removeHeaderObjects(value) {
    return String(value || "")
      .replace(
        /<w:(drawing|pict|object)\b(?:[^>]*\/\s*>|[\s\S]*?<\/w:\1>)/giu,
        ""
      )
      .replace(/<w:hyperlink\b[^>]*>([\s\S]*?)<\/w:hyperlink>/giu, (full, body) =>
        containsBrand(xmlText(full)) ? "" : body
      );
  }

  function cleanHeaderXml(xml) {
    const source = String(xml || "");
    const root = source.match(/<w:hdr\b([^>]*)>/iu);
    const rootAttributes = root?.[1] || ` xmlns:w="${WORD_NS}"`;
    const bodyMatch = source.match(/<w:hdr\b[^>]*>([\s\S]*?)<\/w:hdr>/iu);
    let body = bodyMatch?.[1] || "";
    body = body.replace(/<w:p\b[\s\S]*?<\/w:p>/giu, (paragraph) =>
      containsBrand(xmlText(paragraph)) ? "<w:p/>" : removeHeaderObjects(paragraph)
    );
    body = removeHeaderObjects(body);
    if (!/<w:p\b/iu.test(body)) body += "<w:p/>";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr${rootAttributes}>${body}</w:hdr>`;
  }

  function fallbackPageParagraph() {
    return `<w:p><w:pPr><w:jc w:val="right"/></w:pPr>` +
      `<w:r><w:t xml:space="preserve">Страница </w:t></w:r>` +
      `<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>` +
      `<w:r><w:t xml:space="preserve"> из </w:t></w:r>` +
      `<w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>1</w:t></w:r></w:fldSimple>` +
      `</w:p>`;
  }

  function cleanFooterXml(xml) {
    const root = String(xml || "").match(/<w:ftr\b([^>]*)>/iu);
    const rootAttributes = root?.[1] || ` xmlns:w="${WORD_NS}"`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr${rootAttributes}>${fallbackPageParagraph()}</w:ftr>`;
  }

  function cleanPropertyXml(xml) {
    return String(xml || "").replace(
      /<([A-Za-z_][\w:.-]*)\b([^>]*)>([^<]*)<\/\1>/gu,
      (full, tag, attributes, text) =>
        containsBrand(text) ? `<${tag}${attributes}></${tag}>` : full
    );
  }

  function decodeXmlAttribute(value) {
    return String(value || "")
      .replace(/&amp;/gu, "&")
      .replace(/&quot;/gu, '"')
      .replace(/&apos;/gu, "'")
      .replace(/&lt;/gu, "<")
      .replace(/&gt;/gu, ">");
  }

  function relationshipTargets(xml) {
    const targets = [];
    const pattern = /<Relationship\b([^>]*)\/?\s*>/giu;
    let match;
    while ((match = pattern.exec(String(xml || "")))) {
      const attributes = match[1];
      const target = attributes.match(/\bTarget\s*=\s*(?:"([^"]*)"|'([^']*)')/iu);
      if (!target) continue;
      const external = /\bTargetMode\s*=\s*(?:"External"|'External')/iu.test(attributes);
      targets.push({ target: decodeXmlAttribute(target[1] ?? target[2]), external });
    }
    return targets;
  }

  function pruneDeletedRelationships(xml, relsPath, deleted) {
    return String(xml || "").replace(
      /<Relationship\b[^>]*(?:\/\s*>|>[\s\S]*?<\/Relationship>)/giu,
      (relationship) => {
        if (/\bTargetMode\s*=\s*(?:"External"|'External')/iu.test(relationship)) {
          return relationship;
        }
        const target = relationship.match(
          /\bTarget\s*=\s*(?:"([^"]*)"|'([^']*)')/iu
        );
        if (!target) return relationship;
        const resolved = resolveRelationshipTarget(
          relsPath,
          decodeXmlAttribute(target[1] ?? target[2])
        );
        return resolved && deleted.has(resolved) ? "" : relationship;
      }
    );
  }

  function pruneDeletedContentTypes(xml, deleted) {
    return String(xml || "").replace(/<Override\b[^>]*\/\s*>/giu, (override) => {
      const partName = override.match(
        /\bPartName\s*=\s*(?:"([^"]*)"|'([^']*)')/iu
      );
      if (!partName) return override;
      const normalized = decodeXmlAttribute(partName[1] ?? partName[2]).replace(
        /^\/+/,
        ""
      );
      return deleted.has(normalized) ? "" : override;
    });
  }

  function relationshipBase(relsPath) {
    if (relsPath === "_rels/.rels") return "";
    const marker = "/_rels/";
    const markerIndex = relsPath.indexOf(marker);
    if (markerIndex < 0 || !relsPath.endsWith(".rels")) return "";
    const prefix = relsPath.slice(0, markerIndex);
    const sourceName = relsPath.slice(markerIndex + marker.length, -5);
    const sourcePath = prefix ? `${prefix}/${sourceName}` : sourceName;
    return sourcePath.split("/").slice(0, -1).join("/");
  }

  function resolveRelationshipTarget(relsPath, target) {
    if (!target || /^[a-z][a-z0-9+.-]*:/iu.test(target)) {
      return null;
    }
    const parts = target.startsWith("/")
      ? target.split("/")
      : [...relationshipBase(relsPath).split("/"), ...target.split("/")];
    const normalized = [];
    for (const part of parts) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!normalized.length) return null;
        normalized.pop();
      } else {
        normalized.push(part);
      }
    }
    return normalized.join("/");
  }

  async function consSanitizeDocxArchive(bytesLike) {
    const entries = parseZip(bytesLike);
    const entryByName = new Map(entries.map((entry) => [entry.name, entry]));
    if (!entryByName.has("[Content_Types].xml") || !entryByName.has("word/document.xml")) {
      throw new Error("Файл не является корректным DOCX");
    }
    const documentXml = await entryText(entryByName.get("word/document.xml"));
    if (!/<w:document\b/iu.test(documentXml)) {
      throw new Error("DOCX не содержит основную XML-часть Word");
    }

    const deleted = new Set();
    const replacements = new Map();
    const relationshipXml = new Map();
    const removedRelationshipTargets = new Set();
    const remainingRelationshipTargets = new Set();
    const stats = {
      headersCleaned: 0,
      footersCleaned: 0,
      propertiesCleared: 0,
      mediaRemoved: 0,
      thumbnailsRemoved: 0,
    };

    for (const entry of entries) {
      if (/\.rels$/iu.test(entry.name)) {
        relationshipXml.set(entry.name, await entryText(entry));
      }
    }

    for (const entry of entries) {
      if (/^word\/header[^/]*\.xml$/iu.test(entry.name)) {
        replacements.set(entry.name, encoder.encode(cleanHeaderXml(await entryText(entry))));
        stats.headersCleaned += 1;
      } else if (/^word\/footer[^/]*\.xml$/iu.test(entry.name)) {
        replacements.set(entry.name, encoder.encode(cleanFooterXml(await entryText(entry))));
        stats.footersCleaned += 1;
      } else if (/^docProps\/[^/]+\.xml$/iu.test(entry.name)) {
        const original = await entryText(entry);
        const cleaned = cleanPropertyXml(original);
        if (cleaned !== original) {
          replacements.set(entry.name, encoder.encode(cleaned));
          stats.propertiesCleared += 1;
        }
      } else if (/^docProps\/thumbnail\.[^/]+$/iu.test(entry.name)) {
        deleted.add(entry.name);
        stats.thumbnailsRemoved += 1;
      }
    }

    for (const [relsPath, xml] of relationshipXml) {
      const isHeaderFooterRels = /^word\/_rels\/(?:header|footer)[^/]*\.xml\.rels$/iu.test(
        relsPath
      );
      for (const relationship of relationshipTargets(xml)) {
        if (relationship.external) continue;
        const resolved = resolveRelationshipTarget(relsPath, relationship.target);
        if (!resolved) continue;
        (isHeaderFooterRels ? removedRelationshipTargets : remainingRelationshipTargets).add(
          resolved
        );
      }
      if (isHeaderFooterRels) deleted.add(relsPath);
    }

    for (const target of removedRelationshipTargets) {
      if (
        /^word\/media\//iu.test(target) &&
        !remainingRelationshipTargets.has(target) &&
        entryByName.has(target)
      ) {
        deleted.add(target);
        stats.mediaRemoved += 1;
      }
    }

    for (const [relsPath, xml] of relationshipXml) {
      if (deleted.has(relsPath)) continue;
      const cleaned = pruneDeletedRelationships(xml, relsPath, deleted);
      if (cleaned !== xml) replacements.set(relsPath, encoder.encode(cleaned));
    }

    const contentTypes = entryByName.get("[Content_Types].xml");
    const contentTypesXml = await entryText(contentTypes);
    const cleanContentTypes = pruneDeletedContentTypes(contentTypesXml, deleted);
    if (cleanContentTypes !== contentTypesXml) {
      replacements.set("[Content_Types].xml", encoder.encode(cleanContentTypes));
    }

    const outputEntries = [];
    for (const entry of entries) {
      if (deleted.has(entry.name)) continue;
      const replacement = replacements.get(entry.name);
      outputEntries.push(replacement ? storedEntry(entry.name, replacement, entry) : entry);
    }
    return {
      bytes: buildZip(outputEntries),
      mime: DOCX_MIME,
      stats,
    };
  }

  async function consInspectDocxArchive(bytesLike) {
    const result = {};
    for (const entry of parseZip(bytesLike)) {
      result[entry.name] = await inflateEntry(entry);
    }
    return result;
  }

  function consCreateStoredZip(parts) {
    const entries = Object.entries(parts || {}).map(([name, value]) =>
      storedEntry(name, typeof value === "string" ? encoder.encode(value) : value)
    );
    return buildZip(entries);
  }

  const api = {
    consCreateStoredZip,
    consInspectDocxArchive,
    consSanitizeDocxArchive,
  };
  Object.assign(globalThis, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
