/** Deterministic filename/folder templates and internal collision resolution. */
(function () {
  const filenameApi =
    typeof module !== "undefined" && module.exports
      ? require("./filename.js")
      : globalThis;
  const profileApi =
    typeof module !== "undefined" && module.exports
      ? require("./profile-storage.js")
      : globalThis;

  const CONS_TEMPLATE_TOKENS = Object.freeze([
    "index",
    "title",
    "query",
    "instance",
    "date",
    "court",
    "case",
    "documentType",
    "format",
  ]);
  const TOKEN_SET = new Set(CONS_TEMPLATE_TOKENS);
  const SEPARATOR_EDGE = /^[\s._,;:\-–—]+|[\s._,;:\-–—]+$/gu;
  const KNOWN_EXTENSION = /\.(?:docx|pdf|rtf|txt|html)$/iu;

  function unique(values) {
    return [...new Set(values)];
  }

  function tokenValue(context, token) {
    if (token === "index") {
      const index = Math.max(1, Number(context.index) || 1);
      const total = Math.max(index, Number(context.total) || index);
      return String(index).padStart(Math.max(2, String(total).length), "0");
    }
    const direct = context[token];
    const value = direct && typeof direct === "object" && "value" in direct
      ? direct.value
      : direct;
    if (value === null || value === undefined) return "";
    return String(value).normalize("NFKC").trim();
  }

  function consValidateTemplate(template, kind = "filename") {
    const value = String(template || "").trim();
    const errors = [];
    if (!value) {
      errors.push({ code: "EMPTY_TEMPLATE", message: "Шаблон не может быть пустым" });
      return { ok: false, errors, tokens: [] };
    }
    const tokens = [];
    for (const match of value.matchAll(/\{([^{}]+)\}/gu)) tokens.push(match[1]);
    const withoutTokens = value.replace(/\{[^{}]+\}/gu, "");
    if (/[{}]/u.test(withoutTokens)) {
      errors.push({ code: "MALFORMED_TOKEN", message: "Незакрытый токен в шаблоне" });
    }
    for (const token of unique(tokens)) {
      if (!TOKEN_SET.has(token)) {
        errors.push({
          code: "UNKNOWN_TOKEN",
          token,
          message: `Неизвестный токен {${token}}`,
        });
      }
    }
    if (kind === "folder") {
      if (/^[\\/]/u.test(value) || /^[a-z]:/iu.test(value) || /^\\\\/u.test(value)) {
        errors.push({ code: "ABSOLUTE_PATH", message: "Разрешён только относительный путь" });
      }
      if (/(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value)) {
        errors.push({ code: "PATH_TRAVERSAL", message: "Сегмент .. запрещён" });
      }
      if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
        errors.push({ code: "URL_PATH", message: "URL нельзя использовать как папку" });
      }
    }
    return { ok: errors.length === 0, errors, tokens: unique(tokens) };
  }

  function renderTemplate(template, context, options = {}) {
    const missingTokens = [];
    const value = String(template || "").replace(/\{([^{}]+)\}/gu, (_match, token) => {
      const raw = tokenValue(context, token);
      if (!raw) {
        missingTokens.push(token);
        return "";
      }
      return options.sanitizeToken ? options.sanitizeToken(raw) : raw;
    });
    return { value, missingTokens: unique(missingTokens) };
  }

  function cleanupSeparators(raw) {
    let value = String(raw || "").replace(/\s+/gu, " ").trim();
    value = value
      .replace(/_{2,}/gu, "_")
      .replace(/\.{2,}/gu, ".")
      .replace(/(?:\s*[-–—]\s*){2,}/gu, " - ")
      .replace(/([._,;:])(?:\s*[._,;:])+/gu, "$1")
      .replace(SEPARATOR_EDGE, "")
      .replace(/\s+/gu, " ")
      .trim();
    return value;
  }

  function missingWarnings(tokens) {
    return tokens.map((token) => ({
      code: "MISSING_TOKEN_VALUE",
      token,
      message: `Нет значения для {${token}}; компонент удалён`,
    }));
  }

  function filenameCleanupRules(raw, cleaned, sanitized) {
    const rules = [];
    if (String(raw || "").normalize("NFKC") !== String(raw || "")) {
      rules.push("unicode-normalized");
    }
    if (/\s{2,}/u.test(String(raw || "")) || cleaned !== String(raw || "").trim()) {
      rules.push("separators-collapsed");
    }
    if (/[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(String(cleaned || ""))) {
      rules.push("invalid-characters-replaced");
    }
    if (sanitized.startsWith("_") && !String(cleaned || "").startsWith("_")) {
      rules.push("windows-reserved-name-prefixed");
    }
    if (sanitized.length < cleaned.length) rules.push("length-truncated");
    return rules;
  }

  function consRenderFilenameTemplate(template, context = {}, format = "txt") {
    const validation = consValidateTemplate(template, "filename");
    if (!validation.ok) {
      return { ok: false, errors: validation.errors, warnings: [], missingTokens: [] };
    }
    const safeFormat = filenameApi.consSafeExtension(format);
    const rendered = renderTemplate(template, { ...context, format: safeFormat });
    let raw = rendered.value;
    const cleanupRulesApplied = [];
    if (KNOWN_EXTENSION.test(raw.trim())) {
      raw = raw.trim().replace(KNOWN_EXTENSION, "");
      cleanupRulesApplied.push("manual-extension-removed");
    }
    let cleaned = cleanupSeparators(raw);
    let fallbackUsed = false;
    if (!/[\p{L}\p{N}]/u.test(cleaned)) {
      fallbackUsed = true;
      const fallback = renderTemplate(
        profileApi.CONS_DEFAULT_FILENAME_TEMPLATE || "{index} - {title}",
        { ...context, format: safeFormat }
      );
      cleaned = cleanupSeparators(fallback.value) || tokenValue(context, "index") || "document";
      cleanupRulesApplied.push("fallback-template");
    }
    let stem = filenameApi.consSanitizeFilenameStem(cleaned, {
      fallback: "document",
      maximumCharacters: 100,
      replacement: " ",
    });
    cleanupRulesApplied.push(...filenameCleanupRules(raw, cleaned, stem));
    const maximumStemBytes = Math.max(1, 240 - safeFormat.length - 1);
    if (filenameApi.consUtf8Length(stem) > maximumStemBytes) {
      stem = filenameApi.consTruncateUtf8(stem, maximumStemBytes).replace(/[. ]+$/gu, "");
      cleanupRulesApplied.push("utf8-length-truncated");
    }
    return {
      ok: true,
      filename: `${stem}.${safeFormat}`,
      stem,
      warnings: missingWarnings(rendered.missingTokens),
      missingTokens: rendered.missingTokens,
      cleanupRulesApplied: unique([
        ...cleanupRulesApplied,
        ...(rendered.missingTokens.length ? ["missing-token-components-removed"] : []),
      ]),
      fallbackUsed,
      errors: [],
    };
  }

  function consRenderFolderTemplate(template, context = {}) {
    const validation = consValidateTemplate(template, "folder");
    if (!validation.ok) {
      return { ok: false, errors: validation.errors, warnings: [], missingTokens: [] };
    }
    const cleanupRulesApplied = [];
    const rendered = renderTemplate(template, context, {
      sanitizeToken(value) {
        const sanitized = filenameApi.consSanitizePathSegment(value);
        if (sanitized !== value) cleanupRulesApplied.push("token-path-syntax-replaced");
        return sanitized;
      },
    });
    const rawSegments = rendered.value.replace(/\\/gu, "/").split("/");
    const segments = [];
    for (const rawSegment of rawSegments) {
      const cleaned = cleanupSeparators(rawSegment);
      if (!cleaned) {
        if (rawSegment) cleanupRulesApplied.push("empty-folder-segment-removed");
        continue;
      }
      const sanitized = filenameApi.consSanitizePathSegment(cleaned);
      if (!sanitized) continue;
      if (sanitized !== cleaned) cleanupRulesApplied.push("folder-segment-sanitized");
      segments.push(sanitized);
    }
    if (segments.length > 5) {
      return {
        ok: false,
        errors: [{ code: "FOLDER_SEGMENT_LIMIT", message: "Допустимо не более 5 папок" }],
        warnings: missingWarnings(rendered.missingTokens),
        missingTokens: rendered.missingTokens,
      };
    }
    const folder = segments.join("/") || runtimeFolderFallback();
    if (!segments.length) cleanupRulesApplied.push("folder-fallback");
    const warnings = missingWarnings(rendered.missingTokens);
    if (filenameApi.consUtf8Length(folder) > 220) {
      warnings.push({
        code: "LONG_RELATIVE_PATH",
        message: "Относительный путь папки длиннее 220 байт",
      });
    }
    return {
      ok: true,
      folder,
      segments,
      warnings,
      missingTokens: rendered.missingTokens,
      cleanupRulesApplied: unique([
        ...cleanupRulesApplied,
        ...(rendered.missingTokens.length ? ["missing-token-components-removed"] : []),
      ]),
      errors: [],
    };
  }

  function runtimeFolderFallback() {
    return globalThis.CONS_DEFAULT_DOWNLOAD_FOLDER || "LexPack";
  }

  function splitFilename(filename) {
    const match = String(filename || "").match(/^(.*?)(\.[^.]+)?$/u);
    return { stem: match?.[1] || "document", extension: match?.[2] || "" };
  }

  function collisionKey(folder, filename) {
    return `${String(folder || "").normalize("NFKC").toLowerCase()}/${String(
      filename || ""
    ).normalize("NFKC").toLowerCase()}`;
  }

  function consResolvePathCollisions(items) {
    const used = new Set();
    return (Array.isArray(items) ? items : []).map((item) => {
      const folder = String(item.plannedRelativeFolder || "");
      const requested = String(item.plannedFilename || "document.txt");
      let filename = requested;
      let suffix = 1;
      while (used.has(collisionKey(folder, filename))) {
        suffix += 1;
        const { stem, extension } = splitFilename(requested);
        const suffixText = ` (${suffix})`;
        const maximumStemBytes = Math.max(
          1,
          240 - filenameApi.consUtf8Length(extension) - filenameApi.consUtf8Length(suffixText)
        );
        const shortened = filenameApi.consTruncateUtf8(stem, maximumStemBytes).replace(/[. ]+$/gu, "");
        filename = `${shortened || "document"}${suffixText}${extension}`;
      }
      used.add(collisionKey(folder, filename));
      return {
        ...item,
        plannedFilename: filename,
        plannedRelativePath: folder ? `${folder}/${filename}` : filename,
        expectedFilename: filename,
        collisionResolution: suffix === 1
          ? { type: "none", internal: false, external: false }
          : {
              type: "ordered-suffix",
              internal: true,
              external: false,
              originalFilename: requested,
              suffix,
            },
      };
    });
  }

  const api = {
    CONS_TEMPLATE_TOKENS,
    consRenderFilenameTemplate,
    consRenderFolderTemplate,
    consResolvePathCollisions,
    consValidateTemplate,
  };
  Object.assign(globalThis, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
