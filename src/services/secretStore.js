const { execFileSync } = require("child_process");

function escapeSingleQuotes(value) {
  return String(value || "").replace(/'/g, "''");
}

function getWindowsPowerShellEnvironment() {
  const env = { ...process.env };
  delete env.PSModulePath;
  return env;
}

function encryptPassword(plainText) {
  if (!plainText) {
    return null;
  }

  const escaped = escapeSingleQuotes(plainText);
  const script = [
    `$sec = ConvertTo-SecureString '${escaped}' -AsPlainText -Force`,
    "$enc = ConvertFrom-SecureString $sec",
    "Write-Output $enc",
  ].join("; ");

  const encrypted = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    env: getWindowsPowerShellEnvironment(),
  }).replace(/\r?\n$/, "");

  return encrypted;
}

function decryptPassword(cipherText) {
  if (!cipherText) {
    return null;
  }

  const escaped = escapeSingleQuotes(cipherText);
  const script = [
    `$sec = ConvertTo-SecureString '${escaped}'`,
    "$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)",
    "$plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)",
    "[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)",
    "Write-Output $plain",
  ].join("; ");

  const plain = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    env: getWindowsPowerShellEnvironment(),
  }).replace(/\r?\n$/, "");

  return plain;
}

module.exports = {
  encryptPassword,
  decryptPassword,
};
