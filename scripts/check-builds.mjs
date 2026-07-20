#!/usr/bin/env node
import { checkBuiltVariant, resolveVariantIds } from "./variant-lib.mjs";

const ids = resolveVariantIds(process.argv[2] || "all");
for (const id of ids) {
  const { config } = await checkBuiltVariant(id);
  console.log(`build ok: ${config.manifest.versionName}`);
}
