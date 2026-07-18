const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const helperPath = path.join(root, "extension/shared/safe-html.js");
const workerPath = path.join(root, "extension/background/service-worker.js");
const offscreenPath = path.join(root, "extension/offscreen/sanitizer.js");
const offscreenHtmlPath = path.join(root, "extension/offscreen/sanitizer.html");
const fixturePath = path.join(root, "test/fixtures/safe-html.json");

const {
  consBuildSafeHtmlDocument,
  consSanitizeHtmlFragment,
  safeHtmlLimits,
  safeHtmlPolicy,
} = require(helperPath);
const fixtures = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const voidTags = new Set([
  "AREA",
  "BASE",
  "BR",
  "COL",
  "EMBED",
  "HR",
  "IMG",
  "INPUT",
  "LINK",
  "META",
]);

function escapeText(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value) {
  return escapeText(value).replace(/"/g, "&quot;");
}

function serializeFixtureNode(node) {
  if (node.type === "text") return escapeText(node.data);
  if (node.type === "comment") return `<!--${node.data}-->`;
  const tag = node.tag.toLowerCase();
  const attributes = Object.entries(node.attributes || {})
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join("");
  const open = `<${tag}${attributes}>`;
  if (voidTags.has(node.tag.toUpperCase())) return open;
  return `${open}${serializeFixtureNodes(node.children || [])}</${tag}>`;
}

function serializeFixtureNodes(nodes) {
  return nodes.map(serializeFixtureNode).join("");
}

function appendNode(node) {
  if (node.nodeType === 11) {
    this.childNodes.push(...node.childNodes);
    node.childNodes.length = 0;
    return;
  }
  this.childNodes.push(node);
}

function inputNode(fixtureNode) {
  if (fixtureNode.type === "text") return { nodeType: 3, data: fixtureNode.data };
  if (fixtureNode.type === "comment") return { nodeType: 8, data: fixtureNode.data };
  return {
    nodeType: 1,
    tagName: fixtureNode.tag.toUpperCase(),
    attributes: Object.entries(fixtureNode.attributes || {}).map(([name, value]) => ({
      name,
      value,
    })),
    childNodes: (fixtureNode.children || []).map(inputNode),
  };
}

function outputFragment() {
  return { nodeType: 11, childNodes: [], append: appendNode };
}

function serializeOutputNode(node) {
  if (node.nodeType === 3) return escapeText(node.data);
  if (node.nodeType === 11) return node.childNodes.map(serializeOutputNode).join("");
  const tag = node.tagName.toLowerCase();
  const attributes = node.attributes
    .map(({ name, value }) => ` ${name}="${escapeAttribute(value)}"`)
    .join("");
  const open = `<${tag}${attributes}>`;
  if (voidTags.has(node.tagName)) return open;
  return `${open}${node.childNodes.map(serializeOutputNode).join("")}</${tag}>`;
}

function outputElement(tag) {
  const element = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    attributes: [],
    childNodes: [],
    append: appendNode,
    setAttribute(name, value) {
      const existing = this.attributes.find((attribute) => attribute.name === name);
      if (existing) existing.value = String(value);
      else this.attributes.push({ name, value: String(value) });
    },
  };
  Object.defineProperty(element, "innerHTML", {
    get() {
      return element.childNodes.map(serializeOutputNode).join("");
    },
  });
  return element;
}

function fixtureDocument(fixture) {
  const unsafeHtml = serializeFixtureNodes(fixture.nodes);
  return {
    unsafeHtml,
    document: {
      createTextNode(data) {
        return { nodeType: 3, data: String(data) };
      },
      createDocumentFragment: outputFragment,
      createElement(tag) {
        if (tag.toLowerCase() !== "template") return outputElement(tag);
        const template = { content: outputFragment() };
        Object.defineProperty(template, "innerHTML", {
          set(value) {
            assert.equal(value, unsafeHtml, "sanitizer must parse the exact supplied source");
            template.content.childNodes = fixture.nodes.map(inputNode);
          },
        });
        return template;
      },
    },
  };
}

function renderFixture(fixture) {
  const fake = fixtureDocument(fixture);
  const html = consSanitizeHtmlFragment(fake.unsafeHtml, fake.document);
  const exported = consBuildSafeHtmlDocument(
    "Тестовый документ",
    fake.unsafeHtml,
    "https://online.consultant.ru/document/test",
    fake.document
  );
  return { html, exported, unsafeHtml: fake.unsafeHtml };
}

test("every HTML sink uses the offscreen static sanitizer boundary", () => {
  const worker = fs.readFileSync(workerPath, "utf8");
  const offscreen = fs.readFileSync(offscreenPath, "utf8");
  const offscreenHtml = fs.readFileSync(offscreenHtmlPath, "utf8");

  assert.match(worker, /offscreenRequest\("SANITIZE_HTML"/);
  assert.match(worker, /async function buildExportBody\(/);
  assert.doesNotMatch(worker, /format\s*===\s*["']html["']\s*\?\s*[^:]+\.html/);
  assert.match(offscreen, /consBuildSafeHtmlDocument\(/);
  assert.match(offscreenHtml, /\.\.\/shared\/safe-html\.js/);
});

test("the policy permits only declared markup, attributes, and inert raster data URLs", () => {
  const allowedTags = new Set(safeHtmlPolicy.allowedTags);
  const droppedTags = new Set(safeHtmlPolicy.dropWithChildren);
  const attributeLocations = Object.entries(safeHtmlPolicy.attributesByTag).flatMap(
    ([tag, names]) => names.map((name) => ({ tag, name }))
  );
  const urlNames = new Set([
    "action",
    "background",
    "cite",
    "formaction",
    "href",
    "poster",
    "src",
    "srcset",
    "xlink:href",
  ]);

  assert.equal(new Set(safeHtmlPolicy.allowedTags).size, safeHtmlPolicy.allowedTags.length);
  assert.ok([...droppedTags].every((tag) => !allowedTags.has(tag)));
  assert.ok(droppedTags.has("HEAD") && droppedTags.has("SCRIPT") && droppedTags.has("SVG"));
  assert.deepEqual(
    attributeLocations.filter(({ name }) => urlNames.has(name)),
    [{ tag: "IMG", name: "src" }]
  );
  assert.deepEqual(safeHtmlPolicy.imageSource.mediaTypes, [
    "image/png",
    "image/gif",
    "image/jpeg",
    "image/webp",
  ]);
});

test("serialization emits static sanitized HTML with restrictive CSP and no renderer script", () => {
  const fake = fixtureDocument(fixtures.adversarialMarkup);
  const exported = consBuildSafeHtmlDocument(
    "Title </title><script>fixture marker</script>",
    fake.unsafeHtml,
    'https://online.consultant.ru/document/test?q=<fixture>&quote="yes"',
    fake.document
  );

  assert.match(exported, /default-src &#39;none&#39;/);
  assert.match(exported, /img-src data:/);
  assert.match(exported, /connect-src &#39;none&#39;/);
  assert.match(exported, /form-action &#39;none&#39;/);
  assert.match(exported, /base-uri &#39;none&#39;/);
  assert.doesNotMatch(exported, /<script\b/i);
  assert.doesNotMatch(exported, /<template\b/i);
  const main = exported.match(/<main id="cons-export-content">([\s\S]*?)<\/main>/)?.[1] || "";
  assert.doesNotMatch(main, /fixture marker/);
  assert.doesNotMatch(exported, /<title>Title <\/title><script>/);
  assert.match(exported, /q=&lt;fixture&gt;&amp;quote=&quot;yes&quot;/);
  assert.match(exported, /<main id="cons-export-content"><div class="kept"/);
});

test("the static sanitizer preserves supported legal-document formatting", () => {
  const result = renderFixture(fixtures.legitimateFormatting);

  assert.equal(result.html, fixtures.legitimateFormatting.expectedHtml);
  assert.match(result.exported, /<h1>Заголовок документа<\/h1>/);
  assert.match(result.html, /<strong>жирный<\/strong>/);
  assert.match(result.html, /<ol reversed="" start="3" type="I">/);
  assert.match(result.html, /<table>/);
  assert.match(result.html, /<img [^>]*src="data:image\/png;base64,/);
  assert.doesNotMatch(result.html, /href=/);
});

test("the static sanitizer rejects active markup, undeclared attributes, and URL forms", () => {
  const result = renderFixture(fixtures.adversarialMarkup);

  assert.equal(result.html, fixtures.adversarialMarkup.expectedHtml);
  assert.doesNotMatch(
    result.html,
    /<(?:script|style|iframe|object|embed|svg|math|template|noscript|head|title|base|meta|link)\b/i
  );
  assert.doesNotMatch(
    result.html,
    /\s(?:on[a-z]+|style|id|name|href|cite|srcset|xlink:href|action|formaction)=/i
  );
  assert.doesNotMatch(result.html, /(?:https?|javascript|data:text|data:image\/svg\+xml):/i);
  assert.match(result.html, /src="data:image\/gif;base64,/);
  assert.doesNotMatch(result.html, /(?:script|style|frame|object|svg|math|template) marker/);
});

test("the sanitizer rejects oversized source before DOM expansion", () => {
  const oversized = "a".repeat(safeHtmlLimits.maxSourceBytes + 1);
  assert.throws(
    () => consSanitizeHtmlFragment(oversized, fixtureDocument({ nodes: [] }).document),
    /лимит 16 МБ/
  );
});
