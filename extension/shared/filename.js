/** Shared Windows/macOS-safe filename and path primitives. */
(function () {
  const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

  function consUtf8Length(value) {
    return new TextEncoder().encode(String(value || "")).byteLength;
  }

  function consTruncateUtf8(value, maximumBytes) {
    const limit = Math.max(0, Number(maximumBytes) || 0);
    let result = "";
    let size = 0;
    for (const character of String(value || "")) {
      const characterSize = consUtf8Length(character);
      if (size + characterSize > limit) break;
      result += character;
      size += characterSize;
    }
    return result;
  }

  function consSafeExtension(ext, fallback = "txt") {
    return (
      String(ext || fallback)
        .toLowerCase()
        .replace(/^\./, "")
        .replace(/[^a-z0-9]/g, "") || fallback
    ).slice(0, 8);
  }

  function consSafeDownloadFilename(rawFilename, fallbackExtension = "txt") {
    const normalizedInput = String(rawFilename || "")
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim();
    const normalized = normalizedInput
      .replace(/\\/gu, "/")
      .split("/")
      .filter((segment) => segment && segment !== "." && segment !== "..")
      .pop() || "document";
    const extensionMatch = normalized.match(/\.([a-z0-9]{1,8})$/iu);
    const extension = consSafeExtension(extensionMatch?.[1], fallbackExtension);
    const rawStem = extensionMatch
      ? normalized.slice(0, -extensionMatch[0].length)
      : normalized;
    let stem = consSanitizeFilenameStem(rawStem, {
      fallback: "document",
      maximumCharacters: 240,
      replacement: " ",
    });
    const maximumStemBytes = Math.max(1, 240 - consUtf8Length(extension) - 1);
    if (consUtf8Length(stem) > maximumStemBytes) {
      stem = consTruncateUtf8(stem, maximumStemBytes).replace(/[. ]+$/gu, "");
    }
    return `${stem || "document"}.${extension}`;
  }

  function consSanitizeFilenameStem(rawValue, options = {}) {
    const fallback = String(options.fallback || "document");
    const maximumCharacters = Math.max(1, Number(options.maximumCharacters) || 100);
    const replacement = options.replacement === "_" ? "_" : " ";
    let value = String(rawValue || fallback)
      .normalize("NFKC")
      .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, replacement)
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/g, "")
      .slice(0, maximumCharacters);
    if (!value || value === "." || value === "..") value = fallback;
    if (WINDOWS_RESERVED_NAME.test(value)) value = `_${value}`;
    return value;
  }

  function consSanitizePathSegment(rawValue, options = {}) {
    const maximumCharacters = Math.max(1, Number(options.maximumCharacters) || 80);
    let value = String(rawValue || "")
      .normalize("NFKC")
      .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/g, "")
      .slice(0, maximumCharacters);
    if (!value || value === "." || value === "..") return "";
    if (WINDOWS_RESERVED_NAME.test(value)) value = `_${value}`;
    return value;
  }

  function consSafeFilename(title, index, ext) {
    const name = consSanitizeFilenameStem(title, {
      fallback: "document",
      maximumCharacters: 100,
      replacement: " ",
    });
    const safeExt = consSafeExtension(ext);
    const parsedIndex = Number(index);
    const num = Number.isInteger(parsedIndex) && parsedIndex >= 0
      ? `${String(parsedIndex).padStart(2, "0")} - `
      : "";
    return `${num}${name}.${safeExt}`;
  }

  const api = {
    consSafeDownloadFilename,
    consSafeExtension,
    consSafeFilename,
    consSanitizeFilenameStem,
    consSanitizePathSegment,
    consTruncateUtf8,
    consUtf8Length,
  };
  Object.assign(globalThis, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
