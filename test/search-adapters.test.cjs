const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

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
  assert.equal(result.scopeApplied, true);
  assert.deepEqual(location.assigned, [
    "https://www.consultant.ru/search/?q=new%20query",
  ]);
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
  assert.match(location.assigned[0], /splusFind=lease%20debt/);

  await assert.rejects(
    adapter.runSearch("lease debt", { scope: "practice" }),
    (error) => error.code === "SEARCH_INPUT_NOT_FOUND"
  );
  assert.equal(location.assigned.length, 1);
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

test("online search waits for a changed result set and a confirmed practice preset", async () => {
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
  assert.equal(result.scopeApplied, true);
  assert.equal(result.count, 1);
  assert.equal(result.items[0].title, "Filtered practice result");
  assert.deepEqual(input.events, ["input", "change"]);
  assert.match(practicePreset.className, /selected/);
  assert.equal(staleSearchAccepted, false);
});

test("online search accepts an unchanged result set only after loading completes", async () => {
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
  const signature = `${link.href}\n${link.innerText}`;

  const pending = adapter._waitForSearchUpdate(signature);
  resultRoot.loading = true;
  notify(resultRoot);
  setTimeout(() => {
    resultRoot.loading = false;
    notify(resultRoot);
  }, 200);

  const items = await pending;
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Same result");
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
