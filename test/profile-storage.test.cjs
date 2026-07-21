const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CONS_DEFAULT_PROFILE_ID,
  consCreateDefaultProfile,
  consDeleteProfileState,
  consMigrateProfileState,
  consUpsertProfileState,
} = require("../extension/shared/profile-storage.js");

const NOW = Date.UTC(2026, 6, 21, 10, 0, 0);

test("legacy format and folder migrate into the built-in compatible profile", () => {
  const state = consMigrateProfileState(null, {
    lastFormat: "pdf",
    downloadFolder: "Работа/Акты",
    settingsSchemaVersion: 2,
  }, NOW);
  assert.equal(state.selectedProfileId, CONS_DEFAULT_PROFILE_ID);
  assert.equal(state.profiles[0].format, "pdf");
  assert.equal(state.profiles[0].folderTemplate, "Работа/Акты");
  assert.equal(state.profiles[0].filenameTemplate, "{index} - {title}");
  assert.equal(state.profiles[0].builtIn, true);
});

test("missing settings produce a stable default and migrate legacy default folder names", () => {
  assert.deepEqual(
    {
      format: consCreateDefaultProfile({}, NOW).format,
      folder: consCreateDefaultProfile({}, NOW).folderTemplate,
    },
    { format: "docx", folder: "LexPack" }
  );
  assert.equal(
    consMigrateProfileState(null, {
      downloadFolder: "ConsExport",
      settingsSchemaVersion: 0,
    }, NOW).profiles[0].folderTemplate,
    "LexPack"
  );
});

test("damaged profiles are discarded and a deleted active profile falls back safely", () => {
  const state = consMigrateProfileState({
    selectedProfileId: "deleted",
    profiles: [
      { id: "default", format: "broken" },
      { id: "bad/path", name: "bad", format: "pdf" },
      {
        id: "valid",
        name: "Суды",
        format: "pdf",
        filenameTemplate: "{case}",
        folderTemplate: "LexPack",
      },
    ],
  }, {}, NOW);
  assert.equal(state.selectedProfileId, "default");
  assert.deepEqual(state.profiles.map((profile) => profile.id), ["default", "valid"]);
});

test("the built-in profile cannot be deleted and deleting an active custom profile selects it", () => {
  let state = consMigrateProfileState(null, {}, NOW);
  state = consUpsertProfileState(state, {
    id: "custom",
    name: "Клиент",
    format: "rtf",
    filenameTemplate: "{title}",
    folderTemplate: "LexPack/{query}",
  }, NOW + 1000);
  assert.equal(state.selectedProfileId, "custom");
  state = consDeleteProfileState(state, "custom");
  assert.equal(state.selectedProfileId, "default");
  assert.deepEqual(state.profiles.map((profile) => profile.id), ["default"]);
  assert.deepEqual(
    consDeleteProfileState(state, "default").profiles.map((profile) => profile.id),
    ["default"]
  );
});

test("the profile limit keeps the built-in profile and the newly selected profile", () => {
  let state = consMigrateProfileState(null, {}, NOW);
  for (let index = 0; index < 55; index += 1) {
    state = consUpsertProfileState(state, {
      id: `profile-${index}`,
      name: `Профиль ${index}`,
      format: "pdf",
      filenameTemplate: "{title}",
      folderTemplate: "LexPack",
    }, NOW + index + 1);
  }
  assert.equal(state.profiles.length, 50);
  assert.equal(state.profiles[0].id, "default");
  assert.equal(state.selectedProfileId, "profile-54");
  assert.ok(state.profiles.some((profile) => profile.id === "profile-54"));
});
