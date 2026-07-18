/**
 * Content-script router: pick adapter for current page and answer messages.
 */
(function () {
  if (globalThis.__consExportContentInstalled) return;
  globalThis.__consExportContentInstalled = true;

  function pickAdapter() {
    const adapters = globalThis.ConsAdapters || {};
    const online = adapters.onlineApp;
    const pub = adapters.publicSite;
    const url = location.href;

    // Online first when it clearly matches a client shell.
    if (online && online.matches(url)) return online;
    if (pub && pub.matches(url)) return pub;
    return null;
  }

  function getCapabilities(adapter, page) {
    if (typeof adapter.getCapabilities === "function") {
      return adapter.getCapabilities(page);
    }
    return adapter.capabilities || {};
  }

  function errorResponse(code, error) {
    return { ok: false, code, error };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const run = async () => {
      const adapter = pickAdapter();
      if (!adapter) {
        return errorResponse(
          "UNSUPPORTED_PAGE",
          "Эта страница КонсультантПлюс не поддерживается расширением"
        );
      }

      const page = adapter.detectPage();
      const capabilities = getCapabilities(adapter, page);

      switch (msg.type) {
        case "PING":
          return {
            ok: true,
            adapter: adapter.id,
            page,
            capabilities,
            authRequired: page === "auth-required",
            url: location.href,
            title: document.title,
          };

        case "COLLECT_LIST": {
          if (!capabilities.collectList) {
            const message =
              page === "auth-required"
                ? "Сначала войдите в онлайн-КонсультантПлюс"
                : "На этой странице нет списка документов";
            return errorResponse(
              page === "auth-required" ? "AUTH_REQUIRED" : "UNSUPPORTED_PAGE",
              message
            );
          }
          const items = adapter.collectListItems();
          return {
            ok: true,
            adapter: adapter.id,
            page,
            capabilities,
            items,
            count: items.length,
          };
        }

        case "EXTRACT_DOCUMENT": {
          if (!capabilities.extractDocument) {
            const message =
              page === "auth-required"
                ? "Сначала войдите в онлайн-КонсультантПлюс"
                : "Откройте документ перед сохранением";
            return errorResponse(
              page === "auth-required" ? "AUTH_REQUIRED" : "UNSUPPORTED_PAGE",
              message
            );
          }
          const doc = await adapter.extractCurrentDocument({
            format: msg.format || "docx",
          });
          return { ok: true, adapter: adapter.id, doc };
        }

        case "RUN_SEARCH": {
          if (!capabilities.search || typeof adapter.runSearch !== "function") {
            const message =
              page === "auth-required"
                ? "Сначала войдите в онлайн-КонсультантПлюс"
                : "Поиск недоступен на этой странице";
            return errorResponse(
              page === "auth-required" ? "AUTH_REQUIRED" : "UNSUPPORTED_PAGE",
              message
            );
          }
          const scope = msg.scope || "practice";
          if (
            Array.isArray(capabilities.searchScopes) &&
            !capabilities.searchScopes.includes(scope)
          ) {
            return errorResponse(
              "UNSUPPORTED_SCOPE",
              `Область «${scope}» недоступна для адаптера ${adapter.id}`
            );
          }
          const result = await adapter.runSearch(msg.query, {
            scope,
          });
          return { ok: true, adapter: adapter.id, ...result };
        }

        case "PROBE": {
          if (typeof adapter.probe !== "function") {
            return { ok: false, error: "Probe недоступен на этом адаптере" };
          }
          return { ok: true, probe: adapter.probe() };
        }

        default:
          return { ok: false, error: `Unknown message: ${msg.type}` };
      }
    };

    run()
      .then(sendResponse)
      .catch((e) =>
        sendResponse({
          ok: false,
          code: e?.code || "ADAPTER_ERROR",
          error: e?.message || String(e),
        })
      );
    return true; // async
  });
})();
