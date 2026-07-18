/**
 * Adapter for the public site www.consultant.ru
 * (search results + document pages — no client login required).
 */
(function () {
  const CAPABILITIES = Object.freeze({
    search: true,
    searchScopes: Object.freeze(["all"]),
    collectList: true,
    extractDocument: true,
    exportFormats: Object.freeze(["txt", "html"]),
    nativeSave: false,
  });

  function isConsultantHost(hostname) {
    const host = String(hostname || "").toLowerCase();
    return host === "consultant.ru" || host.endsWith(".consultant.ru");
  }

  function unsupportedScope(scope) {
    const error = new Error(
      `Область «${scope}» недоступна на публичном consultant.ru; выберите «Всё по запросу»`
    );
    error.code = "UNSUPPORTED_SCOPE";
    return error;
  }

  const PublicSiteAdapter = {
    id: "public-site",

    capabilities: CAPABILITIES,

    getCapabilities(page = this.detectPage()) {
      return {
        ...CAPABILITIES,
        search: page !== "unsupported",
        searchReady: page !== "unsupported",
        resultsReady: page === "list",
        collectList: page === "list",
        extractDocument: page === "document",
        documentReady: page === "document",
      };
    },

    matches(url) {
      try {
        const u = new URL(url);
        if (!isConsultantHost(u.hostname)) return false;
        // Online client hosts are handled by online-app adapter.
        if (/^(login|online|client)\./i.test(u.hostname)) return false;
        return (
          u.pathname.startsWith("/search") ||
          u.pathname.startsWith("/document/") ||
          u.hostname === "www.consultant.ru" ||
          u.hostname === "consultant.ru"
        );
      } catch {
        return false;
      }
    },

    detectPage() {
      const path = location.pathname;
      if (path.startsWith("/search")) return "list";
      if (path.startsWith("/document/")) return "document";
      if (location.hostname === "consultant.ru" || location.hostname === "www.consultant.ru") {
        return "home";
      }
      return "unsupported";
    },

    /** Collect document links from a search-results page. */
    collectListItems() {
      const items = [];
      const seen = new Set();
      document
        .querySelectorAll("a.search-results__link[href*='/document/']")
        .forEach((a, i) => {
          const href = a.href;
          if (!href || seen.has(href)) return;
          seen.add(href);
          const title = a.innerText.replace(/^\d+\s*/, "").replace(/\s+/g, " ").trim();
          items.push({ index: i + 1, title, url: href });
        });
      return items;
    },

    /**
     * Public-site search: navigate to /search/?q=…
     */
    async runSearch(query, options = {}) {
      const q = String(query || "").trim();
      if (!q) throw new Error("Пустой запрос");
      const scope = options.scope || "all";
      if (!CAPABILITIES.searchScopes.includes(scope)) {
        throw unsupportedScope(scope);
      }

      const target = `https://www.consultant.ru/search/?q=${encodeURIComponent(q)}`;
      const current = new URL(location.href);
      const currentQuery = current.searchParams.get("q");
      const isCurrentQuery =
        current.pathname.startsWith("/search") && currentQuery != null && currentQuery.trim() === q;

      if (!isCurrentQuery) {
        location.assign(target);
        // Navigation will unload this document; caller should wait/re-query.
        return {
          query: q,
          scope: "all",
          scopeApplied: true,
          navigating: true,
          url: target,
          items: [],
          count: 0,
        };
      }
      const items = this.collectListItems();
      return {
        query: q,
        scope: "all",
        scopeApplied: true,
        items,
        count: items.length,
        url: location.href,
      };
    },

    /**
     * Expand "полный текст" if present, then extract title + body.
     * @returns {{ title: string, text: string, html: string }}
     */
    async extractCurrentDocument() {
      const fullBtn = document.querySelector(".full-text__button");
      if (fullBtn && /полный/i.test(fullBtn.textContent || "")) {
        fullBtn.click();
        await new Promise((r) => setTimeout(r, 800));
      }

      const title =
        document.querySelector("h1")?.innerText?.trim() ||
        document.querySelector(".document-page__title")?.innerText?.trim() ||
        document.title.replace(/\s*\\?\s*КонсультантПлюс.*$/i, "").trim();

      const root =
        document.querySelector(".document-page__main") ||
        document.querySelector(".content.document-page") ||
        document.querySelector("main") ||
        document.body;

      // Drop chrome: nav, search, promo
      const clone = root.cloneNode(true);
      clone
        .querySelectorAll(
          "nav, .header, .breadcrumbs, .search, script, style, .promo, iframe"
        )
        .forEach((el) => el.remove());

      const text = clone.innerText.replace(/\n{3,}/g, "\n\n").trim();
      const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>${escapeHtml(
        title
      )}</title></head><body>${clone.innerHTML}</body></html>`;

      return { title, text, html, url: location.href };
    },

    probe() {
      return {
        hostname: location.hostname,
        listCount: this.collectListItems().length,
        page: this.detectPage(),
        hasFullTextButton: Boolean(document.querySelector(".full-text__button")),
      };
    },
  };

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  globalThis.ConsAdapters = globalThis.ConsAdapters || {};
  globalThis.ConsAdapters.publicSite = PublicSiteAdapter;
})();
