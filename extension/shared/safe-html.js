/**
 * Build a static standalone HTML export in an offscreen DOM. Untrusted source
 * is parsed in an inert template and copied through the declared allowlist
 * before the file is created; the downloaded document needs no runtime script.
 */
(function () {
  const safeHtmlPolicy = Object.freeze({
    allowedTags: [
      "A",
      "ABBR",
      "ARTICLE",
      "ASIDE",
      "B",
      "BLOCKQUOTE",
      "BR",
      "CAPTION",
      "CODE",
      "COL",
      "COLGROUP",
      "DD",
      "DEL",
      "DETAILS",
      "DFN",
      "DIV",
      "DL",
      "DT",
      "EM",
      "FIGCAPTION",
      "FIGURE",
      "FOOTER",
      "H1",
      "H2",
      "H3",
      "H4",
      "H5",
      "H6",
      "HEADER",
      "HR",
      "I",
      "IMG",
      "INS",
      "KBD",
      "LI",
      "MAIN",
      "MARK",
      "OL",
      "P",
      "PRE",
      "Q",
      "S",
      "SAMP",
      "SECTION",
      "SMALL",
      "SPAN",
      "STRONG",
      "SUB",
      "SUMMARY",
      "SUP",
      "TABLE",
      "TBODY",
      "TD",
      "TFOOT",
      "TH",
      "THEAD",
      "TIME",
      "TR",
      "U",
      "UL",
      "VAR",
    ],
    dropWithChildren: [
      "APPLET",
      "AUDIO",
      "BASE",
      "EMBED",
      "FRAME",
      "FRAMESET",
      "HEAD",
      "IFRAME",
      "LINK",
      "MATH",
      "META",
      "NOSCRIPT",
      "OBJECT",
      "SCRIPT",
      "STYLE",
      "SVG",
      "TEMPLATE",
      "TITLE",
      "VIDEO",
    ],
    commonAttributes: ["class", "dir", "lang", "title"],
    attributesByTag: {
      COL: ["span", "width"],
      IMG: ["alt", "height", "src", "width"],
      LI: ["value"],
      OL: ["reversed", "start", "type"],
      TD: ["abbr", "colspan", "headers", "rowspan"],
      TH: ["abbr", "colspan", "headers", "rowspan", "scope"],
      TIME: ["datetime"],
    },
    numericAttributes: [
      "colspan",
      "height",
      "rowspan",
      "span",
      "start",
      "value",
      "width",
    ],
    imageSource: {
      scheme: "data",
      mediaTypes: ["image/png", "image/gif", "image/jpeg", "image/webp"],
      encoding: "base64",
    },
  });

  function escapeHtmlAttribute(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  const safeHtmlLimits = Object.freeze({
    maxSourceBytes: 16 * 1024 * 1024,
    maxNodes: 200000,
    maxImagePayloadChars: 8 * 1024 * 1024,
  });

  function createNonce() {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function consSanitizeHtmlFragment(unsafeHtml, documentObject = globalThis.document) {
    if (!documentObject?.createElement || !documentObject?.createDocumentFragment) {
      throw new Error("Для безопасного HTML-экспорта требуется DOMParser/offscreen document");
    }

    const source = String(unsafeHtml ?? "");
    if (source.length > safeHtmlLimits.maxSourceBytes) {
      throw new Error("HTML-документ превышает безопасный лимит 16 МБ");
    }
    const sourceBytes = new TextEncoder().encode(source).byteLength;
    if (sourceBytes > safeHtmlLimits.maxSourceBytes) {
      throw new Error("HTML-документ превышает безопасный лимит 16 МБ");
    }

    const allowedTags = new Set(safeHtmlPolicy.allowedTags);
    const dropWithChildren = new Set(safeHtmlPolicy.dropWithChildren);
    const commonAttributes = new Set(safeHtmlPolicy.commonAttributes);
    const attributesByTag = Object.fromEntries(
      Object.entries(safeHtmlPolicy.attributesByTag).map(([tag, names]) => [
        tag,
        new Set(names),
      ])
    );
    const numericAttributes = new Set(safeHtmlPolicy.numericAttributes);
    const allowedImageMediaTypes = new Set(safeHtmlPolicy.imageSource.mediaTypes);
    const noAttributes = new Set();
    let visitedNodes = 0;

    function isAllowedImageSource(value) {
      const comma = value.indexOf(",");
      if (comma < 0) return false;

      const metadata = value.slice(0, comma);
      const payload = value.slice(comma + 1);
      const prefix = `${safeHtmlPolicy.imageSource.scheme}:`;
      if (!metadata.toLowerCase().startsWith(prefix)) return false;

      const parts = metadata.slice(prefix.length).split(";");
      if (parts.length !== 2) return false;
      if (!allowedImageMediaTypes.has(parts[0].toLowerCase())) return false;
      if (parts[1].toLowerCase() !== safeHtmlPolicy.imageSource.encoding) return false;
      if (!payload || payload.length % 4 !== 0) return false;
      if (payload.length > safeHtmlLimits.maxImagePayloadChars) return false;
      return /^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i.test(
        payload
      );
    }

    function copySafeNode(node) {
      visitedNodes += 1;
      if (visitedNodes > safeHtmlLimits.maxNodes) {
        throw new Error("HTML-документ содержит слишком много DOM-узлов");
      }

      if (node.nodeType === 3) {
        return documentObject.createTextNode(node.data);
      }
      if (node.nodeType !== 1) {
        return documentObject.createDocumentFragment();
      }

      const tag = node.tagName.toUpperCase();
      if (dropWithChildren.has(tag)) {
        return documentObject.createDocumentFragment();
      }

      if (!allowedTags.has(tag)) {
        const fragment = documentObject.createDocumentFragment();
        for (const child of node.childNodes) fragment.append(copySafeNode(child));
        return fragment;
      }

      const clean = documentObject.createElement(tag.toLowerCase());
      const tagAttributes = attributesByTag[tag] || noAttributes;
      for (const attribute of node.attributes) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value;
        if (!commonAttributes.has(name) && !tagAttributes.has(name)) continue;
        if (/^on/i.test(name) || name === "style" || name === "id" || name === "name") {
          continue;
        }
        if (name === "dir" && !/^(?:ltr|rtl|auto)$/i.test(value)) continue;
        if (name === "lang" && !/^[a-z0-9-]{1,35}$/i.test(value)) continue;
        if (numericAttributes.has(name) && !/^\d{1,4}$/.test(value)) continue;
        if (name === "type" && !/^(?:1|a|A|i|I)$/.test(value)) continue;
        if (name === "scope" && !/^(?:row|col|rowgroup|colgroup)$/i.test(value)) {
          continue;
        }
        if (name === "src" && !isAllowedImageSource(value)) continue;
        clean.setAttribute(name, value);
      }

      for (const child of node.childNodes) clean.append(copySafeNode(child));
      return clean;
    }

    const inertTemplate = documentObject.createElement("template");
    inertTemplate.innerHTML = source;
    const target = documentObject.createElement("div");
    for (const child of inertTemplate.content.childNodes) target.append(copySafeNode(child));
    return target.innerHTML;
  }

  function consBuildSafeHtmlDocument(
    title,
    unsafeHtml,
    canonicalUrl,
    documentObject = globalThis.document
  ) {
    const nonce = createNonce();
    const sanitizedHtml = consSanitizeHtmlFragment(unsafeHtml, documentObject);
    const csp = [
      "default-src 'none'",
      `style-src 'nonce-${nonce}'`,
      "img-src data:",
      "connect-src 'none'",
      "media-src 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; ");

    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(
      csp
    )}"><meta name="referrer" content="no-referrer"><title>${escapeHtmlAttribute(
      title || "document"
    )}</title><style nonce="${nonce}">body{margin:2rem auto;max-width:72rem;padding:0 1.25rem;color:#111;font:16px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}table{border-collapse:collapse;max-width:100%}th,td{border:1px solid #bbb;padding:.35rem .5rem;vertical-align:top}pre{overflow:auto;white-space:pre-wrap}img{max-width:100%;height:auto}.cons-export-source{color:#555;font-size:.875rem;margin-bottom:1.5rem}</style></head><body><p class="cons-export-source">Источник: ${escapeHtmlAttribute(
      canonicalUrl || "не указан"
    )}</p><main id="cons-export-content">${sanitizedHtml}</main></body></html>`;
  }

  globalThis.consBuildSafeHtmlDocument = consBuildSafeHtmlDocument;
  globalThis.consSanitizeHtmlFragment = consSanitizeHtmlFragment;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      consBuildSafeHtmlDocument,
      consSanitizeHtmlFragment,
      safeHtmlLimits,
      safeHtmlPolicy,
    };
  }
})();
