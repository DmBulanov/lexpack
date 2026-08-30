/** Structural cleanup shared by generated TXT, Markdown, and HTML exports. */
(function () {
  "use strict";

  // Only horizontal/format separators are accepted inside a brand name. DOM
  // block boundaries and line breaks must never turn two ordinary words into
  // one removable mention.
  const BRAND_SEPARATOR_SOURCE =
    "[\\p{Zs}\\t\\u200b-\\u200d\\ufeff‐‑‒–—-]*";
  const CONSULTANT_NAME_SOURCE =
    `(?:Консультант${BRAND_SEPARATOR_SOURCE}(?:Плюс|[+＋])|` +
    `Consultant${BRAND_SEPARATOR_SOURCE}(?:Plus|[+＋]))`;
  const CONSULTANT_DOMAIN_SOURCE =
    "(?<![\\p{L}\\p{N}._-])(?:https?:\\/\\/)?(?:[a-z0-9-]+\\.)*consultant\\.ru" +
    "(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}_-])";
  const CONSULTANT_BRAND_SOURCE =
    `(?:${CONSULTANT_NAME_SOURCE}|${CONSULTANT_DOMAIN_SOURCE})`;
  const NOTE_PATTERN = new RegExp(
    `^\\s*${CONSULTANT_NAME_SOURCE}[\\p{Zs}\\t\\u200b-\\u200d\\ufeff]*` +
      "[:：][\\p{Zs}\\t\\u200b-\\u200d\\ufeff]*" +
      "примечание(?=$|[\\s.,;:!?()«»—–-])",
    "iu"
  );
  const NOTE_CLASS_PATTERN =
    /(?:^|[-_\s])(?:note|comment|annotation|remark|primech)(?=$|[-_\s])/iu;
  const EXPLICIT_NOTE_TAGS = new Set(["ASIDE", "DETAILS"]);
  const SELF_CONTAINED_NOTE_TAGS = new Set([
    "ADDRESS",
    "BLOCKQUOTE",
    "CAPTION",
    "DD",
    "DT",
    "FIGCAPTION",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "LI",
    "P",
    "PRE",
    "TD",
    "TH",
  ]);
  const BLOCK_BOUNDARY_TAGS = new Set([
    ...SELF_CONTAINED_NOTE_TAGS,
    "ARTICLE",
    "ASIDE",
    "DETAILS",
    "DIV",
    "DL",
    "FIGURE",
    "FOOTER",
    "HEADER",
    "HR",
    "MAIN",
    "NAV",
    "OL",
    "SECTION",
    "SUMMARY",
    "TABLE",
    "TBODY",
    "TFOOT",
    "THEAD",
    "TR",
    "UL",
  ]);
  const BLOCK_BOUNDARY_SELECTOR = Array.from(
    BLOCK_BOUNDARY_TAGS,
    (value) => value.toLowerCase()
  ).join(",");
  const GENERIC_NOTE_CONTAINER_TAGS = new Set([
    "ARTICLE",
    "DIV",
    "MAIN",
    "SECTION",
  ]);
  const SEARCH_HIGHLIGHT_CLASSES = new Set([
    "search-highlight",
    "searchhighlight",
    "splus-search-highlight",
    "x-page-search-highlight",
    "x-search-highlight",
  ]);
  const NOTE_CONTINUATION_STOP_TAGS = new Set([
    "ARTICLE",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HEADER",
    "HR",
    "MAIN",
    "SECTION",
  ]);

  function brandPattern() {
    return new RegExp(CONSULTANT_BRAND_SOURCE, "giu");
  }

  function consIsConsultantNote(value) {
    return NOTE_PATTERN.test(String(value || "").normalize("NFC"));
  }

  function consRemoveConsultantMentions(value) {
    const source = String(value ?? "");
    let mentionsRemoved = 0;
    const text = source.replace(brandPattern(), () => {
      mentionsRemoved += 1;
      return "";
    });
    return { text, mentionsRemoved, protectedNotes: 0 };
  }

  function cleanupError(message, code = "CONTENT_CLEANUP_INCOMPLETE") {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function removalRanges(value) {
    const ranges = [];
    for (const match of String(value || "").matchAll(brandPattern())) {
      ranges.push([match.index, match.index + match[0].length]);
    }
    return ranges;
  }

  function markdownQuoteDepth(value) {
    const match = String(value || "").match(/^[\t ]{0,3}((?:>[\t ]*)+)/u);
    return match ? (match[1].match(/>/gu) || []).length : 0;
  }

  function startsIndependentMarkdownBlock(value, currentQuoteDepth) {
    const line = String(value || "");
    const quoteDepth = markdownQuoteDepth(line);
    if (quoteDepth) return !currentQuoteDepth || quoteDepth < currentQuoteDepth;

    const comparable = line.replace(/^[\t ]{0,3}/u, "");
    return (
      /^(?:#{1,6}(?:[\t ]+|$)|`{3,}|~{3,})/u.test(comparable) ||
      /^(?:(?:[-+*]|\d{1,9}[.)])[\t ]+)/u.test(comparable) ||
      /^(?:(?:\*[\t ]*){3,}|(?:_[\t ]*){3,}|(?:-[\t ]*){3,})$/u.test(
        comparable
      ) ||
      startsCommonMarkHtmlBlock(comparable)
    );
  }

  function startsCommonMarkHtmlBlock(value) {
    const line = String(value || "");
    return (
      /^<(?:script|pre|style|textarea)(?:[\t >]|$)/iu.test(line) ||
      /^(?:<!--|<\?|<![A-Z]|<!\[CDATA\[)/u.test(line) ||
      /^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[\t />]|$)/iu.test(
        line
      )
    );
  }

  function validationBlocks(value) {
    const normalized = String(value || "").replace(/\r\n?/gu, "\n");
    const paragraphBlocks = normalized.split(/\n[\t \u00a0]*\n+/u);
    const blocks = [];

    for (const paragraph of paragraphBlocks) {
      const lines = paragraph.split("\n");
      let current = [];
      let quoteDepth = 0;
      for (const line of lines) {
        if (
          current.length &&
          startsIndependentMarkdownBlock(line, quoteDepth)
        ) {
          blocks.push(current.join("\n"));
          current = [];
          quoteDepth = 0;
        }
        if (!current.length) quoteDepth = markdownQuoteDepth(line);
        current.push(line);
      }
      if (current.length) blocks.push(current.join("\n"));
    }
    return blocks;
  }

  function comparableBlockStart(value) {
    return String(value || "")
      .replace(/^[\t ]{0,3}(?:(?:>[\t ]*)+)/u, "")
      .replace(/^[\t ]{0,3}(?:#{1,6}|[-+*]|\d{1,9}[.)])[\t ]+/u, "");
  }

  /**
   * Validate an already-created TXT/Markdown body without changing one byte.
   * A branded paragraph is accepted only when that same structural block
   * begins with the explicit ConsultantPlus note marker.
   */
  function consAssertConsultantTextClean(value) {
    const source = String(value ?? "");
    for (const block of validationBlocks(source)) {
      if (!removalRanges(block).length) continue;
      const comparable = comparableBlockStart(block);
      if (consIsConsultantNote(comparable)) continue;
      throw cleanupError("Текст содержит неочищенное упоминание КонсультантПлюс");
    }
    return source;
  }

  function tagName(element) {
    return String(element?.tagName || "").toUpperCase();
  }

  function hasExplicitNoteIdentity(element) {
    if (EXPLICIT_NOTE_TAGS.has(tagName(element))) return true;
    const marker = `${element?.id || ""} ${
      typeof element?.className === "string" ? element.className : ""
    }`;
    return NOTE_CLASS_PATTERN.test(marker);
  }

  function hasBlockDescendant(element) {
    return Boolean(element?.querySelector?.(BLOCK_BOUNDARY_SELECTOR));
  }

  function isInsideProtected(node, protectedRoots) {
    let element = node?.nodeType === 1 ? node : node?.parentElement;
    while (element) {
      if (protectedRoots.has(element)) return true;
      element = element.parentElement;
    }
    return false;
  }

  function containsProtectedRoot(element, protectedRoots) {
    for (const protectedRoot of protectedRoots) {
      if (element !== protectedRoot && element.contains?.(protectedRoot)) return true;
    }
    return false;
  }

  function hasBrandedFollowingSibling(element) {
    let sibling = element?.nextSibling;
    while (sibling) {
      if (sibling.nodeType === 1) {
        if (beginsExplicitSection(sibling)) return false;
        if (removalRanges(sibling.textContent).length) return true;
      } else if (
        sibling.nodeType === 3 &&
        removalRanges(sibling.data).length
      ) {
        return true;
      }
      sibling = sibling.nextSibling;
    }
    return false;
  }

  function beginsExplicitSection(element) {
    const firstMeaningfulState = (node) => {
      if (node?.nodeType === 8) return "empty";
      if (node?.nodeType === 3) {
        return /^\s*$/u.test(String(node.data || "")) ? "empty" : "content";
      }
      if (node?.nodeType !== 1) return "empty";
      if (NOTE_CONTINUATION_STOP_TAGS.has(tagName(node))) return "boundary";
      for (const child of node.childNodes || []) {
        const state = firstMeaningfulState(child);
        if (state !== "empty") return state;
      }
      return "empty";
    };

    return firstMeaningfulState(element) === "boundary";
  }

  function documentElements(root) {
    return [root, ...root.querySelectorAll("*")];
  }

  function hasAmbiguousGenericContinuation(element, root) {
    const parent = element?.parentElement;
    if (!parent || hasExplicitNoteIdentity(parent)) return false;
    if (!GENERIC_NOTE_CONTAINER_TAGS.has(tagName(parent))) return false;
    return hasBrandedFollowingSibling(element);
  }

  function discoverProtectedNotes(root) {
    const protectedRoots = new Set();
    const elements = documentElements(root);

    // Explicit note/annotation containers are authoritative and are preserved
    // as a whole. Only exact id/class segments are accepted: `.notebook` and
    // `.commentary` are deliberately not note containers.
    for (const element of elements) {
      if (isInsideProtected(element, protectedRoots)) continue;
      if (
        hasExplicitNoteIdentity(element) &&
        consIsConsultantNote(element.textContent)
      ) {
        protectedRoots.add(element);
      }
    }

    // A self-contained paragraph/cell/list item can be recognized without a
    // class. A note paragraph followed by more content inside a generic wrapper
    // has an unknown boundary, so exporting it would risk truncating the note.
    for (const element of elements) {
      if (isInsideProtected(element, protectedRoots)) continue;
      const tag = tagName(element);
      if (!SELF_CONTAINED_NOTE_TAGS.has(tag) && tag !== "DIV") continue;
      if (!consIsConsultantNote(element.textContent)) continue;
      const leafDiv = tag === "DIV" && !hasBlockDescendant(element);
      if (!SELF_CONTAINED_NOTE_TAGS.has(tag) && !leafDiv) continue;
      if (hasAmbiguousGenericContinuation(element, root)) {
        throw cleanupError(
          "Не удалось однозначно определить границы примечания КонсультантПлюс",
          "CONTENT_NOTE_BOUNDARY_AMBIGUOUS"
        );
      }
      protectedRoots.add(element);
    }

    // Catch a marker split between direct text and child blocks of a generic
    // container. There is no safe way to infer where such a note ends.
    for (const element of elements) {
      if (!GENERIC_NOTE_CONTAINER_TAGS.has(tagName(element))) continue;
      if (isInsideProtected(element, protectedRoots)) continue;
      if (!consIsConsultantNote(element.textContent)) continue;
      if (containsProtectedRoot(element, protectedRoots)) continue;
      throw cleanupError(
        "Не удалось однозначно определить границы примечания КонсультантПлюс",
        "CONTENT_NOTE_BOUNDARY_AMBIGUOUS"
      );
    }

    return protectedRoots;
  }

  function removeRangesFromNodes(nodes, ranges) {
    let offset = 0;
    for (const node of nodes) {
      const value = String(node.data || "");
      const start = offset;
      const end = start + value.length;
      let cursor = 0;
      let cleaned = "";
      for (const [rangeStart, rangeEnd] of ranges) {
        if (rangeEnd <= start || rangeStart >= end) continue;
        const localStart = Math.max(0, rangeStart - start);
        const localEnd = Math.min(value.length, rangeEnd - start);
        cleaned += value.slice(cursor, localStart);
        cursor = Math.max(cursor, localEnd);
      }
      cleaned += value.slice(cursor);
      if (cleaned !== value) node.data = cleaned;
      offset = end;
    }
  }

  function collectInlineTextRuns(root, protectedRoots) {
    const runs = [];
    let current = [];
    const flush = () => {
      if (current.length) runs.push(current);
      current = [];
    };

    const visit = (node) => {
      if (isInsideProtected(node, protectedRoots)) {
        flush();
        return;
      }
      if (node.nodeType === 3) {
        current.push(node);
        return;
      }
      if (node.nodeType !== 1) return;

      const tag = tagName(node);
      const boundary = node !== root && (tag === "BR" || BLOCK_BOUNDARY_TAGS.has(tag));
      if (boundary) flush();
      if (tag !== "BR" && tag !== "HR") {
        for (const child of node.childNodes) visit(child);
      }
      if (boundary) flush();
    };

    visit(root);
    flush();
    return runs;
  }

  function isKnownSearchHighlight(mark) {
    const classes = Array.from(mark?.classList || [], (value) =>
      String(value).toLowerCase()
    );
    return (
      classes.some((value) => SEARCH_HIGHLIGHT_CLASSES.has(value)) ||
      mark?.getAttribute?.("data-search-highlight") === "true"
    );
  }

  function isBlockLikeNode(node, protectedRoots) {
    return (
      node?.nodeType === 1 &&
      (protectedRoots.has(node) || BLOCK_BOUNDARY_TAGS.has(tagName(node)))
    );
  }

  function shouldIgnoreStructuralWhitespace(node, siblings, index, protectedRoots) {
    if (node?.nodeType !== 3 || !/^\s*$/u.test(String(node.data || ""))) {
      return false;
    }
    if (tagName(node.parentElement) === "PRE") return false;

    // Source-code indentation around block children is not document text. In
    // particular, do not leak the newline/indent after the final inline child
    // of a block-based note container into its logical text block.
    if (
      /[\r\n]/u.test(String(node.data || "")) &&
      siblings.some((sibling) => isBlockLikeNode(sibling, protectedRoots))
    ) {
      return true;
    }

    let previous = index - 1;
    while (previous >= 0 && siblings[previous]?.nodeType === 8) previous -= 1;
    let next = index + 1;
    while (next < siblings.length && siblings[next]?.nodeType === 8) next += 1;
    return (
      isBlockLikeNode(siblings[previous], protectedRoots) ||
      isBlockLikeNode(siblings[next], protectedRoots)
    );
  }

  function trailingLineBreakCount(value) {
    const match = String(value || "").match(/(?:(?:\r\n)|[\r\n])+$/u);
    return match ? (match[0].match(/\r\n|[\r\n]/gu) || []).length : 0;
  }

  function ensureLineBreaks(value, count) {
    return value + "\n".repeat(Math.max(0, count - trailingLineBreakCount(value)));
  }

  /**
   * Serialize a detached DOM subtree without relying on layout-dependent
   * `innerText`. Text-node data is read only; the serializer adds structural
   * separators between blocks and for BR elements.
   */
  function consSerializeConsultantText(root) {
    if (!root?.querySelectorAll || !root?.childNodes) {
      throw new Error("Для сериализации текста требуется DOM-элемент");
    }

    const protectedRoots = discoverProtectedNotes(root);

    const serializeChildren = (element, insideProtectedNote) => {
      const siblings = Array.from(element.childNodes || []);
      const chunks = [];

      for (let index = 0; index < siblings.length; index += 1) {
        const node = siblings[index];
        if (node.nodeType === 3) {
          if (
            shouldIgnoreStructuralWhitespace(
              node,
              siblings,
              index,
              protectedRoots
            )
          ) {
            continue;
          }
          if (node.data) {
            chunks.push({ text: String(node.data), block: false, note: false });
          }
          continue;
        }
        if (node.nodeType !== 1) continue;

        const tag = tagName(node);
        if (tag === "BR") {
          chunks.push({ break: true, block: false, note: false });
          continue;
        }
        if (tag === "HR") {
          chunks.push({ break: true, block: true, note: false });
          continue;
        }

        const note = protectedRoots.has(node);
        chunks.push({
          text: serializeChildren(node, insideProtectedNote || note),
          block: note || BLOCK_BOUNDARY_TAGS.has(tag),
          note,
        });
      }

      let output = "";
      let previous = null;
      let hasChunk = false;
      for (const chunk of chunks) {
        if (chunk.break) {
          output = insideProtectedNote
            ? ensureLineBreaks(output, 1)
            : output + "\n";
          previous = chunk;
          hasChunk = true;
          continue;
        }

        if (hasChunk && (previous?.block || chunk.block)) {
          const boundary =
            previous?.note || chunk.note ? 2 : insideProtectedNote ? 1 : 2;
          output = ensureLineBreaks(output, boundary);
        }
        output += chunk.text;
        previous = chunk;
        hasChunk = true;
      }
      return output;
    };

    return serializeChildren(root, protectedRoots.has(root));
  }

  function consCleanConsultantDocument(root, options = {}) {
    if (!root?.querySelectorAll || !root?.ownerDocument?.createTreeWalker) {
      throw new Error("Для очистки документа требуется DOM-элемент");
    }

    const stats = {
      elementsRemoved: 0,
      mentionsRemoved: 0,
      protectedNotes: 0,
      searchMarksUnwrapped: 0,
      attributesCleaned: 0,
      remainingMentions: 0,
    };
    const protectedRoots = discoverProtectedNotes(root);
    stats.protectedNotes = protectedRoots.size;

    const selectors = Array.isArray(options.removeSelectors)
      ? options.removeSelectors.filter(Boolean)
      : [];
    for (const selector of selectors) {
      for (const element of root.querySelectorAll(selector)) {
        if (
          isInsideProtected(element, protectedRoots) ||
          containsProtectedRoot(element, protectedRoots)
        ) {
          continue;
        }
        element.remove();
        stats.elementsRemoved += 1;
      }
    }

    for (const mark of root.querySelectorAll("mark")) {
      if (!isKnownSearchHighlight(mark) || isInsideProtected(mark, protectedRoots)) {
        continue;
      }
      mark.replaceWith(...Array.from(mark.childNodes));
      stats.searchMarksUnwrapped += 1;
    }

    const attributedElements = [
      ...(root.matches?.("[alt], [title]") ? [root] : []),
      ...root.querySelectorAll("[alt], [title]"),
    ];
    for (const element of attributedElements) {
      if (isInsideProtected(element, protectedRoots)) continue;
      for (const name of ["alt", "title"]) {
        if (!element.hasAttribute(name)) continue;
        const value = element.getAttribute(name);
        const cleaned = consRemoveConsultantMentions(value);
        if (cleaned.mentionsRemoved) {
          element.setAttribute(name, cleaned.text);
          stats.attributesCleaned += cleaned.mentionsRemoved;
          stats.mentionsRemoved += cleaned.mentionsRemoved;
        }
      }
    }

    const runs = collectInlineTextRuns(root, protectedRoots);
    for (const nodes of runs) {
      const combined = nodes.map((entry) => entry.data || "").join("");
      if (consIsConsultantNote(combined)) {
        throw cleanupError(
          "Не удалось однозначно определить границы примечания КонсультантПлюс",
          "CONTENT_NOTE_BOUNDARY_AMBIGUOUS"
        );
      }
      const ranges = removalRanges(combined);
      if (!ranges.length) continue;
      removeRangesFromNodes(nodes, ranges);
      stats.mentionsRemoved += ranges.length;
    }

    for (const nodes of collectInlineTextRuns(root, protectedRoots)) {
      stats.remainingMentions += removalRanges(
        nodes.map((entry) => entry.data || "").join("")
      ).length;
    }
    for (const element of attributedElements) {
      if (isInsideProtected(element, protectedRoots)) continue;
      stats.remainingMentions += removalRanges(
        `${element.getAttribute("alt") || ""}\n${element.getAttribute("title") || ""}`
      ).length;
    }
    if (stats.remainingMentions) {
      throw cleanupError("Не удалось полностью удалить упоминания КонсультантПлюс");
    }

    return stats;
  }

  const api = {
    CONSULTANT_BRAND_SOURCE,
    consAssertConsultantTextClean,
    consCleanConsultantDocument,
    consIsConsultantNote,
    consRemoveConsultantMentions,
    consSerializeConsultantText,
  };
  Object.assign(globalThis, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
