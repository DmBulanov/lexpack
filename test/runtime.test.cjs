const assert = require("node:assert/strict");
const test = require("node:test");

const {
  consAssertFormatSupported,
  consIsConsultantHost,
  consIsConsultantPageUrl,
  consMatchesNativeDownload,
  consNormalizeDocumentUrl,
  consProvenanceUrl,
  consRedactUrl,
  consSanitizeFolder,
} = require("../extension/shared/runtime.js");

test("Consultant host checks enforce an HTTPS hostname boundary", () => {
  assert.equal(consIsConsultantHost("consultant.ru"), true);
  assert.equal(consIsConsultantHost("online.consultant.ru"), true);
  assert.equal(consIsConsultantHost("evilconsultant.ru"), false);
  assert.equal(consIsConsultantHost("consultant.ru.evil.example"), false);
  assert.equal(consIsConsultantPageUrl("https://online.consultant.ru/path"), true);
  assert.equal(consIsConsultantPageUrl("http://online.consultant.ru/path"), false);
});

test("document URLs are constrained by adapter and reject credentials", () => {
  assert.equal(
    consNormalizeDocumentUrl(
      "https://www.consultant.ru/document/cons_doc_LAW_1/",
      "public-site"
    ),
    "https://www.consultant.ru/document/cons_doc_LAW_1/"
  );
  assert.match(
    consNormalizeDocumentUrl(
      "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=LAW&n=1",
      "online-app"
    ),
    /req=doc/
  );
  assert.throws(
    () => consNormalizeDocumentUrl("https://evil.example/document/1", "public-site"),
    /HTTPS-ссылки/
  );
  assert.throws(
    () => consNormalizeDocumentUrl("https://login.consultant.ru/?req=doc", "online-app"),
    /не ведёт на документ/
  );
  assert.throws(
    () => consNormalizeDocumentUrl("https://user:pass@online.consultant.ru/?req=doc", "online-app"),
    /учётные данные/
  );
});

test("format capabilities reject silent public-site fallback", () => {
  assert.equal(consAssertFormatSupported("public-site", "html"), "html");
  assert.throws(
    () => consAssertFormatSupported("public-site", "docx"),
    /DOCX недоступен/
  );
  assert.equal(consAssertFormatSupported("online-app", "docx"), "docx");
});

test("folder sanitization removes traversal, reserved names, and invalid characters", () => {
  assert.equal(consSanitizeFolder("../Практика/2026"), "Практика/2026");
  assert.equal(consSanitizeFolder("CON/дело:*"), "_CON/дело__");
  assert.equal(consSanitizeFolder("../../"), "ConsExport");
});

test("report URLs redact session-bearing parameters and fragments", () => {
  const redacted = consProvenanceUrl(
    "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&rnd=secret&client_secret=abc&jwt=xyz&state=opaque&n=1#part"
  );
  assert.match(redacted, /req=doc/);
  assert.match(redacted, /n=1/);
  assert.doesNotMatch(redacted, /rnd|secret|abc|jwt|xyz|state|opaque|#part/);
  assert.equal(
    consProvenanceUrl("https://www.consultant.ru/document/cons_doc_LAW_1/?token=x&q=y#part"),
    "https://www.consultant.ru/document/cons_doc_LAW_1/"
  );
  assert.equal(consRedactUrl("https://www.consultant.ru/document/1/?token=x"), consProvenanceUrl("https://www.consultant.ru/document/1/?token=x"));
});

test("native download matching rejects unrelated time, format, host, and document", () => {
  const current = {
    downloadKind: "native",
    downloadStartedAt: Date.parse("2026-07-18T10:00:00.000Z"),
    expectedFilename: "01 - Документ.pdf",
    sourceUrl: "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=LAW&n=42&rnd=secret",
  };
  const candidate = {
    startTime: "2026-07-18T10:00:01.000Z",
    filename: "/Downloads/document.pdf",
    url: "https://online.consultant.ru/download/file",
    referrer: "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=LAW&n=42",
  };

  assert.equal(consMatchesNativeDownload(candidate, current), true);
  assert.equal(
    consMatchesNativeDownload(
      { ...candidate, byExtensionId: "other-extension" },
      { ...current, extensionId: "cons-export-extension" }
    ),
    false
  );
  assert.equal(
    consMatchesNativeDownload(
      { ...candidate, referrer: "", byExtensionId: "extension-id" },
      { ...current, extensionId: "extension-id" }
    ),
    false
  );
  assert.equal(consMatchesNativeDownload({ ...candidate, referrer: "" }, current), false);
  assert.equal(
    consMatchesNativeDownload(
      {
        ...candidate,
        referrer: "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&rnd=other",
      },
      current
    ),
    false
  );
  assert.equal(
    consMatchesNativeDownload(
      {
        ...candidate,
        referrer: "https://www.consultant.ru/search/?base=LAW&n=42",
      },
      current
    ),
    false
  );
  assert.equal(
    consMatchesNativeDownload(
      {
        ...candidate,
        referrer: "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=LAW",
      },
      { ...current, sourceUrl: "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=LAW" }
    ),
    false
  );
  assert.equal(
    consMatchesNativeDownload({ ...candidate, filename: "/Downloads/document.docx" }, current),
    false
  );
  assert.equal(
    consMatchesNativeDownload({ ...candidate, startTime: "2026-07-18T10:00:31.000Z" }, current),
    false
  );
  assert.equal(
    consMatchesNativeDownload(
      { ...candidate, url: "https://evil.example/file", referrer: "https://evil.example/doc" },
      current
    ),
    false
  );
  assert.equal(
    consMatchesNativeDownload(
      {
        ...candidate,
        referrer: "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=LAW&n=99",
      },
      current
    ),
    false
  );
});
