/**
 * Main-world bridge that cleans only DOCX downloads explicitly armed by LexPack.
 * Loaded at document_start so the page cannot create the target Blob before the
 * object-URL hook exists.
 */
(function () {
  "use strict";

  const CHANNEL = "LEXPACK_DOCX_CLEANER_V1";
  const MAX_BLOB_BYTES = 64 * 1024 * 1024;
  const MAX_CANDIDATES = 16;
  const ARM_LIFETIME_MS = 45000;
  const DOCX_MIME =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  if (globalThis.__LEXPACK_DOCX_CLEANER_INSTALLED__) return;
  Object.defineProperty(globalThis, "__LEXPACK_DOCX_CLEANER_INSTALLED__", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
  const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
  const nativeAnchorClick = HTMLAnchorElement.prototype.click;
  const nativeDispatchEvent = EventTarget.prototype.dispatchEvent;
  const candidates = new Map();
  let armed = null;
  let processing = false;
  let bypass = false;

  function post(type, requestId, details = {}) {
    window.postMessage(
      {
        channel: CHANNEL,
        type,
        requestId,
        ...details,
      },
      location.origin
    );
  }

  function disarm(requestId = null) {
    if (!armed || (requestId && armed.requestId !== requestId)) return;
    armed = null;
    candidates.clear();
  }

  function expireArm() {
    if (!armed || armed.expiresAt > Date.now()) return false;
    const requestId = armed.requestId;
    disarm(requestId);
    post("ERROR", requestId, {
      error: "КонсультантПлюс не создал Word-файл за отведённое время",
    });
    return true;
  }

  function isCandidateBlob(value) {
    return (
      value instanceof Blob &&
      value.size > 0 &&
      value.size <= MAX_BLOB_BYTES
    );
  }

  function hrefFor(anchor) {
    return String(anchor?.href || anchor?.getAttribute?.("href") || "");
  }

  function looksLikeDocx(anchor, blob) {
    const filename = String(anchor?.download || "").toLowerCase();
    const href = hrefFor(anchor).toLowerCase();
    const mime = String(blob?.type || "").toLowerCase();
    return (
      filename.endsWith(".docx") ||
      href.endsWith(".docx") ||
      mime === DOCX_MIME ||
      mime.includes("wordprocessingml") ||
      mime === "application/zip" ||
      mime === "application/octet-stream"
    );
  }

  function candidateFor(anchor) {
    const href = hrefFor(anchor);
    return candidates.get(href) || candidates.get(anchor?.getAttribute?.("href")) || null;
  }

  async function cleanAndDownload(anchor, blob, requestId) {
    let cleanUrl = "";
    try {
      if (typeof globalThis.consSanitizeDocxArchive !== "function") {
        throw new Error("Модуль локальной очистки Word не загрузился");
      }
      const result = await globalThis.consSanitizeDocxArchive(await blob.arrayBuffer());
      const cleanBlob = new Blob([result.bytes], { type: DOCX_MIME });
      cleanUrl = nativeCreateObjectURL(cleanBlob);
      anchor.href = cleanUrl;
      if (!String(anchor.download || "").toLowerCase().endsWith(".docx")) {
        anchor.download = "document.docx";
      }
      bypass = true;
      try {
        nativeAnchorClick.call(anchor);
      } finally {
        bypass = false;
      }
      post("CLEANED", requestId, { stats: result.stats });
      setTimeout(() => nativeRevokeObjectURL(cleanUrl), 60000);
    } catch (error) {
      if (cleanUrl) nativeRevokeObjectURL(cleanUrl);
      post("ERROR", requestId, {
        error: String(error?.message || error || "Не удалось очистить Word-файл"),
      });
    } finally {
      processing = false;
      candidates.clear();
    }
  }

  function blockEvent(event) {
    event?.preventDefault?.();
    event?.stopImmediatePropagation?.();
    event?.stopPropagation?.();
  }

  function interceptAnchor(anchor, event = null) {
    if (bypass || processing || !armed || expireArm()) return false;
    const blob = candidateFor(anchor);
    const href = hrefFor(anchor);
    const targetLooksRelevant =
      Boolean(blob) ||
      href.startsWith("blob:") ||
      String(anchor?.download || "").toLowerCase().endsWith(".docx") ||
      href.toLowerCase().endsWith(".docx");
    if (!targetLooksRelevant || (blob && !looksLikeDocx(anchor, blob))) return false;

    const requestId = armed.requestId;
    blockEvent(event);
    armed = null;
    if (!blob) {
      candidates.clear();
      post("ERROR", requestId, {
        error: "Word-файл создаётся неподдерживаемым способом; исходный файл не сохранён",
      });
      return true;
    }
    processing = true;
    void cleanAndDownload(anchor, blob, requestId);
    return true;
  }

  URL.createObjectURL = function (value) {
    const url = nativeCreateObjectURL(value);
    if (armed && !expireArm() && isCandidateBlob(value)) {
      if (candidates.size >= MAX_CANDIDATES) {
        const oldest = candidates.keys().next().value;
        candidates.delete(oldest);
      }
      candidates.set(url, value);
    }
    return url;
  };

  HTMLAnchorElement.prototype.click = function () {
    if (interceptAnchor(this)) return undefined;
    return nativeAnchorClick.call(this);
  };

  HTMLAnchorElement.prototype.dispatchEvent = function (event) {
    if (event?.type === "click" && interceptAnchor(this, event)) {
      return false;
    }
    return nativeDispatchEvent.call(this, event);
  };

  addEventListener(
    "click",
    (event) => {
      if (bypass || !armed) return;
      const target = event.target instanceof Element ? event.target.closest("a") : null;
      if (target) interceptAnchor(target, event);
    },
    true
  );

  addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.channel !== CHANNEL || typeof message.requestId !== "string") return;
    if (message.type === "ARM") {
      if (processing) {
        post("ERROR", message.requestId, { error: "Предыдущий Word-файл ещё очищается" });
        return;
      }
      armed = {
        requestId: message.requestId,
        expiresAt: Date.now() + ARM_LIFETIME_MS,
      };
      candidates.clear();
      post("ARMED", message.requestId);
    } else if (message.type === "DISARM") {
      disarm(message.requestId);
    }
  });
})();
