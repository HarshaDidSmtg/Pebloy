const path = require("path");
const { randomUUID } = require("crypto");
const { readJson, writeJson, ensureJsonFile } = require("./storage");
const { encryptPassword, decryptPassword } = require("./secretStore");

const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, "..", "..", "data");
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
  let secretError = null;
  if (profile.authenticationType === "Sql") {
    const missingPasswordMessage = `No stored password found for profile "${profile.profileLabel}". Re-enter and save the password.`;

    if (!profile.secretReference) {
      // Exporting/importing a profile carries the reference but never the secret itself.
      secretError = missingPasswordMessage;
    } else {
      const secrets = readJson(SECRET_FILE, {});
      const cipher = secrets[profile.secretReference];
      if (!cipher) {
        secretError = missingPasswordMessage;
      } else {
        try {
          password = decryptPassword(cipher);
        } catch (err) {
          // DPAPI is scoped to the current Windows user and machine, so a copied or
          // migrated secrets.json decrypts to nothing rather than the wrong password.
          secretError = `Stored password for profile "${profile.profileLabel}" could not be decrypted (${err.message}). Re-enter and save the password.`;
        }
      }
    }

    if (secretError) {
      console.warn(`[profileService] ${secretError}`);
    }
  }

  return {
    ...profile,
    password,
    secretError,
  };
}

function validate(payload, existingId = null) {
  const profiles = readJson(PROFILE_FILE, []);
  const authenticationType = normalizeAuthenticationType(payload.authenticationType);
  if (payload.groupName != null && (typeof payload.groupName !== "string" || payload.groupName.trim().length > 80 || /[\r\n\t]/.test(payload.groupName))) {
    throw new Error("Connection group must be text of at most 80 characters without line breaks or tabs.");
  }

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
    groupName: payload.groupName?.trim() || null,
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
    secretReference = null;
  }

  if (authenticationType === "Sql" && payload.password) {
    secretReference = randomUUID();
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
    groupName: payload.groupName === undefined ? current.groupName || null : payload.groupName?.trim() || null,
    updatedAt: new Date().toISOString(),
  };

  // Write secrets first — if the profile write fails afterward, the secret is an orphan
  // (benign) rather than the profile referencing a key that was never written (broken).
  writeJson(SECRET_FILE, secrets);
  profiles[index] = updated;
  writeJson(PROFILE_FILE, profiles);
  if (current.secretReference && current.secretReference !== secretReference) {
    delete secrets[current.secretReference];
    try { writeJson(SECRET_FILE, secrets); }
    catch (_error) { console.warn("[profileService] Profile saved; obsolete encrypted credential cleanup will need to be retried."); }
  }
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
