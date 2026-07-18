const assert = require("node:assert/strict");
const test = require("node:test");

const {
  consAssertFormatSupported,
  consBuildOnlineSearchUrl,
  consBuildPublicSearchUrl,
  consBuildSafeDiagnosticsSnapshot,
  consIsConsultantHost,
  consIsConsultantPageUrl,
  consMatchesNativeDownload,
  consNativeDownloadDecision,
  consNormalizeDocumentUrl,
  consNormalizeJudicialInstances,
  consProvenanceUrl,
  consRedactUrl,
  consSanitizeFolder,
} = require("../extension/shared/runtime.js");

test("judicial instance selection is a closed, deduplicated allowlist", () => {
  assert.deepEqual(
    consNormalizeJudicialInstances([
      "arbitration-first",
      "evil-instance",
      "higher-courts",
      "arbitration-first",
      null,
    ]),
    ["arbitration-first", "higher-courts"]
  );
  assert.deepEqual(consNormalizeJudicialInstances("arbitration-first"), []);
});

test("copied diagnostics contain only allowlisted structural fields and closed events", () => {
  const snapshot = consBuildSafeDiagnosticsSnapshot(
    {
      hostname: "online.consultant.ru",
      page: "document",
      listCount: 1,
      url: "https://example.test/SECRET_URL",
      title: "SECRET_TITLE",
      query: "SECRET_QUERY",
      documentText: "SECRET_DOCUMENT",
    },
    [
      {
        at: "2026-07-18T10:00:00.000Z",
        code: "NM_REFERRER",
        countBucket: "1",
        filename: "SECRET_FILENAME.pdf",
      },
      {
        at: "2026-07-18T10:00:01.000Z",
        code: "RAW_SECRET_CODE",
        countBucket: "many",
      },
    ]
  );

  assert.deepEqual(snapshot, {
    page: {
      hostname: "online.consultant.ru",
      page: "document",
      listCount: 1,
    },
    downloads: [
      {
        at: "2026-07-18T10:00:00.000Z",
        code: "NM_REFERRER",
        countBucket: "1",
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET_/);
});

test("search URLs are built by the shared allowlist without stale session parameters", () => {
  const online = new URL(
    consBuildOnlineSearchUrl(
      "https://online.consultant.ru/riv/cgi/online.cgi?req=home&rnd=session&ts=old#old",
      "срок аренды"
    )
  );
  assert.equal(online.origin, "https://online.consultant.ru");
  assert.equal(online.pathname, "/riv/cgi/online.cgi");
  assert.equal(online.searchParams.get("req"), "card");
  assert.equal(online.searchParams.get("page"), "splus");
  assert.equal(online.searchParams.get("splusFind"), "срок аренды");
  assert.equal(online.searchParams.get("rnd"), "session");
  assert.equal(online.searchParams.has("ts"), false);
  assert.equal(online.hash, "#splus");

  assert.equal(
    consBuildPublicSearchUrl("аренда + неустойка"),
    "https://www.consultant.ru/search/?q=%D0%B0%D1%80%D0%B5%D0%BD%D0%B4%D0%B0+%2B+%D0%BD%D0%B5%D1%83%D1%81%D1%82%D0%BE%D0%B9%D0%BA%D0%B0"
  );
  assert.throws(
    () => consBuildOnlineSearchUrl("https://evil.example/", "test"),
    /КонсультантПлюс/
  );
});

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

  assert.deepEqual(consNativeDownloadDecision(candidate, current), {
    match: true,
    candidate: true,
    code: "NM_OK",
  });
  assert.deepEqual(
    consNativeDownloadDecision({ ...candidate, referrer: "" }, current),
    { match: false, candidate: true, code: "NM_REFERRER" }
  );
  assert.deepEqual(
    consNativeDownloadDecision(
      {
        ...candidate,
        referrer: "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=LAW&n=99",
      },
      current
    ),
    { match: false, candidate: true, code: "NM_ID_MISMATCH" }
  );
  assert.equal(
    consNativeDownloadDecision(
      { ...candidate, filename: "/Downloads/unrelated.txt" },
      current
    ).candidate,
    false
  );
});

test("native matcher exposes a closed reason table and preserves boolean parity", () => {
  const current = {
    downloadKind: "native",
    downloadStartedAt: Date.parse("2026-07-18T10:00:00.000Z"),
    expectedFilename: "SECRET_TITLE.pdf",
    sourceUrl:
      "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=LAW&n=42&token=SECRET_URL",
    extensionId: "our-extension",
  };
  const candidate = {
    startTime: "2026-07-18T10:00:01.000Z",
    filename: "/SECRET_PATH/document.pdf",
    url: "https://online.consultant.ru/download/SECRET_DOWNLOAD",
    referrer:
      "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=LAW&n=42",
    byExtensionId: "our-extension",
  };
  const cases = [
    ["NM_CONTEXT", candidate, { ...current, downloadKind: "direct" }],
    ["NM_TIME", { ...candidate, startTime: "2026-07-18T10:01:00.000Z" }, current],
    [
      "NM_ORIGIN",
      { ...candidate, url: "https://evil.example/file", referrer: "https://evil.example/doc" },
      current,
    ],
    ["NM_EXTENSION", { ...candidate, filename: "/Downloads/document.txt" }, current],
    ["NM_REFERRER", { ...candidate, referrer: "" }, current],
    ["NM_URL", candidate, { ...current, sourceUrl: "" }],
    [
      "NM_DOCUMENT",
      {
        ...candidate,
        referrer: "https://online.consultant.ru/search/?base=LAW&n=42",
      },
      current,
    ],
    [
      "NM_BASE",
      {
        ...candidate,
        referrer: "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=KAD&n=42",
      },
      current,
    ],
    [
      "NM_ID_MISSING",
      {
        ...candidate,
        referrer: "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=LAW",
      },
      {
        ...current,
        sourceUrl: "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=LAW",
      },
    ],
    [
      "NM_ID_MISMATCH",
      {
        ...candidate,
        referrer: "https://online.consultant.ru/riv/cgi/online.cgi?req=doc&base=LAW&n=99",
      },
      current,
    ],
    ["NM_OWNER", { ...candidate, byExtensionId: "other-extension" }, current],
    ["NM_OK", candidate, current],
  ];

  for (const [expectedCode, item, expected] of cases) {
    const decision = consNativeDownloadDecision(item, expected);
    assert.equal(decision.code, expectedCode);
    assert.equal(consMatchesNativeDownload(item, expected), decision.match);
    assert.deepEqual(Object.keys(decision).sort(), ["candidate", "code", "match"]);
    assert.doesNotMatch(JSON.stringify(decision), /SECRET_/);
  }
});
