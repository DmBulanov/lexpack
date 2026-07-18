/** Sanitize a document title into a safe Windows/macOS filename. */
function consSafeFilename(title, index, ext) {
  let name = String(title || "document")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 100);
  if (!name) name = "document";
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    name = `_${name}`;
  }
  const safeExt = String(ext || "txt")
    .toLowerCase()
    .replace(/^\./, "")
    .replace(/[^a-z0-9]/g, "") || "txt";
  const parsedIndex = Number(index);
  const num = Number.isInteger(parsedIndex) && parsedIndex >= 0
    ? `${String(parsedIndex).padStart(2, "0")} - `
    : "";
  return `${num}${name}.${safeExt}`;
}

if (typeof globalThis !== "undefined") {
  globalThis.consSafeFilename = consSafeFilename;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { consSafeFilename };
}
