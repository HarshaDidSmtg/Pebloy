const { randomUUID } = require("crypto");
const path = require("path");

const LOOPBACK_HOST = "127.0.0.1";
const LOOPBACK_ADDRESSES = new Set([LOOPBACK_HOST, "::1", `::ffff:${LOOPBACK_HOST}`]);
const LOOPBACK_HOSTNAMES = new Set([LOOPBACK_HOST, "localhost", "::1", "[::1]"]);
const FORMATTER_FILE_PATTERN = /\.(sql|txt)$/i;

function isLoopbackAddress(address) {
  return LOOPBACK_ADDRESSES.has(String(address || "").trim().toLowerCase());
}

function isLoopbackRequest(req) {
  return isLoopbackAddress(req?.socket?.remoteAddress || req?.connection?.remoteAddress || req?.ip || "");
}

// Strips the :port suffix without tripping over bracketed IPv6 literals.
function extractHostname(hostHeader) {
  const value = String(hostHeader || "").trim().toLowerCase();
  if (!value) {
    return "";
  }
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? value : value.slice(0, end + 1);
  }
  return value.split(":")[0];
}

function isLoopbackHostHeader(hostHeader) {
  return LOOPBACK_HOSTNAMES.has(extractHostname(hostHeader));
}

// DNS rebinding resolves an attacker domain to 127.0.0.1, so the socket looks local
// while Host/Origin still carry the attacker hostname. Both must be checked.
function isLoopbackOriginHeader(originHeader) {
  const value = String(originHeader || "").trim();
  if (!value) {
    return true;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" && LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase());
  } catch (_err) {
    return false;
  }
}

function isLocalBrowserRequest(req) {
  const origin = req?.headers?.origin;
  const expectedOrigin = `http://${String(req?.headers?.host || "").toLowerCase()}`;
  return (
    isLoopbackRequest(req) &&
    isLoopbackHostHeader(req?.headers?.host) &&
    isLoopbackOriginHeader(origin) &&
    (!origin || String(origin).toLowerCase() === expectedOrigin) &&
    req?.headers?.["sec-fetch-site"] !== "cross-site"
  );
}

function isFormatterSavePath(filePath) {
  const candidate = String(filePath || "").trim();
  return path.isAbsolute(candidate) && FORMATTER_FILE_PATTERN.test(candidate);
}

function isAuthorizedMutation(req, token) {
  return ["GET", "HEAD", "OPTIONS"].includes(req.method) ||
    (typeof token === "string" && token.length > 0 && req?.headers?.["x-pebloy-token"] === token);
}

function createFormatterFileAuthority() {
  const authorizedFiles = new Map();

  return {
    authorize(filePath) {
      if (!isFormatterSavePath(filePath)) {
        return null;
      }

      const normalizedPath = path.normalize(String(filePath));
      const fileName = path.basename(normalizedPath);
      const fileToken = randomUUID();
      authorizedFiles.set(fileToken, { fileName, filePath: normalizedPath });
      return { fileName, filePath: normalizedPath, fileToken };
    },

    resolve(fileToken) {
      return authorizedFiles.get(String(fileToken || "")) || null;
    },
  };
}

module.exports = {
  LOOPBACK_HOST,
  isAuthorizedMutation,
  createFormatterFileAuthority,
  isFormatterSavePath,
  isLoopbackAddress,
  isLoopbackHostHeader,
  isLoopbackOriginHeader,
  isLoopbackRequest,
  isLocalBrowserRequest,
};