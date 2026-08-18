const { getSettings } = require("./settingsService");

function getSystemTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function isValidTimeZone(timeZone) {
  if (!timeZone || typeof timeZone !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch (_e) {
    return false;
  }
}

// The timezone timestamps are generated in: the OS timezone when
// "Use System Time" is enabled (default), otherwise the configured one.
function getActiveTimeZone() {
  const time = getSettings().time || {};
  if (time.useSystemTime || !isValidTimeZone(time.timeZone)) {
    return getSystemTimeZone();
  }
  return time.timeZone;
}

function listTimeZones() {
  if (typeof Intl.supportedValuesOf === "function") {
    return Intl.supportedValuesOf("timeZone");
  }
  return [getSystemTimeZone()];
}

// Calendar/wall-clock parts of `date` in the active timezone.
function getZonedParts(date = new Date(), timeZone = getActiveTimeZone()) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return parts;
}

// yyyyMMdd_HHmmss — used for Node-generated artifact filenames.
function timestampForFile(date = new Date()) {
  const p = getZonedParts(date);
  return `${p.year}${p.month}${p.day}_${p.hour}${p.minute}${p.second}`;
}

// dd/MM/yyyy HH:mm:ss — the app's display convention, in the active timezone.
function formatDisplayTimestamp(date = new Date()) {
  const p = getZonedParts(date);
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

module.exports = {
  getSystemTimeZone,
  isValidTimeZone,
  getActiveTimeZone,
  listTimeZones,
  getZonedParts,
  timestampForFile,
  formatDisplayTimestamp,
};
