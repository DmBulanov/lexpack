/**
 * Local DOCX sanitizer for ConsultantPlus exports.
 *
 * The module preserves the legal structure while removing ConsultantPlus
 * mentions from visible Word text. Paragraphs beginning with the official
 * "КонсультантПлюс: примечание" marker are intentionally left unchanged.
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

  // Match the same in-name separators as the DOM cleaner. In particular,
  // line breaks are not separators: two words on different lines must not be
  // treated as one brand mention.
  const BRAND_SEPARATOR_SOURCE =
    "[\\p{Zs}\\t\\u200b-\\u200d\\ufeff‐‑‒–—-]*";
  const CONSULTANT_DOMAIN_LABEL_SOURCE =
    "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  const CONSULTANT_HOST_SOURCE =
    `(?:${CONSULTANT_DOMAIN_LABEL_SOURCE}\\.)*consultant\\.ru`;
  const CONSULTANT_DOMAIN_SOURCE =
    `(?<![\\p{L}\\p{N}._-])(?:https?:\\/\\/)?${CONSULTANT_HOST_SOURCE}` +
    `(?=$|[^\\p{L}\\p{N}._-]|\\.(?![\\p{L}\\p{N}_-]))`;
  const BRAND_MENTION_SOURCE =
    `(?:Консультант${BRAND_SEPARATOR_SOURCE}(?:Плюс|[+＋])|` +
    `Consultant${BRAND_SEPARATOR_SOURCE}(?:Plus|[+＋])|` +
    `${CONSULTANT_DOMAIN_SOURCE})`;
  const CONSULTANT_DOMAIN_ONLY_PATTERN = new RegExp(
    `^\\s*(?:https?:\\/\\/)?${CONSULTANT_HOST_SOURCE}(?:\\/|\\.)?\\s*$`,
    "iu"
  );
  const CONSULTANT_NOTE_PATTERN = new RegExp(
    `^\\s*Консультант${BRAND_SEPARATOR_SOURCE}(?:Плюс|[+＋])` +
      `${BRAND_SEPARATOR_SOURCE}[:：]${BRAND_SEPARATOR_SOURCE}` +
      "примечание(?=$|[\\s.,;:!?()«»—–-])",
    "iu"
  );

  function brandPattern() {
    return new RegExp(BRAND_MENTION_SOURCE, "giu");
  }

  function brandRanges(value) {
    return [...String(value || "").matchAll(brandPattern())].map((match) => [
      match.index,
      match.index + match[0].length,
    ]);
  }

  function isConsultantNote(value) {
    return CONSULTANT_NOTE_PATTERN.test(String(value || "").normalize("NFC"));
  }

  function containsBrand(value) {
    return brandRanges(value).length > 0;
  }

  function isHeaderFooterBoilerplate(value) {
    const text = String(value || "");
    if (isConsultantNote(text)) return false;
    return /(?:Документ\s+предоставлен|Дата\s+сохранения|надежная\s+правовая\s+поддержка)/iu.test(
      text
    ) || CONSULTANT_DOMAIN_ONLY_PATTERN.test(text);
  }

  function escapeXmlText(value) {
    return String(value || "")
      .replace(/&/gu, "&amp;")
      .replace(/</gu, "&lt;")
      .replace(/>/gu, "&gt;");
  }

  function decodeXmlText(value) {
    return decodeXmlAttribute(value);
  }

  function encodeXmlNodeValue(node, value) {
    return node.encoding === "cdata"
      ? String(value || "").replaceAll("]]>", "]]]]><![CDATA[>")
      : escapeXmlText(value);
  }

  function cleanTextNodeValue(value, globalStart, ranges) {
    const source = String(value || "");
    const globalEnd = globalStart + source.length;
    let cursor = 0;
    let cleaned = "";
    for (const [rangeStart, rangeEnd] of ranges) {
      if (rangeEnd <= globalStart || rangeStart >= globalEnd) continue;
      const localStart = Math.max(0, rangeStart - globalStart);
      const localEnd = Math.min(source.length, rangeEnd - globalStart);
      cleaned += source.slice(cursor, localStart);
      cursor = Math.max(cursor, localEnd);
    }
    return cleaned + source.slice(cursor);
  }

  function xmlTagRanges(value) {
    const source = String(value || "");
    const tags = [];
    let cursor = 0;
    while (cursor < source.length) {
      const start = source.indexOf("<", cursor);
      if (start < 0) break;
      let end;
      if (source.startsWith("<!--", start)) {
        const close = source.indexOf("-->", start + 4);
        if (close < 0) throw new Error("DOCX содержит незавершённый XML-комментарий");
        end = close + 3;
      } else if (source.startsWith("<![CDATA[", start)) {
        const close = source.indexOf("]]>", start + 9);
        if (close < 0) throw new Error("DOCX содержит незавершённый CDATA-блок");
        end = close + 3;
      } else if (source.startsWith("<?", start)) {
        const close = source.indexOf("?>", start + 2);
        if (close < 0) throw new Error("DOCX содержит незавершённую XML-инструкцию");
        end = close + 2;
      } else {
        let quote = "";
        let index = start + 1;
        for (; index < source.length; index += 1) {
          const character = source[index];
          if (quote) {
            if (character === quote) quote = "";
          } else if (character === '"' || character === "'") {
            quote = character;
          } else if (character === ">") {
            break;
          }
        }
        if (index >= source.length) throw new Error("DOCX содержит незавершённый XML-тег");
        end = index + 1;
      }
      tags.push({ start, end, value: source.slice(start, end) });
      cursor = end;
    }
    return tags;
  }

  function parsedXmlTag(tag) {
    if (/^<(?:\?|!)/u.test(tag.value)) return null;
    const match = tag.value.match(/^<\s*(\/?)\s*([A-Za-z_][\w:.-]*)\b/u);
    if (!match) return null;
    return {
      closing: Boolean(match[1]),
      name: match[2].toLowerCase(),
      selfClosing: /\/\s*>$/u.test(tag.value),
    };
  }

  function xmlCharacterDataNodes(source, start, end, metadata = {}) {
    const rangeSource = source.slice(start, end);
    const nodes = [];
    let cursor = 0;
    const addNode = (localStart, localEnd, encoding) => {
      if (localEnd <= localStart) return;
      const rawValue = rangeSource.slice(localStart, localEnd);
      nodes.push({
        ...metadata,
        start: start + localStart,
        end: start + localEnd,
        value: encoding === "cdata" ? rawValue : decodeXmlText(rawValue),
        encoding,
      });
    };

    for (const tag of xmlTagRanges(rangeSource)) {
      addNode(cursor, tag.start, "text");
      if (tag.value.startsWith("<![CDATA[")) {
        addNode(tag.start + 9, tag.end - 3, "cdata");
      }
      cursor = tag.end;
    }
    addNode(cursor, rangeSource.length, "text");
    return nodes;
  }

  const WORD_PARAGRAPH_TAGS = new Set(["w:p", "a:p"]);
  const VISIBLE_WORD_TEXT_TAGS = new Set(["w:t", "w:deltext", "a:t"]);
  const INSTRUCTION_WORD_TEXT_TAGS = new Set(["w:instrtext"]);
  const WORD_LINE_BREAK_TAGS = new Set(["w:br", "w:cr", "a:br"]);
  const HEADER_OBJECT_TAGS = new Set(["w:drawing", "w:pict", "w:object"]);

  function scanWordXml(xml) {
    const source = String(xml || "");
    const paragraphs = [];
    const textNodes = [];
    const attributes = [];
    const objects = [];
    const paragraphStack = [];
    const textStack = [];
    const objectStack = [];

    for (const tag of xmlTagRanges(source)) {
      const parsed = parsedXmlTag(tag);
      if (!parsed) continue;
      const { name } = parsed;
      if (parsed.closing) {
        if (VISIBLE_WORD_TEXT_TAGS.has(name) || INSTRUCTION_WORD_TEXT_TAGS.has(name)) {
          const opened = textStack.pop();
          if (!opened || opened.name !== name) {
            throw new Error("DOCX содержит некорректно вложенный текстовый XML-тег");
          }
          const nodes = xmlCharacterDataNodes(source, opened.end, tag.start, {
            tag: name,
            kind: VISIBLE_WORD_TEXT_TAGS.has(name) ? "visible" : "instruction",
            paragraph: opened.paragraph,
            segment: opened.segment,
          });
          textNodes.push(...nodes);
          if (opened.paragraph) opened.paragraph.textNodes.push(...nodes);
        } else if (WORD_PARAGRAPH_TAGS.has(name)) {
          const paragraph = paragraphStack.pop();
          if (!paragraph || paragraph.tag !== name) {
            throw new Error("DOCX содержит некорректно вложенный абзац");
          }
          paragraph.end = tag.end;
        } else if (HEADER_OBJECT_TAGS.has(name)) {
          const object = objectStack.pop();
          if (!object || object.name !== name) {
            throw new Error("DOCX содержит некорректно вложенный объект Word");
          }
          object.end = tag.end;
          objects.push(object);
        }
        continue;
      }

      let openedParagraph = null;
      if (WORD_PARAGRAPH_TAGS.has(name)) {
        const parent = paragraphStack.at(-1) || null;
        const paragraph = {
          tag: name,
          start: tag.start,
          end: parsed.selfClosing ? tag.end : null,
          parent,
          children: [],
          textNodes: [],
          attributes: [],
          segment: 0,
          note: false,
        };
        openedParagraph = paragraph;
        if (parent) parent.children.push(paragraph);
        paragraphs.push(paragraph);
        if (!parsed.selfClosing) paragraphStack.push(paragraph);
      } else if (
        (VISIBLE_WORD_TEXT_TAGS.has(name) || INSTRUCTION_WORD_TEXT_TAGS.has(name)) &&
        !parsed.selfClosing
      ) {
        textStack.push({
          name,
          end: tag.end,
          paragraph: paragraphStack.at(-1) || null,
          segment: paragraphStack.at(-1)?.segment || 0,
        });
      } else if (WORD_LINE_BREAK_TAGS.has(name)) {
        const paragraph = paragraphStack.at(-1) || null;
        if (paragraph) paragraph.segment += 1;
      } else if (HEADER_OBJECT_TAGS.has(name)) {
        const object = {
          name,
          start: tag.start,
          end: parsed.selfClosing ? tag.end : null,
          paragraph: paragraphStack.at(-1) || null,
        };
        if (parsed.selfClosing) objects.push(object);
        else objectStack.push(object);
      }

      const attributeParagraph = openedParagraph || paragraphStack.at(-1) || null;
      for (const attribute of xmlAttributeNodes(tag)) {
        attribute.paragraph = attributeParagraph;
        attributes.push(attribute);
        if (attributeParagraph) attributeParagraph.attributes.push(attribute);
      }
    }
    if (paragraphStack.length || textStack.length || objectStack.length) {
      throw new Error("DOCX содержит незавершённую структуру Word XML");
    }
    return { source, paragraphs, textNodes, attributes, objects };
  }

  function paragraphNodeSegments(paragraph, kind) {
    const segments = [];
    for (const node of paragraph.textNodes.filter((entry) => entry.kind === kind)) {
      let segment = segments.at(-1);
      if (!segment || segment.id !== node.segment) {
        segment = { id: node.segment, nodes: [], value: "" };
        segments.push(segment);
      }
      segment.nodes.push(node);
      segment.value += node.value;
    }
    return segments;
  }

  function paragraphIsNote(paragraph) {
    const firstSegment = paragraphNodeSegments(paragraph, "visible")[0];
    return Boolean(firstSegment && isConsultantNote(firstSegment.value));
  }

  function paragraphIsProtected(paragraph) {
    let current = paragraph;
    while (current) {
      if (current.note) return true;
      current = current.parent;
    }
    return false;
  }

  function textNodeReplacements(nodes, ranges) {
    const replacements = [];
    let globalStart = 0;
    for (const node of nodes) {
      const cleaned = cleanTextNodeValue(node.value, globalStart, ranges);
      if (cleaned !== node.value) {
        replacements.push({
          start: node.start,
          end: node.end,
          value: encodeXmlNodeValue(node, cleaned),
        });
      }
      globalStart += node.value.length;
    }
    return replacements;
  }

  function rangeContains(container, range) {
    return container.start <= range.start && container.end >= range.end;
  }

  function rangesOverlap(first, second) {
    return first.start < second.end && second.start < first.end;
  }

  function outermostReplacements(replacements) {
    const ordered = [...replacements].sort(
      (first, second) => first.start - second.start || second.end - first.end
    );
    const result = [];
    for (const replacement of ordered) {
      if (result.some((parent) => rangeContains(parent, replacement))) continue;
      if (result.some((other) => rangesOverlap(other, replacement))) {
        throw new Error("DOCX очиститель получил пересекающиеся XML-структуры");
      }
      result.push(replacement);
    }
    return result;
  }

  function applyXmlReplacements(source, replacements) {
    const ordered = [...replacements].sort((a, b) => b.start - a.start || a.end - b.end);
    let output = source;
    let previousStart = source.length + 1;
    for (const replacement of ordered) {
      if (replacement.end > previousStart) {
        throw new Error("DOCX очиститель получил пересекающиеся XML-диапазоны");
      }
      output = output.slice(0, replacement.start) + replacement.value + output.slice(replacement.end);
      previousStart = replacement.start;
    }
    return output;
  }

  function cleanWordTextXml(xml, options = {}) {
    const scanned = scanWordXml(xml);
    const stats = { mentionsRemoved: 0, protectedNotes: 0, serviceBlocksRemoved: 0 };
    for (const paragraph of scanned.paragraphs) {
      paragraph.note = paragraphIsNote(paragraph);
      if (paragraph.note) stats.protectedNotes += 1;
    }

    const paragraphRemovals = [];
    const replacements = [];
    for (const paragraph of scanned.paragraphs) {
      if (paragraphIsProtected(paragraph)) continue;
      const visibleSegments = paragraphNodeSegments(paragraph, "visible");
      const instructionSegments = paragraphNodeSegments(paragraph, "instruction");
      const visibleText = visibleSegments.map((segment) => segment.value).join("\n");
      const segmentRanges = [...visibleSegments, ...instructionSegments].map((segment) => ({
        segment,
        ranges: brandRanges(segment.value),
      }));
      stats.mentionsRemoved += segmentRanges.reduce(
        (count, entry) => count + entry.ranges.length,
        0
      );

      if (
        options.removeBoilerplate &&
        !paragraph.children.length &&
        isHeaderFooterBoilerplate(visibleText)
      ) {
        paragraphRemovals.push({
          start: paragraph.start,
          end: paragraph.end,
          value: `<${paragraph.tag}/>`,
        });
        stats.serviceBlocksRemoved += 1;
        continue;
      }
      for (const { segment, ranges } of segmentRanges) {
        replacements.push(...textNodeReplacements(segment.nodes, ranges));
      }
    }

    for (const node of scanned.textNodes.filter((entry) => !entry.paragraph)) {
      const ranges = brandRanges(node.value);
      stats.mentionsRemoved += ranges.length;
      replacements.push(...textNodeReplacements([node], ranges));
    }

    for (const attribute of scanned.attributes) {
      if (attribute.paragraph && paragraphIsProtected(attribute.paragraph)) continue;
      const ranges = brandRanges(attribute.value);
      if (!ranges.length) continue;
      stats.mentionsRemoved += ranges.length;
      const cleaned = cleanTextNodeValue(attribute.value, 0, ranges);
      replacements.push({
        start: attribute.start,
        end: attribute.end,
        value: escapeXmlAttribute(cleaned, attribute.quote),
      });
    }

    const protectedParagraphs = scanned.paragraphs.filter((paragraph) =>
      paragraphIsProtected(paragraph)
    );
    const objectRemovals = [];
    if (options.removeObjects) {
      const candidates = scanned.objects
        .filter((object) => object.end != null)
        .filter(
          (object) =>
            !protectedParagraphs.some((paragraph) => rangesOverlap(object, paragraph)) &&
            !paragraphRemovals.some((paragraph) => rangeContains(paragraph, object))
        )
        .sort((a, b) => a.start - b.start || b.end - a.end);
      for (const object of candidates) {
        if (objectRemovals.some((parent) => rangeContains(parent, object))) continue;
        objectRemovals.push({ start: object.start, end: object.end, value: "" });
      }
    }

    const fullRemovals = outermostReplacements([
      ...paragraphRemovals,
      ...objectRemovals,
    ]);
    const safeInlineReplacements = replacements.filter(
      (replacement) => !fullRemovals.some((range) => rangeContains(range, replacement))
    );
    return {
      xml: applyXmlReplacements(scanned.source, [...fullRemovals, ...safeInlineReplacements]),
      ...stats,
    };
  }

  function remainingWordMentions(xml) {
    const scanned = scanWordXml(xml);
    let remaining = 0;
    for (const paragraph of scanned.paragraphs) {
      paragraph.note = paragraphIsNote(paragraph);
    }
    for (const paragraph of scanned.paragraphs) {
      if (paragraphIsProtected(paragraph)) continue;
      for (const segment of [
        ...paragraphNodeSegments(paragraph, "visible"),
        ...paragraphNodeSegments(paragraph, "instruction"),
      ]) {
        remaining += brandRanges(segment.value).length;
      }
    }
    for (const node of scanned.textNodes.filter((entry) => !entry.paragraph)) {
      remaining += brandRanges(node.value).length;
    }
    for (const attribute of scanned.attributes) {
      if (attribute.paragraph && paragraphIsProtected(attribute.paragraph)) continue;
      remaining += brandRanges(attribute.value).length;
    }
    return remaining;
  }

  function cleanHeaderXml(xml) {
    const cleaned = cleanWordTextXml(xml, {
      removeBoilerplate: true,
      removeObjects: true,
    });
    if (!/<w:p\b/iu.test(cleaned.xml)) {
      cleaned.xml = cleaned.xml.replace(/<\/w:hdr>/iu, "<w:p/></w:hdr>");
    }
    return cleaned;
  }

  function fallbackPageParagraph() {
    return `<w:p><w:pPr><w:jc w:val="right"/></w:pPr>` +
      `<w:r><w:t xml:space="preserve">Страница </w:t></w:r>` +
      `<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>` +
      `<w:r><w:t xml:space="preserve"> из </w:t></w:r>` +
      `<w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>1</w:t></w:r></w:fldSimple>` +
      `</w:p>`;
  }

  function appendFooterContent(xml, content) {
    const source = String(xml || "");
    const selfClosingRoot = /<w:ftr\b([^>]*?)\/\s*>/iu;
    if (selfClosingRoot.test(source)) {
      return source.replace(
        selfClosingRoot,
        (_full, attributes) => `<w:ftr${attributes}>${content}</w:ftr>`
      );
    }
    const closingRoot = /<\/w:ftr\s*>/iu;
    if (!closingRoot.test(source)) {
      throw new Error("DOCX не содержит корректный корневой элемент footer");
    }
    return source.replace(closingRoot, (closing) => `${content}${closing}`);
  }

  function cleanFooterXml(xml) {
    const cleaned = cleanWordTextXml(xml, {
      removeBoilerplate: true,
      removeObjects: true,
    });
    const instructions = [];
    const attributePattern = /\b(?:[A-Za-z_][\w.-]*:)?instr\s*=\s*(?:"([^"]*)"|'([^']*)')/giu;
    let attribute;
    while ((attribute = attributePattern.exec(cleaned.xml))) {
      instructions.push(decodeXmlAttribute(attribute[1] ?? attribute[2]));
    }
    for (const node of scanWordXml(cleaned.xml).textNodes) {
      if (node.kind === "instruction") instructions.push(node.value);
    }
    const allInstructions = instructions.join("\n");
    if (!/\bPAGE\b/iu.test(allInstructions) || !/\bNUMPAGES\b/iu.test(allInstructions)) {
      cleaned.xml = appendFooterContent(cleaned.xml, fallbackPageParagraph());
    }
    return cleaned;
  }

  function escapeXmlAttribute(value, quote) {
    const escaped = escapeXmlText(value);
    return quote === "'"
      ? escaped.replace(/'/gu, "&apos;")
      : escaped.replace(/"/gu, "&quot;");
  }

  function xmlAttributeNodes(tag) {
    const parsed = parsedXmlTag(tag);
    if (!parsed || parsed.closing) return [];
    const attributes = [];
    const pattern = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
    let match;
    while ((match = pattern.exec(tag.value))) {
      const name = match[1];
      if (/^xmlns(?::|$)/iu.test(name)) continue;
      const rawValue = match[2] ?? match[3];
      const quote = match[2] !== undefined ? '"' : "'";
      const quoteOffset = match[0].indexOf(quote);
      const start = tag.start + match.index + quoteOffset + 1;
      attributes.push({
        name,
        quote,
        start,
        end: start + rawValue.length,
        value: decodeXmlAttribute(rawValue),
      });
    }
    return attributes;
  }

  function scanPropertyXml(xml) {
    const source = String(xml || "");
    const groups = [];
    const textNodes = [];
    const attributes = [];
    const stack = [];
    let root = null;
    let cursor = 0;

    const addTextNode = (start, end, encoding = "text") => {
      if (end <= start) return;
      const rawValue = source.slice(start, end);
      if (encoding === "text" && /^\s*$/u.test(rawValue)) return;
      const group = stack.at(-1)?.group || null;
      const node = {
        start,
        end,
        value: encoding === "cdata" ? rawValue : decodeXmlText(rawValue),
        encoding,
        group,
      };
      textNodes.push(node);
      if (group) group.textNodes.push(node);
    };

    for (const tag of xmlTagRanges(source)) {
      addTextNode(cursor, tag.start);
      if (tag.value.startsWith("<![CDATA[")) {
        addTextNode(tag.start + 9, tag.end - 3, "cdata");
        cursor = tag.end;
        continue;
      }
      const parsed = parsedXmlTag(tag);
      if (parsed) {
        if (parsed.closing) {
          const element = stack.pop();
          if (!element || element.name !== parsed.name) {
            throw new Error("DOCX содержит некорректно вложенные свойства XML");
          }
        } else {
          attributes.push(...xmlAttributeNodes(tag));
          const parent = stack.at(-1) || null;
          const element = {
            name: parsed.name,
            parent,
            group: null,
            textNodes: [],
          };
          if (!root) {
            root = element;
          } else if (parent === root) {
            element.group = element;
            groups.push(element);
          } else {
            element.group = parent?.group || null;
          }
          if (!parsed.selfClosing) stack.push(element);
        }
      }
      cursor = tag.end;
    }
    addTextNode(cursor, source.length);
    if (stack.length) throw new Error("DOCX содержит незавершённые свойства XML");
    return { source, groups, textNodes, attributes };
  }

  function propertyTextReplacements(nodes, stats) {
    if (!nodes.length) return [];
    const value = nodes.map((node) => node.value).join("");
    const ranges = brandRanges(value);
    if (!ranges.length) return [];
    stats.mentionsRemoved += ranges.length;
    const removalRanges = isHeaderFooterBoilerplate(value)
      ? [[0, value.length]]
      : ranges;
    return textNodeReplacements(nodes, removalRanges);
  }

  function cleanPropertyXml(xml) {
    const scanned = scanPropertyXml(xml);
    const stats = { mentionsRemoved: 0 };
    const replacements = [];
    const groupedNodes = new Set();
    for (const group of scanned.groups) {
      group.textNodes.forEach((node) => groupedNodes.add(node));
      replacements.push(...propertyTextReplacements(group.textNodes, stats));
    }
    for (const node of scanned.textNodes) {
      if (!groupedNodes.has(node)) {
        replacements.push(...propertyTextReplacements([node], stats));
      }
    }
    for (const attribute of scanned.attributes) {
      const ranges = brandRanges(attribute.value);
      if (!ranges.length) continue;
      stats.mentionsRemoved += ranges.length;
      const cleaned = cleanTextNodeValue(attribute.value, 0, ranges);
      replacements.push({
        start: attribute.start,
        end: attribute.end,
        value: escapeXmlAttribute(cleaned, attribute.quote),
      });
    }
    return {
      xml: applyXmlReplacements(scanned.source, replacements),
      mentionsRemoved: stats.mentionsRemoved,
    };
  }

  function remainingPropertyMentions(xml) {
    const scanned = scanPropertyXml(xml);
    let remaining = 0;
    const groupedNodes = new Set();
    for (const group of scanned.groups) {
      group.textNodes.forEach((node) => groupedNodes.add(node));
      remaining += brandRanges(group.textNodes.map((node) => node.value).join("")).length;
    }
    for (const node of scanned.textNodes) {
      if (!groupedNodes.has(node)) remaining += brandRanges(node.value).length;
    }
    for (const attribute of scanned.attributes) {
      remaining += brandRanges(attribute.value).length;
    }
    return remaining;
  }

  function decodeXmlEntities(value) {
    return String(value || "").replace(
      /&(?:#x([0-9A-Fa-f]+)|#([0-9]+)|(amp|quot|apos|lt|gt));/gu,
      (entity, hex, decimal, named) => {
        if (hex || decimal) {
          const point = Number.parseInt(hex || decimal, hex ? 16 : 10);
          return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
            ? String.fromCodePoint(point)
            : entity;
        }
        return {
          amp: "&",
          quot: '"',
          apos: "'",
          lt: "<",
          gt: ">",
        }[named] || entity;
      }
    );
  }

  function decodeXmlAttribute(value) {
    return decodeXmlEntities(value);
  }

  function relationshipTargets(xml) {
    const targets = [];
    for (const match of String(xml || "").matchAll(relationshipElementPattern())) {
      const relationship = match[0];
      const target = relationship.match(/\bTarget\s*=\s*(?:"([^"]*)"|'([^']*)')/iu);
      if (!target) continue;
      const external = /\bTargetMode\s*=\s*(?:"External"|'External')/iu.test(
        relationship
      );
      targets.push({ target: decodeXmlAttribute(target[1] ?? target[2]), external });
    }
    return targets;
  }

  const RELATIONSHIP_QNAME_SOURCE =
    "(?:[A-Za-z_][\\w.-]*:)?Relationship";

  function relationshipElementPattern() {
    return new RegExp(
      `<(${RELATIONSHIP_QNAME_SOURCE})\\b[^>]*(?:\\/\\s*>|>[\\s\\S]*?<\\/\\1\\s*>)`,
      "giu"
    );
  }

  function relationshipSourcePart(relsPath) {
    const marker = "/_rels/";
    const markerIndex = String(relsPath || "").indexOf(marker);
    if (markerIndex < 0 || !String(relsPath).endsWith(".rels")) return "";
    const directory = relsPath.slice(0, markerIndex);
    const filename = relsPath.slice(markerIndex + marker.length, -5);
    return `${directory}/${filename}`;
  }

  const OFFICE_RELATIONSHIP_NAMESPACES = new Set([
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "http://purl.oclc.org/ooxml/officeDocument/relationships",
  ]);

  function regexEscape(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }

  function referencedRelationshipIds(xml) {
    const source = String(xml || "");
    const ids = new Set();
    const prefixes = new Set(["r"]);
    const namespacePattern =
      /\bxmlns:([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
    let namespace;
    while ((namespace = namespacePattern.exec(source))) {
      const uri = decodeXmlAttribute(namespace[2] ?? namespace[3]);
      if (OFFICE_RELATIONSHIP_NAMESPACES.has(uri)) prefixes.add(namespace[1]);
    }
    const prefixSource = [...prefixes].map(regexEscape).join("|");
    const pattern = new RegExp(
      `\\b(?:${prefixSource}):(?:id|embed|link)\\s*=\\s*(?:"([^"]+)"|'([^']+)')`,
      "giu"
    );
    let match;
    while ((match = pattern.exec(source))) ids.add(decodeXmlAttribute(match[1] ?? match[2]));
    return ids;
  }

  function pruneUnusedPartRelationships(xml, relsPath, usedIds, removedTargets) {
    return String(xml || "").replace(
      relationshipElementPattern(),
      (relationship) => {
        const id = relationship.match(/\bId\s*=\s*(?:"([^"]+)"|'([^']+)')/iu);
        const idValue = id ? decodeXmlAttribute(id[1] ?? id[2]) : "";
        if (!id || usedIds.has(idValue)) return relationship;
        if (!/\bTargetMode\s*=\s*(?:"External"|'External')/iu.test(relationship)) {
          const target = relationship.match(
            /\bTarget\s*=\s*(?:"([^"]+)"|'([^']+)')/iu
          );
          const resolved = target
            ? resolveRelationshipTarget(
                relsPath,
                decodeXmlAttribute(target[1] ?? target[2])
              )
            : null;
          if (resolved) removedTargets.add(resolved);
        }
        return "";
      }
    );
  }

  function pruneDeletedRelationships(xml, relsPath, deleted) {
    return String(xml || "").replace(
      relationshipElementPattern(),
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
    const stats = {
      headersCleaned: 0,
      footersCleaned: 0,
      propertiesCleared: 0,
      mediaRemoved: 0,
      thumbnailsRemoved: 0,
      bodyPartsCleaned: 0,
      brandMentionsRemoved: 0,
      protectedNotes: 0,
      serviceBlocksRemoved: 0,
      remainingMentions: 0,
    };

    for (const entry of entries) {
      if (/\.rels$/iu.test(entry.name)) {
        relationshipXml.set(entry.name, await entryText(entry));
      }
    }

    for (const entry of entries) {
      if (/^word\/header[^/]*\.xml$/iu.test(entry.name)) {
        const cleaned = cleanHeaderXml(await entryText(entry));
        replacements.set(entry.name, encoder.encode(cleaned.xml));
        stats.headersCleaned += 1;
        stats.brandMentionsRemoved += cleaned.mentionsRemoved;
        stats.protectedNotes += cleaned.protectedNotes;
        stats.serviceBlocksRemoved += cleaned.serviceBlocksRemoved;
      } else if (/^word\/footer[^/]*\.xml$/iu.test(entry.name)) {
        const cleaned = cleanFooterXml(await entryText(entry));
        replacements.set(entry.name, encoder.encode(cleaned.xml));
        stats.footersCleaned += 1;
        stats.brandMentionsRemoved += cleaned.mentionsRemoved;
        stats.protectedNotes += cleaned.protectedNotes;
        stats.serviceBlocksRemoved += cleaned.serviceBlocksRemoved;
      } else if (/^word\/.*\.xml$/iu.test(entry.name)) {
        const original = await entryText(entry);
        const cleaned = cleanWordTextXml(original);
        if (cleaned.xml !== original) {
          replacements.set(entry.name, encoder.encode(cleaned.xml));
          stats.bodyPartsCleaned += 1;
        }
        stats.brandMentionsRemoved += cleaned.mentionsRemoved;
        stats.protectedNotes += cleaned.protectedNotes;
        stats.serviceBlocksRemoved += cleaned.serviceBlocksRemoved;
      } else if (/^docProps\/[^/]+\.xml$/iu.test(entry.name)) {
        const original = await entryText(entry);
        const cleaned = cleanPropertyXml(original);
        if (cleaned.xml !== original) {
          replacements.set(entry.name, encoder.encode(cleaned.xml));
          stats.propertiesCleared += 1;
        }
        stats.brandMentionsRemoved += cleaned.mentionsRemoved;
      } else if (/^docProps\/thumbnail\.[^/]+$/iu.test(entry.name)) {
        deleted.add(entry.name);
        stats.thumbnailsRemoved += 1;
      }
    }

    const removedRelationshipTargets = new Set();
    const remainingRelationshipTargets = new Set();
    for (const [relsPath, originalXml] of relationshipXml) {
      let xml = originalXml;
      if (/^word\/_rels\/(?:header|footer)[^/]*\.xml\.rels$/iu.test(relsPath)) {
        const sourcePart = relationshipSourcePart(relsPath);
        const sourceReplacement = replacements.get(sourcePart);
        const sourceXml = sourceReplacement
          ? decoder.decode(sourceReplacement)
          : entryByName.has(sourcePart)
            ? await entryText(entryByName.get(sourcePart))
            : "";
        xml = pruneUnusedPartRelationships(
          xml,
          relsPath,
          referencedRelationshipIds(sourceXml),
          removedRelationshipTargets
        );
        if (xml !== originalXml) replacements.set(relsPath, encoder.encode(xml));
        relationshipXml.set(relsPath, xml);
      }
      for (const relationship of relationshipTargets(xml)) {
        if (relationship.external) continue;
        const resolved = resolveRelationshipTarget(relsPath, relationship.target);
        if (resolved) remainingRelationshipTargets.add(resolved);
      }
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

    for (const entry of entries) {
      if (deleted.has(entry.name)) continue;
      const replacement = replacements.get(entry.name);
      const xml = replacement
        ? decoder.decode(replacement)
        : /^(?:word\/.*|docProps\/[^/]+)\.xml$/iu.test(entry.name)
          ? await entryText(entry)
          : "";
      if (!xml) continue;
      if (/^word\/.*\.xml$/iu.test(entry.name)) {
        stats.remainingMentions += remainingWordMentions(xml);
      } else if (/^docProps\/[^/]+\.xml$/iu.test(entry.name)) {
        stats.remainingMentions += remainingPropertyMentions(xml);
      }
    }
    if (stats.remainingMentions) {
      throw new Error(
        "Не удалось полностью удалить упоминания КонсультантПлюс из Word-файла"
      );
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
