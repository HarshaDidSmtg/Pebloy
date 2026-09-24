const { execFileSync } = require("child_process");
const path = require("path");

// Secrets travel over stdin, never argv: process command lines are readable by
// any process on the machine (Win32_Process / Process Explorer).
const ENCRYPT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$b64 = [Console]::In.ReadToEnd()",
  "$plain = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64.Trim()))",
  "$sec = ConvertTo-SecureString $plain -AsPlainText -Force",
  "[Console]::Out.Write((ConvertFrom-SecureString $sec))",
].join("; ");

const DECRYPT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$cipher = [Console]::In.ReadToEnd()",
  "$sec = ConvertTo-SecureString $cipher.Trim()",
  "$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)",
  "try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }",
  "[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($plain)))",
].join("; ");

const DECRYPT_CACHE_LIMIT = 64;
const decryptCache = new Map();

function getWindowsPowerShellEnvironment() {
  const env = { ...process.env };
  delete env.PSModulePath;
  return env;
}

function assertWindows() {
  if (process.platform !== "win32") {
    throw new Error(
      "Stored SQL Authentication passwords rely on Windows DPAPI, which is unavailable on this platform. Use Windows Authentication instead."
    );
  }
}

// PowerShell can wrap redirected output; DPAPI hex and base64 are whitespace-insensitive.
function stripWhitespace(value) {
  return String(value || "").replace(/\s+/g, "");
}

// Surfaces the PowerShell failure reason without echoing the whole command back to the UI.
function summarizeDpapiFailure(err) {
  const stderr = String(err?.stderr || "");
  const firstLine = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("+") && !line.startsWith("At line:"));

  if (firstLine) {
    return firstLine.replace(/^\w+-\w+\s*:\s*/, "");
  }
  return "Windows DPAPI returned an error.";
}

function runDpapi(script, stdinPayload) {
  assertWindows();
  try {
    const powershellPath = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return execFileSync(powershellPath, ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      env: getWindowsPowerShellEnvironment(),
      input: stdinPayload,
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(summarizeDpapiFailure(err));
  }
}

function encryptPassword(plainText) {
  if (!plainText) {
    return null;
  }

  const payload = Buffer.from(String(plainText), "utf8").toString("base64");
  const cipher = stripWhitespace(runDpapi(ENCRYPT_SCRIPT, payload));
  if (!cipher) {
    throw new Error("Password encryption returned no data.");
  }

  cacheSecret(cipher, String(plainText));
  return cipher;
}

function decryptPassword(cipherText) {
  if (!cipherText) {
    return null;
  }

  const cipher = stripWhitespace(cipherText);
  if (decryptCache.has(cipher)) {
    return decryptCache.get(cipher);
  }

  const encoded = stripWhitespace(runDpapi(DECRYPT_SCRIPT, cipher));
  const plain = Buffer.from(encoded, "base64").toString("utf8");
  cacheSecret(cipher, plain);
  return plain;
}

function cacheSecret(cipher, plain) {
  if (decryptCache.size >= DECRYPT_CACHE_LIMIT) {
    decryptCache.clear();
  }
  decryptCache.set(cipher, plain);
}

function clearSecretCache() {
  decryptCache.clear();
}

module.exports = {
  encryptPassword,
  decryptPassword,
  clearSecretCache,
};
