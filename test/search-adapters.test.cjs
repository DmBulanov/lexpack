const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  consBuildOnlineSearchUrl,
  consBuildPublicSearchUrl,
} = require("../extension/shared/runtime.js");

const root = path.resolve(__dirname, "..");
const publicAdapterSource = fs.readFileSync(
  path.join(root, "extension/content/adapters/public-site.js"),
  "utf8"
);
const onlineAdapterSource = fs.readFileSync(
  path.join(root, "extension/content/adapters/online-app.js"),
  "utf8"
);
const routerSource = fs.readFileSync(
  path.join(root, "extension/content/content.js"),
  "utf8"
);

function makeLocation(initialUrl) {
  const current = new URL(initialUrl);
  const assigned = [];
  return {
    assigned,
    get href() {
      return current.href;
    },
    get origin() {
      return current.origin;
    },
    get hostname() {
      return current.hostname;
    },
    get pathname() {
      return current.pathname;
    },
    get search() {
      return current.search;
    },
    assign(url) {
      assigned.push(url);
    },
  };
}

function baseDocument(overrides = {}) {
  const body = overrides.body || { innerText: "", click() {} };
  return {
    title: "Test",
    body,
    documentElement: overrides.documentElement || {},
    querySelector: overrides.querySelector || (() => null),
    querySelectorAll: overrides.querySelectorAll || (() => []),
  };
}

function loadAdapter(source, name, { location, document, extras = {} }) {
  const context = vm.createContext({
    URL,
    location,
    document,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    consBuildOnlineSearchUrl,
    consBuildPublicSearchUrl,
    ...extras,
  });
  vm.runInContext(source, context, { filename: `${name}.js` });
  return { adapter: context.ConsAdapters[name], context };
}

function publicDocument(items = []) {
  return baseDocument({
    querySelectorAll(selector) {
      if (selector.includes("search-results__link")) return items;
      return [];
    },
  });
}

test("public search navigates when the current result page belongs to an older query", async () => {
  const location = makeLocation("https://www.consultant.ru/search/?q=old");
  const { adapter } = loadAdapter(publicAdapterSource, "publicSite", {
    location,
    document: publicDocument(),
  });

  const result = await adapter.runSearch("new query", { scope: "all" });

  assert.equal(result.navigating, true);
  assert.equal(result.scope, "all");
  assert.equal(result.scopeApplied, false);
  assert.equal(new URL(result.url).searchParams.get("q"), "new query");
  assert.deepEqual(location.assigned, []);
});

test("public search compares the decoded q value and reuses only the same query", async () => {
  const location = makeLocation("https://www.consultant.ru/search/?q=lease+debt");
  const link = {
    href: "https://www.consultant.ru/document/cons_doc_LAW_1/",
    innerText: "1 Lease dispute",
  };
  const { adapter } = loadAdapter(publicAdapterSource, "publicSite", {
    location,
    document: publicDocument([link]),
  });

  const result = await adapter.runSearch("lease debt", { scope: "all" });

  assert.equal(result.navigating, undefined);
  assert.equal(result.count, 1);
  assert.equal(result.items[0].title, "Lease dispute");
  assert.deepEqual(location.assigned, []);
});

test("public adapter advertises and enforces only the scope it can apply", async () => {
  const location = makeLocation("https://www.consultant.ru/search/?q=test");
  const { adapter } = loadAdapter(publicAdapterSource, "publicSite", {
    location,
    document: publicDocument(),
  });

  assert.deepEqual(Array.from(adapter.getCapabilities("list").searchScopes), ["all"]);
  assert.equal(adapter.matches("https://evilconsultant.ru/search/?q=test"), false);
  await assert.rejects(
    adapter.runSearch("test", { scope: "practice" }),
    (error) => error.code === "UNSUPPORTED_SCOPE"
  );
});

test("online adapter reports login as AUTH_REQUIRED and never treats it as a search page", async () => {
  const location = makeLocation("https://login.consultant.ru/login");
  const document = baseDocument({
    body: { innerText: "Вход Логин Пароль", click() {} },
    querySelector(selector) {
      if (selector === 'input[type="password"]') return {};
      return null;
    },
  });
  const { adapter } = loadAdapter(onlineAdapterSource, "onlineApp", {
    location,
    document,
  });

  assert.equal(adapter.detectPage(), "auth-required");
  assert.equal(adapter.getCapabilities().search, false);
  assert.equal(adapter.getCapabilities().documentReady, false);
  await assert.rejects(
    adapter.runSearch("claim", { scope: "practice" }),
    (error) => error.code === "AUTH_REQUIRED"
  );
  assert.deepEqual(location.assigned, []);
});

test("online search does not type into an unrelated generic text input", async () => {
  const location = makeLocation(
    "https://online.consultant.ru/riv/cgi/online.cgi?req=home&rnd=abc"
  );
  const genericInput = {
    focused: false,
    focus() {
      this.focused = true;
    },
  };
  const queried = [];
  const document = baseDocument({
    querySelector(selector) {
      queried.push(selector);
      if (selector === 'input[type="text"]') return genericInput;
      return null;
    },
  });
  const { adapter } = loadAdapter(onlineAdapterSource, "onlineApp", {
    location,
    document,
  });

  assert.equal(adapter.getCapabilities("home").searchReady, false);

  const result = await adapter.runSearch("lease debt", { scope: "all" });

  assert.equal(result.navigating, true);
  assert.equal(genericInput.focused, false);
  assert.equal(queried.includes('input[type="text"]'), false);
  assert.equal(new URL(result.url).searchParams.get("splusFind"), "lease debt");
  assert.deepEqual(location.assigned, []);

  const practice = await adapter.runSearch("lease debt", { scope: "practice" });
  assert.equal(practice.navigating, true);
  assert.equal(new URL(practice.url).searchParams.get("splusFind"), "lease debt");
  assert.deepEqual(location.assigned, []);
});

test("online direct export fails safely when the document pane is not ready", async () => {
  const location = makeLocation(
    "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=LAW&n=1"
  );
  const { adapter } = loadAdapter(onlineAdapterSource, "onlineApp", {
    location,
    document: baseDocument(),
  });

  await assert.rejects(
    adapter.extractCurrentDocument({ format: "txt" }),
    (error) => error.code === "DOCUMENT_NOT_READY"
  );
});

test("online runSearch returns a navigation plan without mutating the current document", async () => {
  const location = makeLocation(
    "https://online.consultant.ru/riv/cgi/online.cgi?req=card&page=splus#splus"
  );
  const observers = [];
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.active = true;
      observers.push(this);
    }
    observe(rootNode) {
      this.rootNode = rootNode;
    }
    disconnect() {
      this.active = false;
    }
  }
  function notify(target) {
    for (const observer of observers.filter((candidate) => candidate.active)) {
      observer.callback([{ target }]);
    }
  }

  class FakeInput {
    constructor(value) {
      this._value = value;
      this.events = [];
    }
    get value() {
      return this._value;
    }
    set value(value) {
      this._value = String(value);
    }
    focus() {}
    dispatchEvent(event) {
      this.events.push(event.type);
      return true;
    }
  }

  const input = new FakeInput("old query");
  const resultRoot = {};
  const documentElement = {};
  const oldLink = {
    href: "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&id=old",
    innerText: "Old result",
  };
  const newLink = {
    href: "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&id=new",
    innerText: "New result",
  };
  const filteredLink = {
    href: "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&id=filtered",
    innerText: "Filtered practice result",
  };
  const partialLink = {
    href: "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&id=partial",
    innerText: "Partial result",
  };
  let links = [oldLink];
  let staleSearchAccepted = false;

  const practicePreset = {
    innerText: "Судебная практика",
    className: "x-page-search-plus-presets__preset",
    getAttribute() {
      return null;
    },
    matches() {
      return this.className.includes("selected");
    },
    querySelector() {
      return null;
    },
    contains(node) {
      return node === this;
    },
    click() {
      staleSearchAccepted = links[0] !== newLink;
      this.className += " selected";
      notify(this);
      links = [partialLink];
      notify(resultRoot);
      setTimeout(() => {
        links = [filteredLink];
        notify(resultRoot);
      }, 900);
    },
  };
  const findButton = {
    innerText: "Найти",
    click() {
      notify(resultRoot);
      setTimeout(() => {
        links = [newLink];
        notify(resultRoot);
      }, 900);
    },
  };
  input.closest = () => ({ querySelectorAll: () => [findButton] });

  const document = baseDocument({
    body: { innerText: "Search results", click() {} },
    documentElement,
    querySelector(selector) {
      if (selector === 'input[type="password"]') return null;
      if (selector.includes("x-page-components-search-result-item")) return links[0] || null;
      if (selector.includes("search-panel") || selector.includes("splusFind")) return input;
      if (selector.includes("search-results") || selector.includes("search-result-list")) {
        return resultRoot;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes("search-result-item__extra")) return links;
      if (selector.includes("presets__preset")) return [practicePreset];
      return [];
    },
  });

  const { adapter } = loadAdapter(onlineAdapterSource, "onlineApp", {
    location,
    document,
    extras: {
      MutationObserver: FakeMutationObserver,
      HTMLInputElement: FakeInput,
      Event: class Event {
        constructor(type) {
          this.type = type;
        }
      },
      KeyboardEvent: class KeyboardEvent {
        constructor(type) {
          this.type = type;
        }
      },
    },
  });

  const result = await adapter.runSearch("new query", { scope: "practice" });

  assert.equal(result.scope, "practice");
  assert.equal(result.scopeApplied, false);
  assert.equal(result.navigating, true);
  assert.equal(result.count, 0);
  assert.equal(result.items.length, 0);
  assert.deepEqual(input.events, []);
  assert.doesNotMatch(practicePreset.className, /selected/);
  assert.equal(staleSearchAccepted, false);
});

test("online search state does not report a different or missing query as ready", async () => {
  const location = makeLocation(
    "https://online.consultant.ru/riv/cgi/online.cgi?req=card&page=splus#splus"
  );
  const observers = [];
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe() {}
    disconnect() {}
  }
  const notify = (target) => {
    for (const observer of observers) observer.callback([{ target }]);
  };

  const loadingMarker = {
    hidden: false,
    getAttribute() {
      return null;
    },
  };
  const resultRoot = {
    loading: false,
    matches() {
      return false;
    },
    querySelector() {
      return this.loading ? loadingMarker : null;
    },
  };
  const link = {
    href: "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&id=same",
    innerText: "Same result",
  };
  const document = baseDocument({
    body: { innerText: "Search results", click() {} },
    querySelector(selector) {
      if (selector.includes("search-results") || selector.includes("search-result-list")) {
        return resultRoot;
      }
      return null;
    },
    querySelectorAll(selector) {
      return selector.includes("search-result-item__extra") ? [link] : [];
    },
  });
  const { adapter } = loadAdapter(onlineAdapterSource, "onlineApp", {
    location,
    document,
    extras: { MutationObserver: FakeMutationObserver },
  });
  resultRoot.loading = true;
  notify(resultRoot);
  const loadingState = adapter.getSearchState("expected query");
  assert.equal(loadingState.loading, true);
  assert.equal(loadingState.resultsReady, false);
  assert.equal(loadingState.queryMatches, false);

  resultRoot.loading = false;
  notify(resultRoot);
  const settledState = adapter.getSearchState("expected query");
  assert.equal(settledState.resultsReady, true);
  assert.equal(settledState.queryMatches, false);
  assert.equal(settledState.items[0].title, "Same result");
});

test("online list uses the document heading before the matching fragment", () => {
  const location = makeLocation(
    "https://online.consultant.ru/riv/cgi/online.cgi?req=query"
  );
  const heading = {
    innerText: "Путеводитель по судебной практике: Общие положения об аренде.",
  };
  const fragment = {
    innerText: "Можно ли взыскать с арендодателя платежи по договору аренды",
  };
  const link = {
    href: "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=PSP&n=1765",
    innerText: `${heading.innerText} ${fragment.innerText}`,
    querySelector(selector) {
      if (selector === ".T") return heading;
      if (selector === ".TH") return fragment;
      return null;
    },
  };
  const document = baseDocument({
    body: { innerText: "Search results", click() {} },
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      return selector.includes("search-result-item__extra") ? [link] : [];
    },
  });
  const { adapter } = loadAdapter(onlineAdapterSource, "onlineApp", {
    location,
    document,
  });

  const [item] = adapter.collectListItems();
  assert.equal(item.title, heading.innerText);
});

test("online state is atomic and scope clicks are deferred until after the response", () => {
  const location = makeLocation(
    "https://online.consultant.ru/riv/cgi/online.cgi?req=card&page=splus&splusFind=" +
      encodeURIComponent("долг + аренда & суд # 10%") +
      "#splus"
  );
  const queuedTimers = [];
  const input = { value: "долг + аренда & суд # 10%" };
  const link = {
    href: "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=LAW&n=10",
    innerText: "Судебный результат",
  };
  const allPreset = {
    innerText: "Все документы",
    className: "x-page-search-plus-presets__preset--active",
    active: true,
    matches() {
      return this.active;
    },
    querySelector() {
      return null;
    },
    getAttribute() {
      return null;
    },
    click() {
      this.active = true;
      practicePreset.active = false;
    },
  };
  const practicePreset = {
    innerText: "Судебная практика",
    className: "x-page-search-plus-presets__preset",
    active: false,
    matches() {
      return this.active;
    },
    querySelector() {
      return null;
    },
    getAttribute() {
      return null;
    },
    click() {
      this.active = true;
      allPreset.active = false;
    },
  };
  const resultsRoot = {
    matches() {
      return false;
    },
    querySelector() {
      return null;
    },
  };
  const document = baseDocument({
    body: { innerText: "Search results", click() {} },
    querySelector(selector) {
      if (selector === 'input[type="password"]') return null;
      if (selector.includes("search-panel")) return input;
      if (selector.includes("search-results") || selector.includes("search-result-list")) {
        return resultsRoot;
      }
      if (selector.includes("search-result-item")) return link;
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes("search-result-item__extra")) return [link];
      if (selector.includes("presets__preset")) return [allPreset, practicePreset];
      return [];
    },
  });
  const { adapter } = loadAdapter(onlineAdapterSource, "onlineApp", {
    location,
    document,
    extras: {
      setTimeout(callback) {
        queuedTimers.push(callback);
        return queuedTimers.length;
      },
    },
  });

  const initial = adapter.getSearchState("долг + аренда & суд # 10%");
  assert.equal(initial.queryMatches, true);
  assert.equal(initial.activeScope, "all");
  assert.equal(initial.resultsReady, true);
  assert.equal(initial.resultCount, 1);
  assert.equal(initial.items[0].title, "Судебный результат");

  const triggerPractice = adapter.triggerSearchScope("practice");
  assert.equal(triggerPractice.triggered, true);
  assert.equal(practicePreset.active, false, "click must not run in the response task");
  queuedTimers.shift()();
  assert.equal(adapter.getSearchState("долг + аренда & суд # 10%").activeScope, "practice");

  const alreadyPractice = adapter.triggerSearchScope("practice");
  assert.equal(alreadyPractice.triggered, false);
  assert.equal(queuedTimers.length, 0);

  const triggerAll = adapter.triggerSearchScope("all");
  assert.equal(triggerAll.triggered, true);
  queuedTimers.shift()();
  assert.equal(adapter.getSearchState("долг + аренда & суд # 10%").activeScope, "all");
});

test("online query state falls back to the decoded splusFind parameter", () => {
  const query = "плюс + амперсанд & решётка # процент %";
  const location = makeLocation(
    `https://online.consultant.ru/riv/cgi/online.cgi?req=card&page=splus&splusFind=${encodeURIComponent(query)}#splus`
  );
  const document = baseDocument({
    body: { innerText: "Ничего не найдено", click() {} },
  });
  const { adapter } = loadAdapter(onlineAdapterSource, "onlineApp", {
    location,
    document,
  });

  const state = adapter.getSearchState(query);
  assert.equal(state.queryMatches, true);
  assert.equal(state.emptyResults, true);
  assert.equal(state.resultsReady, true);

  const plan = adapter.runSearch(`${query} ещё`, { scope: "all" });
  return plan.then((result) => {
    assert.equal(new URL(result.url).searchParams.get("splusFind"), `${query} ещё`);
    assert.deepEqual(location.assigned, []);
  });
});

test("an edited but unsubmitted online input is not treated as authoritative results", async () => {
  const location = makeLocation(
    "https://online.consultant.ru/riv/cgi/online.cgi?req=card&page=splus#splus"
  );
  const input = { value: "новый несохранённый запрос" };
  const link = {
    href: "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=LAW&n=1",
    innerText: "Старый результат",
  };
  const allPreset = {
    innerText: "Все",
    className: "x-page-search-plus-presets__preset--active",
    matches() {
      return true;
    },
    querySelector() {
      return null;
    },
    getAttribute() {
      return null;
    },
  };
  const document = baseDocument({
    body: { innerText: "Search results", click() {} },
    querySelector(selector) {
      if (selector.includes("search-panel")) return input;
      if (selector.includes("search-result-item")) return link;
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes("search-result-item__extra")) return [link];
      if (selector.includes("presets__preset")) return [allPreset];
      return [];
    },
  });
  const { adapter } = loadAdapter(onlineAdapterSource, "onlineApp", {
    location,
    document,
  });

  const state = adapter.getSearchState("новый несохранённый запрос");
  assert.equal(state.queryMatches, true);
  assert.equal(state.queryAuthoritative, false);
  assert.equal(state.activeScope, "all");
  assert.equal(state.items[0].title, "Старый результат");

  const result = await adapter.runSearch("новый несохранённый запрос", {
    scope: "all",
  });
  assert.equal(result.navigating, true);
  assert.equal(
    new URL(result.url).searchParams.get("splusFind"),
    "новый несохранённый запрос"
  );
});

function loadRouter(adapters, url = "https://unsupported.example/") {
  let listener;
  const context = vm.createContext({
    location: makeLocation(url),
    document: { title: "Router test" },
    ConsAdapters: adapters,
    chrome: {
      runtime: {
        onMessage: {
          addListener(callback) {
            listener = callback;
          },
        },
      },
    },
  });
  vm.runInContext(routerSource, context, { filename: "content.js" });
  return (message) =>
    new Promise((resolve) => {
      const asyncResponse = listener(message, {}, resolve);
      assert.equal(asyncResponse, true);
    });
}

test("content router has no fallback adapter for an unsupported page", async () => {
  const request = loadRouter({
    onlineApp: { matches: () => false },
    publicSite: { matches: () => false },
  });

  const response = await request({ type: "PING" });

  assert.equal(response.ok, false);
  assert.equal(response.code, "UNSUPPORTED_PAGE");
});

test("content router installs only one listener when the script is injected twice", () => {
  let listeners = 0;
  const context = vm.createContext({
    location: makeLocation("https://www.consultant.ru/search/?q=test"),
    document: { title: "Router test" },
    ConsAdapters: {},
    chrome: {
      runtime: {
        onMessage: {
          addListener() {
            listeners += 1;
          },
        },
      },
    },
  });

  vm.runInContext(routerSource, context, { filename: "content-first.js" });
  vm.runInContext(routerSource, context, { filename: "content-second.js" });

  assert.equal(listeners, 1);
});

test("content router exposes AUTH_REQUIRED and rejects unsupported scopes before search", async () => {
  let searchCalls = 0;
  const onlineRequest = loadRouter(
    {
      onlineApp: {
        id: "online-app",
        matches: () => true,
        detectPage: () => "auth-required",
        getCapabilities: () => ({ search: false, searchScopes: [] }),
        runSearch: async () => {
          searchCalls += 1;
        },
      },
    },
    "https://login.consultant.ru/"
  );

  const ping = await onlineRequest({ type: "PING" });
  const auth = await onlineRequest({ type: "RUN_SEARCH", query: "test" });

  assert.equal(ping.authRequired, true);
  assert.equal(auth.code, "AUTH_REQUIRED");
  assert.equal(searchCalls, 0);

  const publicRequest = loadRouter(
    {
      publicSite: {
        id: "public-site",
        matches: () => true,
        detectPage: () => "list",
        getCapabilities: () => ({ search: true, searchScopes: ["all"] }),
        runSearch: async () => {
          searchCalls += 1;
        },
      },
    },
    "https://www.consultant.ru/search/?q=test"
  );
  const scope = await publicRequest({
    type: "RUN_SEARCH",
    query: "test",
    scope: "practice",
  });

  assert.equal(scope.code, "UNSUPPORTED_SCOPE");
  assert.equal(searchCalls, 0);
});

test("content router returns the actual title only for a ready document", async () => {
  const request = loadRouter(
    {
      onlineApp: {
        id: "online-app",
        matches: () => true,
        detectPage: () => "document",
        getCapabilities: () => ({ documentReady: true }),
        getDocumentTitle: () =>
          "Путеводитель по судебной практике: Общие положения об аренде",
      },
    },
    "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=PSP&n=1765"
  );

  const ping = await request({ type: "PING" });
  assert.equal(
    ping.documentTitle,
    "Путеводитель по судебной практике: Общие положения об аренде"
  );
});

test("content router exposes atomic search state and returns before a deferred scope click", async () => {
  let clicked = false;
  let timerCallback = null;
  const adapter = {
    id: "online-app",
    matches: () => true,
    detectPage: () => "list",
    getCapabilities: () => ({
      search: true,
      searchScopes: ["all", "practice"],
    }),
    getSearchState: (query) => ({
      queryMatches: query === "точный запрос",
      queryAuthoritative: query === "точный запрос",
      activeScope: "all",
      loading: false,
      resultsReady: true,
      items: [],
    }),
    triggerSearchScope: () => {
      timerCallback = () => {
        clicked = true;
      };
      return {
        triggered: true,
        navigationExpected: true,
        beforeSignature: "before",
      };
    },
  };
  const request = loadRouter(
    { onlineApp: adapter },
    "https://online.consultant.ru/riv/cgi/online.cgi?req=card&page=splus"
  );

  const state = await request({ type: "GET_SEARCH_STATE", query: "точный запрос" });
  assert.equal(state.ok, true);
  assert.equal(state.state.queryMatches, true);

  const trigger = await request({ type: "CLICK_SEARCH_SCOPE", scope: "practice" });
  assert.equal(trigger.ok, true);
  assert.equal(trigger.triggered, true);
  assert.equal(clicked, false);
  assert.equal(typeof timerCallback, "function");
  timerCallback();
  assert.equal(clicked, true);
});
