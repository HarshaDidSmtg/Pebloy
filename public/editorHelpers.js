(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.PebloyEditorHelpers = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function normalizeFindMatchIndex(matchIdx, matchCount) {
    if (!matchCount) return -1;
    if (matchIdx < 0) return -1;
    return Math.min(matchIdx, matchCount - 1);
  }

  function getNextFindMatchIndex(matchIdx, matchCount, direction) {
    if (!matchCount) return -1;
    if (matchIdx < 0) {
      return direction < 0 ? matchCount - 1 : 0;
    }

    let next = (matchIdx + direction) % matchCount;
    if (next < 0) next += matchCount;
    return next;
  }

  function getFindCountText(matchCount, matchIdx) {
    if (!matchCount) return "No results";
    if (matchIdx < 0) {
      return `${matchCount} result${matchCount === 1 ? "" : "s"}`;
    }
    return `${matchIdx + 1}/${matchCount}`;
  }

  function getClearSelectionUiState(hadSelection) {
    return {
      nextMode: "Specify",
      clearDiscovered: true,
      focusTargetId: "sharedObjectText",
      toastMessage: hadSelection ? "Cleared object selection" : "Ready for manual object entry",
    };
  }

  function getManualEntryPlaceholderText(shortcuts = {}) {
    const resolveObjects = shortcuts.resolveObjects || "Ctrl+D";
    const findInEditor = shortcuts.findInEditor || "Ctrl+F";
    const replaceInEditor = shortcuts.replaceInEditor || "Ctrl+H";
    const uppercaseText = shortcuts.uppercaseText || "Ctrl+Shift+U";
    const lowercaseText = shortcuts.lowercaseText || "Ctrl+Shift+L";

    return [
      "Paste schema.name or object name (one per line)",
      "Example: dbo.MyProc",
      "         vw_Orders",
      "         reporting.usp_get_summary",
      "",
      `Shortcuts: ${resolveObjects} = Resolve & Add  ·  ${findInEditor} = Find  ·  ${replaceInEditor} = Replace  ·  ${uppercaseText} = UPPER  ·  ${lowercaseText} = lower`,
    ].join("\n");
  }

  function getManualEntryHelperText(shortcuts = {}) {
    const resolveObjects = shortcuts.resolveObjects || "Ctrl+D";
    const findInEditor = shortcuts.findInEditor || "Ctrl+F";
    const replaceInEditor = shortcuts.replaceInEditor || "Ctrl+H";
    const uppercaseText = shortcuts.uppercaseText || "Ctrl+Shift+U";
    const lowercaseText = shortcuts.lowercaseText || "Ctrl+Shift+L";

    return `One object per line. Use schema.name when names are ambiguous. Shortcuts: ${resolveObjects} Resolve & Add, ${findInEditor} Find, ${replaceInEditor} Replace, ${uppercaseText} UPPER, ${lowercaseText} lower.`;
  }

  return {
    normalizeFindMatchIndex,
    getNextFindMatchIndex,
    getFindCountText,
    getClearSelectionUiState,
    getManualEntryPlaceholderText,
    getManualEntryHelperText,
  };
});