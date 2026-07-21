const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../safari/LexPack Safari");
const project = fs.readFileSync(
  path.join(root, "LexPack Safari.xcodeproj/project.pbxproj"),
  "utf8"
);
const controller = fs.readFileSync(
  path.join(root, "LexPack Safari/ViewController.swift"),
  "utf8"
);
const handler = fs.readFileSync(
  path.join(root, "LexPack Safari Extension/SafariWebExtensionHandler.swift"),
  "utf8"
);
const html = fs.readFileSync(
  path.join(root, "LexPack Safari/Resources/Base.lproj/Main.html"),
  "utf8"
);
const appEntitlements = fs.readFileSync(
  path.join(root, "LexPack Safari/LexPack Safari.entitlements"),
  "utf8"
);
const extensionEntitlements = fs.readFileSync(
  path.join(
    root,
    "LexPack Safari Extension/LexPack Safari Extension.entitlements"
  ),
  "utf8"
);

test("Safari containing app requests and verifies Downloads access", () => {
  assert.equal(
    project.match(/ENABLE_FILE_ACCESS_DOWNLOADS_FOLDER = readwrite;/g)?.length,
    2,
    "Debug and Release app configurations must both have Downloads read/write access"
  );
  assert.match(html, /class="check-downloads"/);
  assert.match(controller, /case "check-downloads"/);
  assert.match(controller, /NSOpenPanel\(\)/);
  assert.match(controller, /for: \.downloadsDirectory/);
  assert.match(controller, /Data\("LexPack"\.utf8\)\.write/);
  assert.match(controller, /fileManager\.removeItem\(at: probe\)/);
  assert.match(controller, /bookmarkData\(/);
  assert.match(controller, /SFSafariApplication\.dispatchMessage\(/);
  assert.match(controller, /bookmark\.base64EncodedString\(\)/);
  assert.match(handler, /resolvingBookmarkData: data/);
  assert.match(handler, /message\["downloadsBookmark"\]/);
  assert.match(handler, /DOWNLOADS_PERMISSION_REQUIRED/);
  for (const entitlements of [appEntitlements, extensionEntitlements]) {
    assert.match(entitlements, /com\.apple\.security\.files\.user-selected\.read-write/);
    assert.doesNotMatch(entitlements, /com\.apple\.security\.application-groups/);
  }
  assert.match(
    controller,
    /JSONEncoder\(\)\.encode\(message\)/,
    "Status text must be encoded as a valid top-level JSON string"
  );
});
