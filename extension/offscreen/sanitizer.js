const blobUrls = new Set();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") {
    return false;
  }

  try {
    if (message.type === "SANITIZE_HTML") {
      const html = consBuildSafeHtmlDocument(
        message.title,
        message.html,
        message.canonicalUrl,
        document
      );
      sendResponse({ ok: true, html });
      return false;
    }

    if (message.type === "CREATE_BLOB_URL") {
      const mime = String(message.mime || "application/octet-stream");
      if (!/^(?:text\/(?:plain|html)|application\/json)(?:;charset=utf-8)?$/i.test(mime)) {
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
  for (const url of blobUrls) URL.revokeObjectURL(url);
  blobUrls.clear();
});
