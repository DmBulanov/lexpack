/** Pure selected-item export planning and immutable planned-path projection. */
(function () {
  const metadataApi =
    typeof module !== "undefined" && module.exports
      ? require("./metadata-parser.js")
      : globalThis;
  const profileApi =
    typeof module !== "undefined" && module.exports
      ? require("./profile-storage.js")
      : globalThis;
  const templateApi =
    typeof module !== "undefined" && module.exports
      ? require("./template-engine.js")
      : globalThis;
  const filenameApi =
    typeof module !== "undefined" && module.exports
      ? require("./filename.js")
      : globalThis;

  const CONS_EXPORT_PLAN_SCHEMA_VERSION = 1;
  const MAX_EXPORT_ITEMS = 200;

  function normalizedTitle(value, fallback) {
    return String(value || fallback)
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 500) || fallback;
  }

  function normalizedCollection(collection = {}, sourceCount = 0) {
    const total = Number(collection.total);
    return {
      source: collection.source === "search" ? "search" : "current-list",
      scope: String(collection.scope || "current-list").slice(0, 200),
      total: Number.isInteger(total) && total >= sourceCount ? total : sourceCount,
      totalKnown: collection.totalKnown === true,
      truncated: collection.truncated === true,
      createdAt: Number.isFinite(Date.parse(collection.createdAt || ""))
        ? new Date(collection.createdAt).toISOString()
        : null,
    };
  }

  function templateContext(item, metadata, query, exportIndex, total, format) {
    return {
      index: exportIndex,
      total,
      title: item.originalTitle,
      query,
      instance: item.instanceLabel || item.instance || "",
      date: metadata.date,
      court: metadata.court,
      case: metadata.case,
      documentType: metadata.documentType,
      format,
    };
  }

  function metadataWarnings(metadata, referencedTokens) {
    const warnings = [];
    for (const token of ["date", "court", "case", "documentType"]) {
      if (!referencedTokens.has(token)) continue;
      const field = metadata[token];
      if (field?.confidence === "ambiguous") {
        warnings.push({
          code: "AMBIGUOUS_METADATA",
          token,
          message: `Для {${token}} найдено несколько значений; компонент удалён`,
        });
      }
    }
    return warnings;
  }

  function commonFolder(items) {
    if (!items.length) return "LexPack";
    let common = String(items[0].plannedRelativeFolder || "").split("/").filter(Boolean);
    for (const item of items.slice(1)) {
      const segments = String(item.plannedRelativeFolder || "").split("/").filter(Boolean);
      common = common.filter((segment, index) => segments[index] === segment);
      if (!common.length) break;
    }
    return common.join("/") || "LexPack";
  }

  function selectionSet(value) {
    if (!Array.isArray(value)) return null;
    return new Set(value.map((entry) => Number(entry)).filter(Number.isInteger));
  }

  function consBuildExportPlan(input = {}) {
    const errors = [];
    let profile;
    try {
      profile = profileApi.consNormalizeProfile(input.profile || {}, {
        builtIn: input.profile?.id === profileApi.CONS_DEFAULT_PROFILE_ID,
      });
    } catch (error) {
      return {
        schemaVersion: CONS_EXPORT_PLAN_SCHEMA_VERSION,
        ok: false,
        errors: [{ code: "INVALID_PROFILE", message: String(error?.message || error) }],
        warnings: [],
        items: [],
        selectedCount: 0,
      };
    }

    const filenameValidation = templateApi.consValidateTemplate(
      profile.filenameTemplate,
      "filename"
    );
    const folderValidation = templateApi.consValidateTemplate(
      profile.folderTemplate,
      "folder"
    );
    errors.push(...filenameValidation.errors, ...folderValidation.errors);

    const rawSource = Array.isArray(input.items) ? input.items : [];
    const source = rawSource.slice(0, MAX_EXPORT_ITEMS);
    const selected = selectionSet(input.selectedSourceIndexes);
    const selectedItems = source
      .map((item, offset) => ({
        raw: item || {},
        sourceIndex: Number.isInteger(Number(item?.sourceIndex ?? item?.index))
          ? Number(item?.sourceIndex ?? item?.index)
          : offset + 1,
        offset,
      }))
      .filter(({ raw, sourceIndex }) =>
        selected ? selected.has(sourceIndex) : raw.selected !== false
      );
    if (!selectedItems.length) {
      errors.push({ code: "NO_SELECTED_ITEMS", message: "Выберите хотя бы один документ" });
    }
    if (rawSource.length > MAX_EXPORT_ITEMS) {
      errors.push({ code: "ITEM_LIMIT", message: "Допустимо не более 200 документов" });
    }

    const query = String(input.query || "").replace(/\s+/gu, " ").trim().slice(0, 2000);
    const referencedTokens = new Set([
      ...filenameValidation.tokens,
      ...folderValidation.tokens,
    ]);
    const planned = [];
    if (!errors.length) {
      selectedItems.forEach(({ raw, sourceIndex }, selectedOffset) => {
        const exportIndex = selectedOffset + 1;
        const originalTitle = normalizedTitle(
          raw.originalTitle || raw.title,
          `document-${sourceIndex}`
        );
        const normalizedItem = { ...raw, originalTitle, title: originalTitle };
        const metadata = metadataApi.consNormalizeDocumentMetadata(normalizedItem);
        const context = templateContext(
          normalizedItem,
          metadata,
          query,
          exportIndex,
          selectedItems.length,
          profile.format
        );
        const folder = templateApi.consRenderFolderTemplate(profile.folderTemplate, context);
        const filename = templateApi.consRenderFilenameTemplate(
          profile.filenameTemplate,
          context,
          profile.format
        );
        if (!folder.ok || !filename.ok) {
          errors.push(...folder.errors, ...filename.errors);
          return;
        }
        const warnings = [
          ...folder.warnings,
          ...filename.warnings,
          ...metadataWarnings(metadata, referencedTokens),
        ];
        const plannedRelativePath = `${folder.folder}/${filename.filename}`;
        if (filenameApi.consUtf8Length(plannedRelativePath) > 240) {
          warnings.push({
            code: "LONG_RELATIVE_PATH",
            message: "Итоговый относительный путь длиннее 240 байт",
          });
        }
        planned.push({
          exportIndex,
          sourceIndex,
          selected: true,
          originalTitle,
          sourceUrl: String(raw.sourceUrl || raw.url || "").slice(0, 4096),
          instance: raw.instance || null,
          instanceLabel: raw.instanceLabel || null,
          metadata,
          plannedRelativeFolder: folder.folder,
          plannedFilename: filename.filename,
          plannedRelativePath,
          expectedFilename: filename.filename,
          warnings,
          cleanupRulesApplied: {
            folder: folder.cleanupRulesApplied,
            filename: filename.cleanupRulesApplied,
          },
          collisionResolution: { type: "none", internal: false, external: false },
        });
      });
    }

    const collided = templateApi.consResolvePathCollisions(planned).map((item) => {
      if (!item.collisionResolution.internal) return item;
      return {
        ...item,
        warnings: [
          ...item.warnings,
          {
            code: "INTERNAL_COLLISION_RESOLVED",
            message: `Имя изменено на «${item.plannedFilename}» из-за коллизии внутри плана`,
          },
        ],
      };
    });
    const warnings = collided.flatMap((item) =>
      item.warnings.map((warning) => ({ ...warning, exportIndex: item.exportIndex }))
    );
    const collection = normalizedCollection(input.collection, source.length);
    return {
      schemaVersion: CONS_EXPORT_PLAN_SCHEMA_VERSION,
      ok: errors.length === 0,
      errors,
      warnings,
      adapter: String(input.adapter || "online-app"),
      query,
      format: profile.format,
      profileSnapshot: structuredClone(profile),
      collection,
      sourceCount: source.length,
      selectedCount: collided.length,
      reportRelativeFolder: commonFolder(collided),
      createdAt: new Date(input.now ?? Date.now()).toISOString(),
      items: collided,
    };
  }

  function consRebuildExportPlan(plan = {}) {
    if (!plan || typeof plan !== "object" || !Array.isArray(plan.items)) {
      return consBuildExportPlan({});
    }
    return consBuildExportPlan({
      adapter: plan.adapter,
      query: plan.query,
      profile: plan.profileSnapshot,
      collection: plan.collection,
      items: plan.items.map((item) => ({
        sourceIndex: item.sourceIndex,
        title: item.originalTitle,
        url: item.sourceUrl,
        instance: item.instance,
        instanceLabel: item.instanceLabel,
        metadata: item.metadata,
      })),
      selectedSourceIndexes: plan.items.map((item) => item.sourceIndex),
      now: Date.parse(plan.createdAt || "") || Date.now(),
    });
  }

  const api = {
    CONS_EXPORT_PLAN_SCHEMA_VERSION,
    consBuildExportPlan,
    consRebuildExportPlan,
  };
  Object.assign(globalThis, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
