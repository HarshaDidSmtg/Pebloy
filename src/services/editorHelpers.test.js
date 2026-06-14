const {
  normalizeFindMatchIndex,
  getNextFindMatchIndex,
  getFindCountText,
  getClearSelectionUiState,
} = require("../../public/editorHelpers");

describe("editorHelpers", () => {
  test("clear selection resets the UI back to manual entry", () => {
    expect(getClearSelectionUiState(true)).toEqual({
      nextMode: "Specify",
      clearDiscovered: true,
      focusTargetId: "sharedObjectText",
      toastMessage: "Cleared object selection",
    });

    expect(getClearSelectionUiState(false).toastMessage).toBe("Ready for manual object entry");
  });

  test("find count text reflects idle, empty, and active match states", () => {
    expect(getFindCountText(0, -1)).toBe("No results");
    expect(getFindCountText(3, -1)).toBe("3 results");
    expect(getFindCountText(1, -1)).toBe("1 result");
    expect(getFindCountText(3, 1)).toBe("2/3");
  });

  test("match navigation starts at the first result and wraps in both directions", () => {
    expect(getNextFindMatchIndex(-1, 3, 1)).toBe(0);
    expect(getNextFindMatchIndex(-1, 3, -1)).toBe(2);
    expect(getNextFindMatchIndex(0, 3, 1)).toBe(1);
    expect(getNextFindMatchIndex(2, 3, 1)).toBe(0);
    expect(getNextFindMatchIndex(0, 3, -1)).toBe(2);
  });

  test("match normalization preserves idle state and clamps overflow", () => {
    expect(normalizeFindMatchIndex(-1, 3)).toBe(-1);
    expect(normalizeFindMatchIndex(1, 3)).toBe(1);
    expect(normalizeFindMatchIndex(7, 3)).toBe(2);
    expect(normalizeFindMatchIndex(0, 0)).toBe(-1);
  });
});