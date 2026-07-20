#!/usr/bin/env node
import { buildVariant, resolveVariantIds } from "./variant-lib.mjs";

const ids = resolveVariantIds(process.argv[2] || "all");
for (const id of ids) {
  const { config, target } = await buildVariant(id);
  console.log(`built ${config.manifest.versionName}: ${target}`);
}
