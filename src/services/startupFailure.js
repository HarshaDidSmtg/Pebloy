const STARTUP_FAILURE_PREFIX = "Pebloy failed to start:";

// Server startup prints the cause followed by a stack trace; the desktop shell
// shows only the cause, because a stack frame tells an operator nothing.
function extractStartupFailureReason(stderr) {
  const lines = String(stderr || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const reported = lines.find((line) => line.startsWith(STARTUP_FAILURE_PREFIX));
  if (reported) return reported.slice(STARTUP_FAILURE_PREFIX.length).trim();
  return lines.filter((line) => !/^at\s/.test(line)).pop() || "";
}

module.exports = { STARTUP_FAILURE_PREFIX, extractStartupFailureReason };
