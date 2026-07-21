/** Pure export-profile model, migration, and storage-state operations. */
(function () {
  const runtimeApi =
    typeof module !== "undefined" && module.exports
      ? require("./runtime.js")
      : globalThis;

  const CONS_PROFILE_SCHEMA_VERSION = 1;
  const CONS_PROFILE_STATE_KEY = "exportProfileState";
  const CONS_DEFAULT_PROFILE_ID = "default";
  const CONS_DEFAULT_FILENAME_TEMPLATE = "{index} - {title}";
  const CONS_PROFILE_COLLISION_POLICY = "ordered-suffix";
  const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/i;
  const ALLOWED_FORMATS = new Set(runtimeApi.CONS_FORMATS || ["docx", "pdf", "rtf", "txt", "html"]);

  function isoOr(value, fallback) {
    return Number.isFinite(Date.parse(value || ""))
      ? new Date(value).toISOString()
      : fallback;
  }

  function cleanText(value, fallback, maximumLength) {
    const cleaned = String(value || "")
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maximumLength);
    return cleaned || fallback;
  }

  function cleanTemplate(value, fallback) {
    const template = String(value || "")
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, 300);
    return template || fallback;
  }

  function consCreateDefaultProfile(legacy = {}, now = Date.now()) {
    const timestamp = new Date(now).toISOString();
    const requestedFormat = String(legacy.lastFormat || "docx").toLowerCase();
    return {
      schemaVersion: CONS_PROFILE_SCHEMA_VERSION,
      id: CONS_DEFAULT_PROFILE_ID,
      name: "По умолчанию",
      format: ALLOWED_FORMATS.has(requestedFormat) ? requestedFormat : "docx",
      filenameTemplate: CONS_DEFAULT_FILENAME_TEMPLATE,
      folderTemplate: runtimeApi.consMigrateStoredDownloadFolder(
        legacy.downloadFolder,
        legacy.settingsSchemaVersion
      ),
      collisionPolicy: CONS_PROFILE_COLLISION_POLICY,
      builtIn: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  function consNormalizeProfile(input, options = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("Повреждённый профиль выгрузки");
    }
    const nowIso = new Date(options.now ?? Date.now()).toISOString();
    const builtIn = options.builtIn === true || input.id === CONS_DEFAULT_PROFILE_ID;
    const id = builtIn ? CONS_DEFAULT_PROFILE_ID : String(input.id || "").trim();
    if (!PROFILE_ID_PATTERN.test(id)) throw new Error("Некорректный id профиля");

    const format = String(input.format || "").toLowerCase();
    if (!ALLOWED_FORMATS.has(format)) throw new Error("Некорректный формат профиля");
    if (input.collisionPolicy && input.collisionPolicy !== CONS_PROFILE_COLLISION_POLICY) {
      throw new Error("Некорректная политика коллизий");
    }

    const createdAt = isoOr(input.createdAt, nowIso);
    return {
      schemaVersion: CONS_PROFILE_SCHEMA_VERSION,
      id,
      name: builtIn
        ? "По умолчанию"
        : cleanText(input.name, "Профиль", 80),
      format,
      filenameTemplate: cleanTemplate(
        input.filenameTemplate,
        CONS_DEFAULT_FILENAME_TEMPLATE
      ),
      folderTemplate: cleanTemplate(
        input.folderTemplate,
        runtimeApi.CONS_DEFAULT_DOWNLOAD_FOLDER
      ),
      collisionPolicy: CONS_PROFILE_COLLISION_POLICY,
      builtIn,
      createdAt,
      updatedAt: isoOr(input.updatedAt, createdAt),
    };
  }

  function consMigrateProfileState(rawState, legacy = {}, now = Date.now()) {
    const profiles = [];
    const seen = new Set();
    const sourceProfiles = Array.isArray(rawState?.profiles) ? rawState.profiles : [];
    const storedDefault = sourceProfiles.find((profile) => profile?.id === CONS_DEFAULT_PROFILE_ID);

    if (storedDefault) {
      try {
        const normalized = consNormalizeProfile(storedDefault, { builtIn: true, now });
        profiles.push(normalized);
        seen.add(normalized.id);
      } catch {
        // A damaged built-in profile is replaced from legacy/default settings below.
      }
    }
    if (!seen.has(CONS_DEFAULT_PROFILE_ID)) {
      profiles.push(consCreateDefaultProfile(legacy, now));
      seen.add(CONS_DEFAULT_PROFILE_ID);
    }

    for (const candidate of sourceProfiles) {
      if (profiles.length >= 50) break;
      if (candidate?.id === CONS_DEFAULT_PROFILE_ID) continue;
      try {
        const profile = consNormalizeProfile(candidate, { now });
        if (seen.has(profile.id)) continue;
        profiles.push(profile);
        seen.add(profile.id);
      } catch {
        // Storage is untrusted; one damaged custom profile must not break all profiles.
      }
    }

    const requestedId = String(rawState?.selectedProfileId || CONS_DEFAULT_PROFILE_ID);
    return {
      schemaVersion: CONS_PROFILE_SCHEMA_VERSION,
      selectedProfileId: seen.has(requestedId) ? requestedId : CONS_DEFAULT_PROFILE_ID,
      profiles,
    };
  }

  function consGetSelectedProfile(state) {
    const normalized = consMigrateProfileState(state);
    return normalized.profiles.find(
      (profile) => profile.id === normalized.selectedProfileId
    ) || normalized.profiles[0];
  }

  function consSelectProfileState(state, profileId) {
    const normalized = consMigrateProfileState(state);
    const id = String(profileId || "");
    normalized.selectedProfileId = normalized.profiles.some((profile) => profile.id === id)
      ? id
      : CONS_DEFAULT_PROFILE_ID;
    return normalized;
  }

  function consUpsertProfileState(state, candidate, now = Date.now()) {
    const normalized = consMigrateProfileState(state, {}, now);
    const existing = normalized.profiles.find((profile) => profile.id === candidate?.id);
    const profile = consNormalizeProfile(
      {
        ...candidate,
        createdAt: existing?.createdAt || candidate?.createdAt,
        updatedAt: new Date(now).toISOString(),
      },
      { builtIn: candidate?.id === CONS_DEFAULT_PROFILE_ID, now }
    );
    let nextProfiles = normalized.profiles.filter((entry) => entry.id !== profile.id);
    const insertAt = profile.builtIn ? 0 : nextProfiles.length;
    nextProfiles.splice(insertAt, 0, profile);
    if (nextProfiles.length > 50) {
      const builtInProfile = nextProfiles.find(
        (entry) => entry.id === CONS_DEFAULT_PROFILE_ID
      );
      const newestCustomProfiles = nextProfiles
        .filter((entry) => entry.id !== CONS_DEFAULT_PROFILE_ID)
        .slice(-49);
      nextProfiles = [builtInProfile, ...newestCustomProfiles].filter(Boolean);
    }
    return {
      schemaVersion: CONS_PROFILE_SCHEMA_VERSION,
      selectedProfileId: profile.id,
      profiles: nextProfiles,
    };
  }

  function consDeleteProfileState(state, profileId) {
    const normalized = consMigrateProfileState(state);
    const id = String(profileId || "");
    if (!id || id === CONS_DEFAULT_PROFILE_ID) return normalized;
    normalized.profiles = normalized.profiles.filter((profile) => profile.id !== id);
    if (normalized.selectedProfileId === id) {
      normalized.selectedProfileId = CONS_DEFAULT_PROFILE_ID;
    }
    return normalized;
  }

  function consDuplicateProfile(profile, id, now = Date.now()) {
    const source = consNormalizeProfile(profile, {
      builtIn: profile?.id === CONS_DEFAULT_PROFILE_ID,
      now,
    });
    const timestamp = new Date(now).toISOString();
    return consNormalizeProfile(
      {
        ...source,
        id,
        name: `Копия ${source.name}`,
        builtIn: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      { now }
    );
  }

  const api = {
    CONS_DEFAULT_FILENAME_TEMPLATE,
    CONS_DEFAULT_PROFILE_ID,
    CONS_PROFILE_COLLISION_POLICY,
    CONS_PROFILE_SCHEMA_VERSION,
    CONS_PROFILE_STATE_KEY,
    consCreateDefaultProfile,
    consDeleteProfileState,
    consDuplicateProfile,
    consGetSelectedProfile,
    consMigrateProfileState,
    consNormalizeProfile,
    consSelectProfileState,
    consUpsertProfileState,
  };
  Object.assign(globalThis, api);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
