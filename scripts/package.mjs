#!/usr/bin/env node
import { DIST_ROOT, packageVariant, resolveVariantIds, writeReleaseIndex } from "./variant-lib.mjs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";

const ids = resolveVariantIds(process.argv[2] || "all");
const archivePrefixes = ids.map((id) =>
  id === "chrome" ? "lexpack-chrome-" : "lexpack-chromium-gost-"
);
const existingDistFiles = await readdir(DIST_ROOT).catch((error) => {
  if (error?.code === "ENOENT") return [];
  throw error;
});
for (const staleName of existingDistFiles) {
  if (
    staleName === "lexpack.zip" ||
    staleName === "lexpack-chromium-gost.zip" ||
    (staleName.endsWith(".zip") && archivePrefixes.some((prefix) => staleName.startsWith(prefix)))
  ) {
    await rm(path.join(DIST_ROOT, staleName), { force: true });
  }
}

const artifacts = [];
for (const id of ids) {
  const artifact = await packageVariant(id);
  artifacts.push(artifact);
  console.log(`packaged ${artifact.versionName}: ${path.join(DIST_ROOT, artifact.file)}`);
}
await writeReleaseIndex(artifacts);
console.log(`checksums: ${path.join(DIST_ROOT, "SHA256SUMS")}`);
