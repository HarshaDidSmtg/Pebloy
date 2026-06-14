const path = require("path");
const { randomUUID } = require("crypto");
const { readJson, writeJson, ensureJsonFile } = require("./storage");
const { encryptPassword, decryptPassword } = require("./secretStore");

const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const PROFILE_FILE = path.join(DATA_DIR, "profiles.json");
const SECRET_FILE = path.join(DATA_DIR, "secrets.json");

function normalizeAuthenticationType(rawType) {
  const value = String(rawType || "").trim().toLowerCase();
  if (value === "sql" || value === "sqlauth" || value === "sqlauthentication") {
    return "Sql";
  }
  if (value === "windows" || value === "window") {
    return "Windows";
  }
  return null;
}

function init() {
  ensureJsonFile(PROFILE_FILE, []);
  ensureJsonFile(SECRET_FILE, {});
}

function listProfiles() {
  init();
  const profiles = readJson(PROFILE_FILE, []);
  return profiles.map((p) => ({
    ...p,
    hasSecret: Boolean(p.secretReference),
    passwordSet: Boolean(p.secretReference),
  }));
}

function getProfile(profileId) {
  init();
  const profiles = readJson(PROFILE_FILE, []);
  return profiles.find((p) => p.id === profileId) || null;
}

function getProfileWithSecret(profileId) {
  const profile = getProfile(profileId);
  if (!profile) {
    return null;
  }

  let password = null;
  if (profile.authenticationType === "Sql" && profile.secretReference) {
    const secrets = readJson(SECRET_FILE, {});
    const cipher = secrets[profile.secretReference];
    if (cipher) {
      try {
        password = decryptPassword(cipher);
      } catch (_err) {
        password = null;
      }
    }
  }

  return {
    ...profile,
    password,
  };
}

function validate(payload, existingId = null) {
  const profiles = readJson(PROFILE_FILE, []);
  const authenticationType = normalizeAuthenticationType(payload.authenticationType);

  if (!payload.profileLabel || !payload.serverName || !payload.databaseName || !authenticationType) {
    throw new Error("ProfileLabel, ServerName, DatabaseName, and AuthenticationType are required.");
  }

  const duplicate = profiles.find(
    (p) => p.profileLabel.toLowerCase() === payload.profileLabel.toLowerCase() && p.id !== existingId
  );

  if (duplicate) {
    throw new Error("ProfileLabel must be unique.");
  }

  if (authenticationType === "Sql" && !payload.username) {
    throw new Error("Username is required for SQL Authentication.");
  }

  return authenticationType;
}

function createProfile(payload) {
  init();
  const authenticationType = validate(payload);

  const profiles = readJson(PROFILE_FILE, []);
  const secrets = readJson(SECRET_FILE, {});

  const id = randomUUID();
  const hasPassword = authenticationType === "Sql" && Boolean(payload.password);
  const secretReference = hasPassword ? randomUUID() : null;

  if (secretReference) {
    secrets[secretReference] = encryptPassword(payload.password);
    writeJson(SECRET_FILE, secrets);
  }

  const now = new Date().toISOString();
  const profile = {
    id,
    profileLabel: payload.profileLabel.trim(),
    serverName: payload.serverName.trim(),
    databaseName: payload.databaseName.trim(),
    authenticationType,
    username: authenticationType === "Sql" ? payload.username?.trim() || null : null,
    secretReference,
    environmentTag: payload.environmentTag?.trim() || null,
    createdAt: now,
    updatedAt: now,
  };

  profiles.push(profile);
  writeJson(PROFILE_FILE, profiles);
  return profile;
}

function updateProfile(profileId, payload) {
  init();
  const profiles = readJson(PROFILE_FILE, []);
  const secrets = readJson(SECRET_FILE, {});
  const index = profiles.findIndex((p) => p.id === profileId);

  if (index === -1) {
    throw new Error("Profile not found.");
  }

  const authenticationType = validate(payload, profileId);

  const current = profiles[index];
  let secretReference = current.secretReference;

  if (authenticationType === "Windows") {
    if (secretReference && secrets[secretReference]) {
      delete secrets[secretReference];
    }
    secretReference = null;
  }

  if (authenticationType === "Sql" && !secretReference) {
    secretReference = randomUUID();
  }

  if (authenticationType === "Sql" && payload.password) {
    secrets[secretReference] = encryptPassword(payload.password);
  }

  const updated = {
    ...current,
    profileLabel: payload.profileLabel.trim(),
    serverName: payload.serverName.trim(),
    databaseName: payload.databaseName.trim(),
    authenticationType,
    username: authenticationType === "Sql" ? payload.username?.trim() || null : null,
    secretReference,
    environmentTag: payload.environmentTag?.trim() || null,
    updatedAt: new Date().toISOString(),
  };

  // Write secrets first — if the profile write fails afterward, the secret is an orphan
  // (benign) rather than the profile referencing a key that was never written (broken).
  writeJson(SECRET_FILE, secrets);
  profiles[index] = updated;
  writeJson(PROFILE_FILE, profiles);
  return updated;
}

function deleteProfile(profileId) {
  init();
  const profiles = readJson(PROFILE_FILE, []);
  const secrets = readJson(SECRET_FILE, {});
  const index = profiles.findIndex((p) => p.id === profileId);

  if (index === -1) {
    throw new Error("Profile not found.");
  }

  const profile = profiles[index];
  if (profile.secretReference && secrets[profile.secretReference]) {
    delete secrets[profile.secretReference];
  }

  profiles.splice(index, 1);
  writeJson(PROFILE_FILE, profiles);
  writeJson(SECRET_FILE, secrets);
}

module.exports = {
  listProfiles,
  getProfile,
  getProfileWithSecret,
  createProfile,
  updateProfile,
  deleteProfile,
};
