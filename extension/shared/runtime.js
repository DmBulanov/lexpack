/** Shared runtime contracts for popup, content scripts, and the service worker. */
(function () {
  const CONS_DOWNLOAD_DIAGNOSTIC_CODES = Object.freeze([
    "NM_CONTEXT",
    "NM_TIME",
    "NM_ORIGIN",
    "NM_EXTENSION",
    "NM_REFERRER",
    "NM_URL",
    "NM_DOCUMENT",
    "NM_BASE",
    "NM_ID_MISSING",
    "NM_ID_MISMATCH",
    "NM_OWNER",
    "NM_TIMEOUT",
    "NM_AMBIGUOUS",
    "NM_ATTACHED",
    "NM_RECOVERED",
    "DG_ARMED",
    "DG_PENDING",
    "DG_CANCEL_EXISTING",
    "DG_CANCEL_LATE",
    "DG_ALREADY_TERMINAL",
    "DG_CANCEL_FAILED",
    "DG_SCAN_FAILED",
    "DG_EXPIRED",
  ]);
  const DOWNLOAD_DIAGNOSTIC_CODE_SET = new Set(CONS_DOWNLOAD_DIAGNOSTIC_CODES);
  const SAFE_PROBE_KEYS = Object.freeze([
    "hostname",
    "page",
    "listCount",
    "hasFullTextButton",
    "hasWord",
    "hasDots",
    "hasNext",
    "hasDocPane",
    "docTextLen",
  ]);

  const CONS_FORMATS = Object.freeze(["docx", "pdf", "rtf", "txt", "html"]);
  const CONS_JUDICIAL_INSTANCES = Object.freeze([
    "higher-courts",
    "arbitration-circuit",
    "arbitration-first",
    "arbitration-rulings",
  ]);
  const CONS_JUDICIAL_INSTANCE_LABELS = Object.freeze({
    "higher-courts": "Решения высших судов",
    "arbitration-circuit": "Арбитражные суды округов",
    "arbitration-first": "Арбитражные суды первой инстанции",
    "arbitration-rulings": "Определения арбитражных судов",
  });
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

  function normalizedSearchQuery(query) {
    const value = String(query || "").trim();
    if (!value) throw new Error("Пустой поисковый запрос");
    if (value.length > 2000) throw new Error("Поисковый запрос превышает 2000 символов");
    return value;
  }

  function consBuildOnlineSearchUrl(currentUrl, query) {
    const value = normalizedSearchQuery(query);
    let current;
    try {
      current = new URL(currentUrl);
    } catch {
      throw new Error("Некорректный URL КонсультантПлюс");
    }
    if (
      current.protocol !== "https:" ||
      !consIsConsultantHost(current.hostname) ||
      current.hostname === "consultant.ru" ||
      current.hostname === "www.consultant.ru" ||
      current.hostname === "login.consultant.ru" ||
      current.username ||
      current.password
    ) {
      throw new Error("Требуется HTTPS-страница онлайн-КонсультантПлюс");
    }

    const pathname = /online\.cgi$/i.test(current.pathname)
      ? current.pathname
      : "/riv/cgi/online.cgi";
    const result = new URL(pathname, current.origin);
    result.searchParams.set("req", "card");
    result.searchParams.set("page", "splus");
    result.searchParams.set("splusFind", value);
    const rnd = current.searchParams.get("rnd");
    if (rnd) result.searchParams.set("rnd", rnd.slice(0, 200));
    result.hash = "splus";
    return result.href;
  }

  function consBuildPublicSearchUrl(query) {
    const result = new URL("https://www.consultant.ru/search/");
    result.searchParams.set("q", normalizedSearchQuery(query));
    return result.href;
  }

  function consNormalizeJudicialInstances(value) {
    const source = Array.isArray(value) ? value : [];
    const allowed = new Set(CONS_JUDICIAL_INSTANCES);
    return [...new Set(source.map((entry) => String(entry || "")).filter((entry) => allowed.has(entry)))];
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

  function nativeDecision(match, candidate, code) {
    return { match, candidate, code };
  }

  function consNativeDownloadDecision(item, current) {
    if (!item || current?.downloadKind !== "native") {
      return nativeDecision(false, false, "NM_CONTEXT");
    }

    const startedAt = Date.parse(item.startTime || "");
    const triggerAt = Number(current.downloadStartedAt || 0);
    if (
      !Number.isFinite(startedAt) ||
      !Number.isFinite(triggerAt) ||
      startedAt < triggerAt - 2000 ||
      startedAt > triggerAt + 30000
    ) {
      return nativeDecision(false, false, "NM_TIME");
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
    if (!consultantOrigin) return nativeDecision(false, false, "NM_ORIGIN");

    const expectedExtension = String(current.expectedFilename || "")
      .toLowerCase()
      .match(/\.([a-z0-9]+)$/)?.[1];
    const actualExtension = String(item.filename || "")
      .toLowerCase()
      .match(/\.([a-z0-9]+)$/)?.[1];
    if (!expectedExtension || actualExtension !== expectedExtension) {
      return nativeDecision(false, false, "NM_EXTENSION");
    }

    if (!item.referrer) return nativeDecision(false, true, "NM_REFERRER");
    if (!current.sourceUrl) return nativeDecision(false, true, "NM_URL");
    try {
      const referrer = new URL(item.referrer);
      const source = new URL(current.sourceUrl);
      if (
        referrer.protocol !== "https:" ||
        source.protocol !== "https:" ||
        !consIsConsultantHost(referrer.hostname) ||
        !consIsConsultantHost(source.hostname)
      ) {
        return nativeDecision(false, true, "NM_URL");
      }

      const referrerIsDocument =
        referrer.searchParams.get("req")?.toLowerCase() === "doc" ||
        referrer.pathname.startsWith("/document/");
      const sourceIsDocument =
        source.searchParams.get("req")?.toLowerCase() === "doc" ||
        source.pathname.startsWith("/document/");
      if (!referrerIsDocument || !sourceIsDocument) {
        return nativeDecision(false, true, "NM_DOCUMENT");
      }

      const sourceBase = source.searchParams.get("base");
      if (sourceBase && referrer.searchParams.get("base") !== sourceBase) {
        return nativeDecision(false, true, "NM_BASE");
      }

      let strongIdentifiers = 0;
      for (const key of ["n", "doc", "id"]) {
        const sourceValue = source.searchParams.get(key);
        if (!sourceValue) continue;
        const refValue = referrer.searchParams.get(key);
        if (!refValue || refValue !== sourceValue) {
          return nativeDecision(false, true, "NM_ID_MISMATCH");
        }
        strongIdentifiers += 1;
      }
      if (strongIdentifiers === 0) {
        return nativeDecision(false, true, "NM_ID_MISSING");
      }
      if (
        current.extensionId &&
        item.byExtensionId &&
        item.byExtensionId !== current.extensionId
      ) {
        return nativeDecision(false, true, "NM_OWNER");
      }
    } catch {
      return nativeDecision(false, true, "NM_URL");
    }

    return nativeDecision(true, true, "NM_OK");
  }

  function consMatchesNativeDownload(item, current) {
    return consNativeDownloadDecision(item, current).match;
  }

  function consSanitizeDownloadDiagnostics(events) {
    return (Array.isArray(events) ? events : [])
      .filter(
        (event) =>
          event &&
          DOWNLOAD_DIAGNOSTIC_CODE_SET.has(event.code) &&
          ["0", "1", "many"].includes(event.countBucket) &&
          Number.isFinite(Date.parse(event.at || ""))
      )
      .slice(-32)
      .map((event) => ({
        at: new Date(event.at).toISOString(),
        code: event.code,
        countBucket: event.countBucket,
      }));
  }

  function consSanitizePageProbe(probe) {
    const source = probe && typeof probe === "object" ? probe : {};
    return Object.fromEntries(
      SAFE_PROBE_KEYS.filter((key) => key in source).map((key) => [key, source[key]])
    );
  }

  function consBuildSafeDiagnosticsSnapshot(probe, events) {
    return {
      page: consSanitizePageProbe(probe),
      downloads: consSanitizeDownloadDiagnostics(events),
    };
  }

  const api = {
    CONS_DOWNLOAD_DIAGNOSTIC_CODES,
    CONS_ADAPTER_CAPABILITIES,
    CONS_FORMATS,
    CONS_JUDICIAL_INSTANCES,
    CONS_JUDICIAL_INSTANCE_LABELS,
    consAssertFormatSupported,
    consBuildOnlineSearchUrl,
    consBuildPublicSearchUrl,
    consNormalizeJudicialInstances,
    consGetAdapterCapabilities,
    consIsConsultantHost,
    consIsConsultantPageUrl,
    consMatchesNativeDownload,
    consNativeDownloadDecision,
    consNormalizeDocumentUrl,
    consProvenanceUrl,
    consRedactUrl,
    consBuildSafeDiagnosticsSnapshot,
    consSanitizeDownloadDiagnostics,
    consSanitizePageProbe,
    consSanitizeFolder,
  };
  Object.assign(globalThis, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
