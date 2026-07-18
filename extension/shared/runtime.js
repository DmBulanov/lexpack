/** Shared runtime contracts for popup, content scripts, and the service worker. */
(function () {
  const CONS_FORMATS = Object.freeze(["docx", "pdf", "rtf", "txt", "html"]);
  const CONS_ADAPTER_CAPABILITIES = Object.freeze({
    "online-app": Object.freeze({
      search: true,
      scopes: Object.freeze(["practice", "all"]),
      exportFormats: CONS_FORMATS,
      nativeFormats: Object.freeze(["docx", "pdf", "rtf"]),
    }),
    "public-site": Object.freeze({
      search: true,
      scopes: Object.freeze(["all"]),
      exportFormats: Object.freeze(["txt", "html"]),
      nativeFormats: Object.freeze([]),
    }),
  });

  function consIsConsultantHost(hostname) {
    const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
    return host === "consultant.ru" || host.endsWith(".consultant.ru");
  }

  function consIsConsultantPageUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      return url.protocol === "https:" && consIsConsultantHost(url.hostname);
    } catch {
      return false;
    }
  }

  function consNormalizeDocumentUrl(rawUrl, adapterId) {
    const value = String(rawUrl || "").trim();
    if (!value || value.length > 4096) throw new Error("Некорректный URL документа");

    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Некорректный URL документа");
    }
    if (url.protocol !== "https:" || !consIsConsultantHost(url.hostname)) {
      throw new Error("Разрешены только HTTPS-ссылки КонсультантПлюс");
    }
    if (url.username || url.password) {
      throw new Error("URL документа не должен содержать учётные данные");
    }

    if (adapterId === "public-site") {
      const publicHost = url.hostname === "consultant.ru" || url.hostname === "www.consultant.ru";
      if (!publicHost || !url.pathname.startsWith("/document/")) {
        throw new Error("Публичная ссылка не ведёт на документ КонсультантПлюс");
      }
    } else if (adapterId === "online-app") {
      const isLoginHost = url.hostname === "login.consultant.ru";
      const isDocument =
        /(?:^|[?&])req=doc(?:&|$)/i.test(url.search) ||
        url.pathname.startsWith("/document/");
      if (isLoginHost || !isDocument) {
        throw new Error("Онлайн-ссылка не ведёт на документ КонсультантПлюс");
      }
    }

    return url.href;
  }

  function consGetAdapterCapabilities(adapterId) {
    const capabilities = CONS_ADAPTER_CAPABILITIES[adapterId];
    if (!capabilities) {
      return { search: false, scopes: [], exportFormats: [], nativeFormats: [] };
    }
    return capabilities;
  }

  function consAssertFormatSupported(adapterId, format) {
    const normalized = String(format || "").toLowerCase();
    if (!CONS_FORMATS.includes(normalized)) throw new Error(`Неизвестный формат: ${format}`);
    const capabilities = consGetAdapterCapabilities(adapterId);
    if (!capabilities.exportFormats.includes(normalized)) {
      throw new Error(`Формат ${normalized.toUpperCase()} недоступен для ${adapterId}`);
    }
    return normalized;
  }

  function consSanitizePathSegment(segment) {
    let value = String(segment || "")
      .replace(/[<>:"|?*\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "")
      .trim()
      .slice(0, 80);
    if (!value || value === "." || value === "..") return "";
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) value = `_${value}`;
    return value;
  }

  function consSanitizeFolder(rawFolder) {
    const segments = String(rawFolder || "ConsExport")
      .replace(/\\/g, "/")
      .split("/")
      .filter((segment) => segment && segment !== "." && segment !== "..")
      .map(consSanitizePathSegment)
      .filter(Boolean)
      .slice(0, 5);
    return segments.join("/") || "ConsExport";
  }

  function consProvenanceUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== "https:" || !consIsConsultantHost(url.hostname)) return "";
      url.username = "";
      url.password = "";
      url.hash = "";
      const allowedOnlineParameters = new Set(["req", "base", "n", "doc", "id"]);
      const onlineDocument =
        url.hostname !== "consultant.ru" && url.hostname !== "www.consultant.ru";
      for (const key of [...url.searchParams.keys()]) {
        if (!onlineDocument || !allowedOnlineParameters.has(key.toLowerCase())) {
          url.searchParams.delete(key);
        }
      }
      return url.href;
    } catch {
      return "";
    }
  }

  const consRedactUrl = consProvenanceUrl;

  function consMatchesNativeDownload(item, current) {
    if (!item || current?.downloadKind !== "native") return false;

    const startedAt = Date.parse(item.startTime || "");
    const triggerAt = Number(current.downloadStartedAt || 0);
    if (
      !Number.isFinite(startedAt) ||
      !Number.isFinite(triggerAt) ||
      startedAt < triggerAt - 2000 ||
      startedAt > triggerAt + 30000
    ) {
      return false;
    }

    const consultantOrigin = [item.url, item.finalUrl, item.referrer].some((candidate) => {
      if (!candidate) return false;
      try {
        const url = new URL(candidate);
        return url.protocol === "https:" && consIsConsultantHost(url.hostname);
      } catch {
        return false;
      }
    });
    if (!consultantOrigin) return false;

    const expectedExtension = String(current.expectedFilename || "")
      .toLowerCase()
      .match(/\.([a-z0-9]+)$/)?.[1];
    const actualExtension = String(item.filename || "")
      .toLowerCase()
      .match(/\.([a-z0-9]+)$/)?.[1];
    if (!expectedExtension || actualExtension !== expectedExtension) return false;

    if (!item.referrer || !current.sourceUrl) return false;
    try {
      const referrer = new URL(item.referrer);
      const source = new URL(current.sourceUrl);
      if (
        referrer.protocol !== "https:" ||
        source.protocol !== "https:" ||
        !consIsConsultantHost(referrer.hostname) ||
        !consIsConsultantHost(source.hostname)
      ) {
        return false;
      }

      const referrerIsDocument =
        referrer.searchParams.get("req")?.toLowerCase() === "doc" ||
        referrer.pathname.startsWith("/document/");
      const sourceIsDocument =
        source.searchParams.get("req")?.toLowerCase() === "doc" ||
        source.pathname.startsWith("/document/");
      if (!referrerIsDocument || !sourceIsDocument) return false;

      const sourceBase = source.searchParams.get("base");
      if (sourceBase && referrer.searchParams.get("base") !== sourceBase) return false;

      let strongIdentifiers = 0;
      for (const key of ["n", "doc", "id"]) {
        const sourceValue = source.searchParams.get(key);
        if (!sourceValue) continue;
        const refValue = referrer.searchParams.get(key);
        if (!refValue || refValue !== sourceValue) return false;
        strongIdentifiers += 1;
      }
      if (strongIdentifiers === 0) return false;
      if (
        current.extensionId &&
        item.byExtensionId &&
        item.byExtensionId !== current.extensionId
      ) {
        return false;
      }
    } catch {
      return false;
    }

    return true;
  }

  const api = {
    CONS_ADAPTER_CAPABILITIES,
    CONS_FORMATS,
    consAssertFormatSupported,
    consGetAdapterCapabilities,
    consIsConsultantHost,
    consIsConsultantPageUrl,
    consMatchesNativeDownload,
    consNormalizeDocumentUrl,
    consProvenanceUrl,
    consRedactUrl,
    consSanitizeFolder,
  };
  Object.assign(globalThis, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
