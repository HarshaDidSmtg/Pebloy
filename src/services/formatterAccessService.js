const { randomUUID } = require("crypto");
const path = require("path");

const LOOPBACK_HOST = "127.0.0.1";
const LOOPBACK_ADDRESSES = new Set([LOOPBACK_HOST, "::1", `::ffff:${LOOPBACK_HOST}`]);
const FORMATTER_FILE_PATTERN = /\.(sql|txt)$/i;

function isLoopbackAddress(address) {
  return LOOPBACK_ADDRESSES.has(String(address || "").trim().toLowerCase());
}

function isLoopbackRequest(req) {
  return isLoopbackAddress(req?.socket?.remoteAddress || req?.connection?.remoteAddress || req?.ip || "");
}

function isFormatterSavePath(filePath) {
  const candidate = String(filePath || "").trim();
  return path.isAbsolute(candidate) && FORMATTER_FILE_PATTERN.test(candidate);
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
  createFormatterFileAuthority,
  isFormatterSavePath,
  isLoopbackAddress,
  isLoopbackRequest,
};