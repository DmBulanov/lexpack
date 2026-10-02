const blobUrls = new Set();
const mergedDocuments = new Map();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") {
    return false;
  }

  try {
    if (message.type === "BEGIN_MERGED_DOCUMENT") {
      if (!["docx-one", "md-one"].includes(message.format)) throw new Error("Неподдерживаемый единый формат");
      if (!mergedDocuments.has(message.jobId)) {
        mergedDocuments.clear();
        mergedDocuments.set(message.jobId, { format: message.format, parts: new Map() });
      }
      sendResponse({ ok: true, indexes: [...mergedDocuments.get(message.jobId).parts.keys()] });
      return false;
    }
    if (message.type === "ADD_MERGED_DOCUMENT") {
      const collection = mergedDocuments.get(message.jobId);
      if (!collection) throw new Error("Буфер единого документа потерян; повторите выгрузку");
      if (!Number.isInteger(message.index) || message.index < 0 || message.index >= 200) {
        throw new Error("Некорректный индекс документа");
      }
      const part = consMergedDocumentPart(message.doc);
      const size = new TextEncoder().encode(part.title + part.body).byteLength;
      let total = size;
      for (const [index, stored] of collection.parts) {
        if (index !== message.index) total += stored.size;
      }
      if (total > MAX_MERGED_BYTES) throw new Error("Единый документ превышает безопасный лимит 32 МБ");
      collection.parts.set(message.index, { ...part, size });
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "BUILD_MERGED_DOCUMENT") {
      const collection = mergedDocuments.get(message.jobId);
      if (!collection || collection.parts.size !== message.count) throw new Error("Единая подборка собрана не полностью");
      const parts = Array.from({ length: message.count }, (_, index) => collection.parts.get(index));
      if (parts.some((part) => !part)) throw new Error("В единой подборке отсутствует документ");
      const result = consBuildMergedDocument(parts, collection.format);
      const url = URL.createObjectURL(new Blob([result.data], { type: result.mime }));
      blobUrls.add(url);
      sendResponse({ ok: true, url });
      return false;
    }
    if (message.type === "SANITIZE_HTML") {
      const sourceHtml = consAssertSafeHtmlSourceSize(message.html);
      const contentRoot = document.createElement("div");
      contentRoot.innerHTML = sourceHtml;
      consCleanConsultantDocument(contentRoot);
      const cleanTitle = consRemoveConsultantMentions(message.title).text;
      const html = consBuildSafeHtmlDocument(
        cleanTitle,
        contentRoot.innerHTML,
        message.canonicalUrl,
        document
      );
      sendResponse({ ok: true, html });
      return false;
    }

    if (message.type === "CREATE_BLOB_URL") {
      const mime = String(message.mime || "application/octet-stream");
      if (
        !/^(?:(?:text\/(?:plain|html)|application\/json)(?:;charset=utf-8)?|text\/markdown; charset=utf-8)$/i.test(
          mime
        )
      ) {
        throw new Error("Неподдерживаемый MIME для локального файла");
      }
      const content = String(message.content ?? "");
      if (new TextEncoder().encode(content).byteLength > 32 * 1024 * 1024) {
        throw new Error("Файл превышает безопасный лимит 32 МБ");
      }
      const url = URL.createObjectURL(new Blob([content], { type: mime }));
      blobUrls.add(url);
      sendResponse({ ok: true, url });
      return false;
    }

    if (message.type === "REVOKE_BLOB_URL") {
      const url = String(message.url || "");
      if (blobUrls.delete(url)) URL.revokeObjectURL(url);
      sendResponse({ ok: true });
      return false;
    }

    sendResponse({ ok: false, error: `Unknown offscreen message: ${message.type}` });
  } catch (error) {
    sendResponse({ ok: false, error: String(error?.message || error) });
  }
  return false;
});

addEventListener("pagehide", () => {
  mergedDocuments.clear();
  for (const url of blobUrls) URL.revokeObjectURL(url);
  blobUrls.clear();
});
