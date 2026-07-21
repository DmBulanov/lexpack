#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { buildVariant, checkBuiltVariant, ROOT } from "./variant-lib.mjs";

if (process.platform !== "darwin") {
  throw new Error("The LexPack Safari app can be built only on macOS with Xcode");
}

await buildVariant("safari");
await checkBuiltVariant("safari");

const project = path.join(
  ROOT,
  "safari",
  "LexPack Safari",
  "LexPack Safari.xcodeproj"
);
const derivedData = path.join(ROOT, "build", "safari-derived");
const result = spawnSync(
  "xcodebuild",
  [
    "-quiet",
    "-project",
    project,
    "-scheme",
    "LexPack Safari",
    "-configuration",
    "Debug",
    "-derivedDataPath",
    derivedData,
    "CODE_SIGNING_ALLOWED=NO",
    "build",
  ],
  { cwd: ROOT, encoding: "utf8" }
);

if (result.status !== 0) {
  throw new Error(
    `xcodebuild failed\n${result.stdout || ""}${result.stderr || ""}`
  );
}

const app = path.join(
  derivedData,
  "Build",
  "Products",
  "Debug",
  "LexPack Safari.app"
);
console.log(`Safari app compile check passed: ${app}`);
