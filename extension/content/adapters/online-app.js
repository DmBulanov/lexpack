/**
 * Adapter for authenticated online ConsultantPlus
 * (https://online.consultant.ru/… after login.consultant.ru).
 *
 * Calibrated 2026-07-18 against live session:
 *  - search list: a.x-page-components-search-result-item__extra-title
 *  - document body: .pageContainer.x-page-document-content
 *  - save: button.dots → «Сохранить в файл» → format row
 *  - quick Word: button.word
 *  - next in hit-list: button.next
 */
(function () {
  const FORMAT_MATCH = {
    docx: /формате\s*DOCX/i,
    rtf: /формате\s*RTF/i,
    txt: /без форматирования/i,
    txt_unicode: /UNICODE/i,
    pdf: /формате\s*PDF(?!\s*для)/i,
    pdf_ebook: /эл\.?\s*книг/i,
    epub: /EPUB/i,
    html: /формате\s*HTML/i,
    fb2: /FB2/i,
    xml: /Word 2003 XML|XML/i,
  };

  const NATIVE_FORMATS = new Set(Object.keys(FORMAT_MATCH));
  const DOCX_CLEANER_CHANNEL = "LEXPACK_DOCX_CLEANER_V1";
  const DOCX_CLEANER_ARM_TIMEOUT_MS = 2000;
  const DOCX_CLEANER_COMPLETION_TIMEOUT_MS = 40000;

  const SEARCH_SCOPES = Object.freeze(["all", "practice"]);
  const FULL_RESULTS_LINK_SELECTOR = ".x-pages-search-plus-results-link";
  const JUDICIAL_CATEGORY_PATTERNS = Object.freeze({
    "higher-courts": /^Решения высших судов$/i,
    "arbitration-circuit": /^Арбитражные суды округов$/i,
    "arbitration-first": /^Арбитражные суды первой инстанции$/i,
    "arbitration-rulings": /^Определения арбитражных судов$/i,
  });

  function isConsultantHost(hostname) {
    const host = String(hostname || "").toLowerCase();
    return host === "consultant.ru" || host.endsWith(".consultant.ru");
  }

  function adapterError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function docxCleanerRequestId() {
    const random = new Uint32Array(2);
    crypto.getRandomValues(random);
    return `${Date.now()}-${random[0].toString(16)}${random[1].toString(16)}`;
  }

  async function triggerCleanDocxDownload(trigger) {
    const requestId = docxCleanerRequestId();
    let phase = "arming";
    let armTimer = null;
    let completionTimer = null;
    let resolveArmed;
    let rejectArmed;
    let resolveCompleted;
    let rejectCompleted;
    const armed = new Promise((resolve, reject) => {
      resolveArmed = resolve;
      rejectArmed = reject;
    });
    const completed = new Promise((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });
    completed.catch(() => {});

    const onMessage = (event) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const message = event.data;
      if (
        message?.channel !== DOCX_CLEANER_CHANNEL ||
        message.requestId !== requestId
      ) {
        return;
      }
      if (message.type === "ARMED" && phase === "arming") {
        phase = "armed";
        clearTimeout(armTimer);
        resolveArmed();
      } else if (message.type === "CLEANED" && phase === "armed") {
        phase = "completed";
        clearTimeout(completionTimer);
        resolveCompleted(message.stats || {});
      } else if (message.type === "ERROR") {
        const error = adapterError(
          "DOCX_CLEANUP_FAILED",
          String(message.error || "Не удалось очистить Word-файл").slice(0, 500)
        );
        if (phase === "arming") rejectArmed(error);
        else rejectCompleted(error);
        phase = "failed";
      }
    };

    addEventListener("message", onMessage);
    armTimer = setTimeout(() => {
      rejectArmed(
        adapterError(
          "DOCX_CLEANER_UNAVAILABLE",
          "Модуль локальной очистки Word недоступен; исходный файл не сохранён"
        )
      );
    }, DOCX_CLEANER_ARM_TIMEOUT_MS);
    window.postMessage(
      { channel: DOCX_CLEANER_CHANNEL, type: "ARM", requestId },
      location.origin
    );

    try {
      await armed;
      completionTimer = setTimeout(() => {
        rejectCompleted(
          adapterError(
            "DOCX_CLEANUP_TIMEOUT",
            "Очистка Word-файла не завершилась за 40 секунд; исходный файл не сохранён"
          )
        );
      }, DOCX_CLEANER_COMPLETION_TIMEOUT_MS);
      await trigger();
      return await completed;
    } catch (error) {
      window.postMessage(
        { channel: DOCX_CLEANER_CHANNEL, type: "DISARM", requestId },
        location.origin
      );
      throw error;
    } finally {
      clearTimeout(armTimer);
      clearTimeout(completionTimer);
      removeEventListener("message", onMessage);
    }
  }

  function normalizedText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function resultSignature(items) {
    const source = (items || []).map((item) => `${item.url}\n${item.title}`).join("\n---\n");
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function documentIdentity(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      const base = url.searchParams.get("base") || "";
      const strongId =
        url.searchParams.get("n") ||
        url.searchParams.get("doc") ||
        url.searchParams.get("id") ||
        "";
      return base && strongId
        ? `${url.origin}${url.pathname}?base=${base}&id=${strongId}`
        : url.href;
    } catch {
      return String(rawUrl || "");
    }
  }

  function categoryKeyForLabel(label) {
    const value = normalizedText(label);
    return (
      Object.entries(JUDICIAL_CATEGORY_PATTERNS).find(([, pattern]) =>
        pattern.test(value)
      )?.[0] || null
    );
  }

  function stripQuotedQuery(value) {
    const normalized = normalizedText(value);
    return normalized.replace(/^["«“](.*)["»”]$/, "$1").trim();
  }

  function isPresetActive(element) {
    if (!element) return false;
    if (element.matches?.(":checked, [aria-selected='true'], [aria-pressed='true']")) {
      return true;
    }
    if (element.querySelector?.(":checked, [aria-selected='true'], [aria-pressed='true']")) {
      return true;
    }
    const marker = [
      element.className,
      element.getAttribute?.("data-state"),
      element.getAttribute?.("data-selected"),
    ]
      .filter(Boolean)
      .join(" ");
    return /(?:^|[-_\s])(active|checked|current|selected)(?:$|[-_\s])/i.test(marker);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const OnlineAppAdapter = {
    id: "online-app",

    getCapabilities(page = this.detectPage()) {
      const search = !["auth-required", "unsupported"].includes(page);
      const documentReady = page === "document" && Boolean(this._docRoot());
      const resultsReady =
        (page === "list" || page === "search") &&
        (this.collectListItems().length > 0 || this._hasEmptyResultsMessage());
      return {
        search,
        searchReady: search && Boolean(this._findSearchInput()),
        resultsReady,
        searchScopes: search ? SEARCH_SCOPES : [],
        collectList: page === "list" || page === "search",
        extractDocument: documentReady,
        documentReady,
        wordSaveReady: documentReady && Boolean(document.querySelector("button.word")),
        menuSaveReady: documentReady && Boolean(document.querySelector("button.dots")),
        exportFormats: ["docx", "pdf", "rtf", "txt", "html"],
        nativeSave: documentReady,
      };
    },

    matches(url) {
      try {
        const u = new URL(url);
        if (!isConsultantHost(u.hostname)) return false;
        if (/^(online|login|client|web)\./i.test(u.hostname)) return true;
        // SPA path after auth on other consultant hosts
        if (/online\.cgi/i.test(u.pathname + u.search)) return true;
        return false;
      } catch {
        return false;
      }
    },

    detectPage() {
      if (this._isAuthRequired()) return "auth-required";
      if (
        /[?&]req=doc\b/i.test(location.search) ||
        document.querySelector(
          ".pageContainer.x-page-document-content, .x-page-document-content, .contextToolbar button.word"
        )
      ) {
        return "document";
      }
      if (/[?&]req=query\b/i.test(location.search)) return "list";
      if (
        document.querySelector(
          "a.x-page-components-search-result-item__extra-title, .x-page-components-search-result-item"
        )
      ) {
        return "list";
      }
      if (/[?&]req=home\b/i.test(location.search)) return "home";
      if (/[?&]page=splus\b|[?&]req=card\b/i.test(location.href)) return "search";
      if (this._findSearchInput()) return "search";
      return "unsupported";
    },

    _isAuthRequired() {
      if (/^login\./i.test(location.hostname)) return true;
      const password = document.querySelector('input[type="password"]');
      if (!password) return false;
      return /(?:войти|вход|логин|парол)/i.test(document.body?.innerText || "");
    },

    _findSearchInput() {
      return document.querySelector(
        [
          "input.x-page-components-search-panel__filter",
          ".x-page-components-search-panel input.x-input__field",
          "[class*='search-panel'] input.x-input__field",
          "input[name='splusFind']",
        ].join(", ")
      );
    },

    _findSearchButton(input) {
      const container = input?.closest?.(
        "form, .x-page-components-search-panel, [class*='search-panel']"
      );
      const candidates = container?.querySelectorAll?.("button, a, [role=button]") || [];
      return [...candidates].find((element) =>
        /^найти$/i.test(normalizedText(element.innerText || element.textContent))
      );
    },

    collectListItems(root = document) {
      const items = [];
      const seen = new Set();
      const links = root.querySelectorAll(
        [
          "a.x-page-components-search-result-item__extra-title",
          "a.x-page-components-search-result-item__extra-text",
          ".x-page-search-results__list a[href*='req=doc']",
        ].join(", ")
      );

      links.forEach((a) => {
        const href = a.href;
        const identity = documentIdentity(href);
        if (!href || seen.has(identity)) return;
        if (!/[?&]req=doc\b/i.test(href)) return;
        seen.add(identity);
        const title = normalizedText(
          a.querySelector?.(".T")?.innerText ||
            a.querySelector?.(".T")?.textContent ||
            a.querySelector?.(".TH")?.innerText ||
            a.querySelector?.(".TH")?.textContent ||
            a.innerText ||
            a.textContent
        );
        if (!title) return;
        items.push({
          index: items.length + 1,
          title,
          url: href,
          instance: this.currentResultCategory().key,
          instanceLabel: this.currentResultCategory().label,
        });
      });

      return items;
    },

    async collectAllListItems(options = {}) {
      const parsedLimit = Number(options.maxItems);
      const maxItems = Number.isInteger(parsedLimit)
        ? Math.max(1, Math.min(200, parsedLimit))
        : 200;
      if (this.isFullResultsPage() && options.prevalidated !== true) {
        const deadline = Date.now() + 5000;
        let stableKey = "";
        let stableSince = 0;
        let ready = false;
        while (Date.now() < deadline) {
          const current = this.fullResultsState(this.currentSearchQuery());
          if (current.resultsReady && !current.loading) {
            const key = [
              current.activeCategory || current.activeCategoryLabel,
              current.categoryTotal ?? "",
              current.resultSignature,
              current.resultsRevision,
            ].join(":");
            if (key !== stableKey) {
              stableKey = key;
              stableSince = Date.now();
            }
            if (Date.now() - stableSince >= 1500) {
              ready = true;
              break;
            }
          } else {
            stableKey = "";
            stableSince = 0;
          }
          await sleep(150);
        }
        if (!ready) {
          throw adapterError(
            "COLLECTION_NOT_READY",
            "Открытая категория ещё формируется; дождитесь обновления списка и повторите"
          );
        }
      }
      const list = document.querySelector(
        ".x-page-search-results__list.x-list, .x-page-search-results__list"
      );
      const initialCategory = this.currentResultCategory();
      const initialQuery = this.currentSearchQuery();
      const expectedQuery = normalizedText(options.query || initialQuery);
      const expectedCategory = normalizedText(
        options.category || initialCategory.key || initialCategory.label
      );
      const ensureUnchanged = () => {
        if (!this.isFullResultsPage()) return;
        const currentCategory = this.currentResultCategory();
        const currentCategoryValue = normalizedText(
          currentCategory.key || currentCategory.label
        );
        if (
          (expectedQuery && this.currentSearchQuery() !== expectedQuery) ||
          (expectedCategory && currentCategoryValue !== expectedCategory)
        ) {
          throw adapterError(
            "COLLECTION_STATE_CHANGED",
            "Поисковая выдача или выбранная категория изменилась во время сбора"
          );
        }
      };
      ensureUnchanged();

      const state = this.isFullResultsPage() ? this.fullResultsState(expectedQuery) : null;
      const categoryTotal = Number.isInteger(state?.categoryTotal)
        ? state.categoryTotal
        : null;
      const categoryTotalKnown = categoryTotal !== null;
      const decorate = (items) =>
        items.map((item, index) => ({
          ...item,
          index: index + 1,
          instance: initialCategory.key,
          instanceLabel: initialCategory.label,
        }));
      const summarize = (items, reachedEnd) => {
        const moreCollectedThanLimit = items.length > maxItems;
        const decorated = decorate(items.slice(0, maxItems));
        const truncatedByLimit = categoryTotalKnown
          ? categoryTotal > decorated.length && decorated.length >= maxItems
          : moreCollectedThanLimit || (decorated.length >= maxItems && !reachedEnd);
        const incomplete =
          categoryTotalKnown &&
          decorated.length < Math.min(categoryTotal, maxItems) &&
          reachedEnd;
        return {
          items: decorated,
          categoryTotal,
          categoryTotalKnown,
          truncated: truncatedByLimit || incomplete,
          truncatedByLimit,
          incomplete,
          reachedEnd,
        };
      };

      if (!list) {
        const items = this.collectListItems();
        ensureUnchanged();
        return summarize(items, true);
      }

      let container = list;
      let candidate = list;
      while (candidate && candidate !== document.body) {
        if (
          Number(candidate.clientHeight || 0) > 0 &&
          Number(candidate.scrollHeight || 0) > Number(candidate.clientHeight || 0)
        ) {
          container = candidate;
          break;
        }
        candidate = candidate.parentElement;
      }
      if (
        Number(container.scrollHeight || 0) <= Number(container.clientHeight || 0) &&
        document.scrollingElement
      ) {
        container = document.scrollingElement;
      }

      const collectionRoot = container === document.scrollingElement ? document : container;
      const originalScrollTop = Number(container.scrollTop || 0);
      const collected = new Map();
      const collectVisible = () => {
        ensureUnchanged();
        for (const item of this.collectListItems(collectionRoot)) {
          const key = documentIdentity(item.url);
          if (!collected.has(key)) collected.set(key, item);
          if (collected.size >= maxItems) break;
        }
      };
      const moveTo = async (top) => {
        const beforeSignature = resultSignature(this.collectListItems(collectionRoot));
        container.scrollTop = top;
        if (typeof Event === "function") {
          container.dispatchEvent?.(new Event("scroll", { bubbles: true }));
        }
        const deadline = Date.now() + 420;
        let changed = false;
        let stableSignature = beforeSignature;
        let stableSamples = 0;
        while (Date.now() < deadline) {
          await sleep(60);
          ensureUnchanged();
          const signature = resultSignature(this.collectListItems(collectionRoot));
          if (signature !== beforeSignature) changed = true;
          if (signature === stableSignature) stableSamples += 1;
          else {
            stableSignature = signature;
            stableSamples = 0;
          }
          if (changed && stableSamples >= 1) break;
        }
      };

      let reachedEnd = true;
      try {
        let top = 0;
        let previousTop = -1;
        for (let pass = 0; pass < 400 && collected.size < maxItems; pass += 1) {
          await moveTo(top);
          collectVisible();
          const end = Math.max(0, container.scrollHeight - container.clientHeight);
          if (top >= end || top === previousTop) {
            reachedEnd = true;
            break;
          }
          reachedEnd = false;
          previousTop = top;
          const step = Math.max(40, Math.floor(container.clientHeight * 0.75));
          top = Math.min(end, top + step);
        }
      } finally {
        await moveTo(originalScrollTop);
      }

      ensureUnchanged();
      return summarize([...collected.values()], reachedEnd);
    },

    _ensureResultsObserver() {
      const list = document.querySelector(
        ".x-page-search-results__list.x-list, .x-page-search-results__list"
      );
      if (!list || this._resultsObservedList === list) return;
      this._resultsObserver?.disconnect?.();
      this._resultsObservedList = list;
      this._resultsRevision = Number(this._resultsRevision || 0) + 1;
      if (typeof MutationObserver !== "function") return;
      this._resultsObserver = new MutationObserver(() => {
        this._resultsRevision = Number(this._resultsRevision || 0) + 1;
      });
      this._resultsObserver.observe(list, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["href"],
      });
    },

    isFullResultsPage() {
      return (
        /[?&]req=query\b/i.test(location.search) &&
        Boolean(document.querySelector(".x-page-search-tree-item"))
      );
    },

    fullResultsQuery() {
      const value = document.querySelector(
        ".x-page-search-title__value .x-ellipsis__content, " +
          ".x-page-search-title__value"
      );
      return stripQuotedQuery(value?.innerText || value?.textContent);
    },

    currentResultCategory() {
      const heading = document.querySelector(".x-page-search-results-header__name");
      const label = normalizedText(heading?.innerText || heading?.textContent);
      return { key: categoryKeyForLabel(label), label };
    },

    fullResultsState(expectedQuery = "", expectedCategory = "") {
      this._ensureResultsObserver();
      const items = this.collectListItems();
      const loading = this._isResultsLoading();
      const emptyResults = this._hasEmptyResultsMessage();
      const query = normalizedText(expectedQuery);
      const pageQuery = this.fullResultsQuery();
      const category = this.currentResultCategory();
      const counter = normalizedText(
        document.querySelector(".x-page-search-results-header__counter")?.textContent
      );
      const totalMatch = counter.match(/:\s*(\d+)\s*\]/);
      const total = totalMatch ? Number(totalMatch[1]) : null;
      return {
        fullResults: this.isFullResultsPage(),
        queryMatches: Boolean(query) && pageQuery === query,
        queryAuthoritative: Boolean(query) && pageQuery === query,
        activeCategory: category.key,
        activeCategoryLabel: category.label,
        categoryMatches: !expectedCategory || category.key === expectedCategory,
        loading,
        emptyResults,
        resultsReady: !loading && (items.length > 0 || emptyResults),
        resultCount: items.length,
        categoryTotal: total,
        resultSignature: resultSignature(items),
        resultsRevision: Number(this._resultsRevision || 0),
        items,
      };
    },

    triggerFullResults(options = {}) {
      if (this.isFullResultsPage()) {
        return { triggered: false, alreadyOpen: true };
      }
      const link = [...document.querySelectorAll(FULL_RESULTS_LINK_SELECTOR)].find(
        (element) => element.getClientRects?.().length || element.offsetParent !== null
      );
      if (!link) {
        throw adapterError(
          "FULL_RESULTS_NOT_FOUND",
          "Ссылка «Все результаты поиска» не найдена"
        );
      }
      let fullResultsUrl;
      try {
        const target = new URL(link.href, location.href);
        if (
          target.protocol !== "https:" ||
          !isConsultantHost(target.hostname) ||
          target.origin !== location.origin ||
          target.username ||
          target.password ||
          target.searchParams.get("req") !== "query"
        ) {
          throw new Error("invalid target");
        }
        fullResultsUrl = target.href;
      } catch {
        throw adapterError(
          "FULL_RESULTS_INVALID_URL",
          "Ссылка «Все результаты поиска» имеет неожиданный адрес"
        );
      }
      if (options.activate === true) {
        setTimeout(() => {
          if (link.isConnected !== false) link.click();
        }, 0);
      }
      return {
        triggered: options.activate === true,
        prepared: options.activate !== true,
        opensNewTab: true,
        fullResultsUrl,
      };
    },

    _findTreeRow(labelPattern) {
      return [...document.querySelectorAll(".x-page-search-tree-item")].find((row) =>
        labelPattern.test(
          normalizedText(
            row.querySelector?.(".x-page-search-tree-item__name")?.textContent
          )
        )
      );
    },

    async _expandTreeRow(labelPattern) {
      const row = this._findTreeRow(labelPattern);
      if (!row) return false;
      const expanded = row.querySelector?.("[data-expanded='1']");
      if (expanded) return true;
      row.click();
      await sleep(180);
      return true;
    },

    async triggerJudicialCategory(categoryKey) {
      const pattern = JUDICIAL_CATEGORY_PATTERNS[categoryKey];
      if (!pattern) {
        throw adapterError("UNSUPPORTED_INSTANCE", "Неизвестная судебная инстанция");
      }
      if (!this.isFullResultsPage()) {
        throw adapterError(
          "FULL_RESULTS_REQUIRED",
          "Сначала откройте «Все результаты поиска»"
        );
      }
      if (this.currentResultCategory().key === categoryKey) {
        return { triggered: false, category: categoryKey };
      }

      await this._expandTreeRow(/^Судебная практика$/i);
      if (categoryKey.startsWith("arbitration-")) {
        await this._expandTreeRow(/^Арбитражные суды$/i);
      }
      const row = this._findTreeRow(pattern);
      if (!row) {
        throw adapterError(
          "INSTANCE_NOT_FOUND",
          `Категория «${categoryKey}» отсутствует в этой выдаче`
        );
      }
      const before = this.fullResultsState();
      setTimeout(() => {
        if (row.isConnected !== false) row.click();
      }, 0);
      return {
        triggered: true,
        category: categoryKey,
        beforeSignature: before.resultSignature,
        beforeTotal: before.categoryTotal,
        beforeRevision: before.resultsRevision,
        beforeCategory: before.activeCategory,
      };
    },

    currentSearchQuery() {
      if (this.isFullResultsPage()) return this.fullResultsQuery();
      const inputValue = normalizedText(this._findSearchInput()?.value);
      if (inputValue) return inputValue;
      return this._urlSearchQuery();
    },

    _urlSearchQuery() {
      try {
        return normalizedText(new URL(location.href).searchParams.get("splusFind"));
      } catch {
        return "";
      }
    },

    _activeSearchScope() {
      const practice = this._findScopePreset(/судебная практика/i);
      if (isPresetActive(practice)) return "practice";
      const all = this._findScopePreset(
        /^(?:все|все документы|все материалы|все результаты|все по запросу)$/i
      );
      return isPresetActive(all) ? "all" : null;
    },

    getSearchState(expectedQuery = "") {
      if (this.isFullResultsPage()) {
        const state = this.fullResultsState(expectedQuery);
        return {
          ...state,
          activeScope: state.activeCategory ? "practice" : "all",
        };
      }
      const items = this.collectListItems();
      const loading = this._isResultsLoading();
      const emptyResults = this._hasEmptyResultsMessage();
      const query = normalizedText(expectedQuery);
      const urlQuery = this._urlSearchQuery();
      return {
        queryMatches: Boolean(query) && this.currentSearchQuery() === query,
        queryAuthoritative: Boolean(query) && urlQuery === query,
        activeScope: this._activeSearchScope(),
        loading,
        emptyResults,
        resultsReady: !loading && (items.length > 0 || emptyResults),
        resultCount: items.length,
        resultSignature: resultSignature(items),
        items,
      };
    },

    triggerSearchScope(scope) {
      if (!SEARCH_SCOPES.includes(scope)) {
        throw adapterError("UNSUPPORTED_SCOPE", `Неизвестная область поиска: ${scope}`);
      }
      const state = this.getSearchState();
      if (state.activeScope === scope) {
        return { triggered: false, scopeApplied: true, beforeSignature: state.resultSignature };
      }
      const preset = this._findScopePreset(
        scope === "practice"
          ? /судебная практика/i
          : /^(?:все|все документы|все материалы|все результаты|все по запросу)$/i
      );
      if (!preset) {
        throw adapterError("SCOPE_NOT_FOUND", `Переключатель области «${scope}» не найден`);
      }
      setTimeout(() => {
        if (preset.isConnected !== false) preset.click();
      }, 0);
      return {
        triggered: true,
        scopeApplied: false,
        navigationExpected: true,
        beforeSignature: state.resultSignature,
      };
    },

    /**
     * Run quick search for a query, optionally filter to judicial practice.
     * @param {string} query
     * @param {{ scope?: 'all'|'practice' }} [options]
     */
    async runSearch(query, options = {}) {
      const q = String(query || "").trim();
      if (!q) throw new Error("Пустой запрос");
      const scope = options.scope || "practice";
      if (!SEARCH_SCOPES.includes(scope)) {
        throw adapterError("UNSUPPORTED_SCOPE", `Неизвестная область поиска: ${scope}`);
      }

      const page = this.detectPage();
      if (page === "auth-required") {
        throw adapterError("AUTH_REQUIRED", "Сначала войдите в онлайн-КонсультантПлюс");
      }
      if (page === "unsupported") {
        throw adapterError(
          "UNSUPPORTED_PAGE",
          "На этой странице не найден интерфейс онлайн-КонсультантПлюс"
        );
      }

      const state = this.getSearchState(q);
      if (
        state.queryMatches &&
        state.queryAuthoritative &&
        state.activeScope === scope &&
        state.resultsReady
      ) {
        return {
          query: q,
          scope,
          scopeApplied: true,
          count: state.items.length,
          items: state.items,
          url: location.href,
        };
      }

      return {
        query: q,
        scope,
        scopeApplied: false,
        navigating: true,
        count: 0,
        items: [],
        url: consBuildOnlineSearchUrl(location.href, q),
      };
    },

    _resultsRoot() {
      return (
        document.querySelector(
          ".x-page-search-plus-results, [class*='search-results'], [class*='search-result-list']"
        ) || document.body
      );
    },

    _hasEmptyResultsMessage() {
      return /(?:ничего не найдено|документы не найдены|по вашему запросу[^.]{0,80}не найден)/i.test(
        document.body?.innerText || ""
      );
    },

    _isResultsLoading() {
      const root = this._resultsRoot();
      const selector =
        "[aria-busy='true'], [data-loading='true'], progress, " +
        "[class*='spinner'], [class*='loader']";
      const marker = root?.matches?.(selector)
        ? root
        : root?.querySelector?.(selector);
      if (!marker) return false;
      if (marker.hidden || marker.getAttribute?.("aria-hidden") === "true") return false;
      return true;
    },

    _findScopePreset(labelRe) {
      return [...document.querySelectorAll(
        ".x-page-search-plus-presets__preset, [class*='presets__preset'], a, button, [role=tab]"
      )].find((element) => labelRe.test(normalizedText(element.innerText || element.textContent)));
    },

    _docTitle() {
      return (
        document.title.replace(/\s*[-–|]\s*КонсультантПлюс.*$/i, "").trim() ||
        document
          .querySelector(".pageContainer, .x-page-document-content")
          ?.innerText?.trim()
          ?.split("\n")
          .find((l) => l.trim().length > 10)
          ?.trim() ||
        "document"
      );
    },

    getDocumentTitle() {
      return this._docTitle();
    },

    _docRoot() {
      return (
        document.querySelector(".pageContainer.x-page-document-content") ||
        document.querySelector(".x-page-document-content") ||
        document.querySelector(".pageContainer") ||
        document.querySelector("[class*='document-content']")
      );
    },

    async _openSaveFormatMenu() {
      // Close stray menus
      document.body.click();
      await sleep(150);

      const dots = document.querySelector("button.dots");
      if (!dots) throw new Error("Кнопка «Ещё» (dots) не найдена");
      dots.click();
      await sleep(350);

      const saveRow = [...document.querySelectorAll(".x-menu__content-row")].find(
        (r) => /сохранить в файл/i.test(r.innerText || "")
      );
      if (!saveRow) throw new Error("Пункт «Сохранить в файл» не найден");

      saveRow.dispatchEvent(
        new MouseEvent("mouseenter", { bubbles: true, cancelable: true })
      );
      saveRow.dispatchEvent(
        new MouseEvent("mousemove", { bubbles: true, cancelable: true })
      );
      saveRow.click();
      await sleep(400);

      // Format submenu should be the menu containing DOCX/PDF rows
      const hasFormats = [...document.querySelectorAll(".x-menu__content-row")].some(
        (r) => /формате\s*DOCX|без форматирования/i.test(r.innerText || "")
      );
      if (!hasFormats) {
        // retry hover
        saveRow.dispatchEvent(
          new MouseEvent("mouseover", { bubbles: true, cancelable: true })
        );
        await sleep(400);
      }
    },

    async nativeSave(formatKey) {
      const needle = FORMAT_MATCH[formatKey];
      if (!needle) throw new Error(`Неизвестный формат: ${formatKey}`);

      await this._openSaveFormatMenu();

      const formatRow = [...document.querySelectorAll(".x-menu__content-row")].find(
        (r) => needle.test((r.innerText || "").replace(/\s+/g, " "))
      );
      if (!formatRow) {
        throw new Error(`Формат «${formatKey}» не найден в меню`);
      }
      formatRow.click();
      await sleep(800);
      return true;
    },

    async extractCurrentDocument(options = {}) {
      const format = (options.format || "docx").toLowerCase();
      const title = this._docTitle();

      // Word export is intercepted in the page's main world, sanitized locally,
      // and only then handed to the browser download pipeline.
      if (format === "docx" || format === "word") {
        const wordBtn = document.querySelector("button.word");
        await triggerCleanDocxDownload(async () => {
          if (wordBtn) {
            wordBtn.click();
            await sleep(800);
          } else {
            await this.nativeSave("docx");
          }
        });
        return {
          title,
          text: "",
          html: "",
          nativeSaveTriggered: true,
          contentCleanup: {
            consultantDataRemoved: true,
            pageNumberPreserved: true,
            documentBodyPreserved: true,
          },
          url: location.href,
          format: "docx",
        };
      }

      if (NATIVE_FORMATS.has(format) && format !== "html" && format !== "txt") {
        await this.nativeSave(format);
        return {
          title,
          text: "",
          html: "",
          nativeSaveTriggered: true,
          url: location.href,
          format,
        };
      }

      // Fast path: pull text/HTML from the document pane
      const root = this._docRoot();
      if (!root) {
        throw adapterError(
          "DOCUMENT_NOT_READY",
          "Область документа не найдена; дождитесь загрузки документа и повторите экспорт"
        );
      }

      const clone = root.cloneNode(true);
      clone
        .querySelectorAll("script, style, .contextToolbar, .contextPanel")
        .forEach((el) => el.remove());

      const text = clone.innerText.replace(/\n{3,}/g, "\n\n").trim();
      const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>${escapeHtml(
        title
      )}</title><link rel="canonical" href="${escapeHtml(
        location.href
      )}"></head><body>${clone.innerHTML}</body></html>`;

      return { title, text, html, url: location.href, format };
    },

    /** Move to next document in current search hit-list (if available). */
    async goNextDocument() {
      const next = document.querySelector("button.next:not(.disabled)");
      if (!next) return false;
      next.click();
      await sleep(900);
      return true;
    },

    probe() {
      return {
        hostname: location.hostname,
        page: this.detectPage(),
        listCount: this.collectListItems().length,
        hasWord: Boolean(document.querySelector("button.word")),
        hasDots: Boolean(document.querySelector("button.dots")),
        hasNext: Boolean(document.querySelector("button.next")),
        hasDocPane: Boolean(this._docRoot()),
        docTextLen: this._docRoot()?.innerText?.length || 0,
      };
    },
  };

  globalThis.ConsAdapters = globalThis.ConsAdapters || {};
  globalThis.ConsAdapters.onlineApp = OnlineAppAdapter;
})();
