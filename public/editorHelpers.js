(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.BDeployEditorHelpers = api;
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

  return {
    normalizeFindMatchIndex,
    getNextFindMatchIndex,
    getFindCountText,
    getClearSelectionUiState,
  };
});