(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.PebloyManualEntryEditor = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  let monacoLoaderPromise = null;

  function normalizeColor(value, fallback) {
    const input = String(value || "").trim();
    if (!input) return fallback;
    if (input.startsWith("#")) return input;
    const rgbMatch = input.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/i);
    if (!rgbMatch) return fallback;
    const toHex = (part) => Number(part).toString(16).padStart(2, "0");
    const r = toHex(rgbMatch[1]);
    const g = toHex(rgbMatch[2]);
    const b = toHex(rgbMatch[3]);
    if (rgbMatch[4] === undefined) return `#${r}${g}${b}`;
    const alpha = toHex(Math.round(Number(rgbMatch[4]) * 255));
    return `#${r}${g}${b}${alpha}`;
  }

  function isLightTheme() {
    return document.documentElement.style.colorScheme === "light" || document.body.getAttribute("data-theme") === "light";
  }

  function loadMonaco() {
    if (typeof window === "undefined") {
      return Promise.reject(new Error("Enhanced editor is only available in the browser."));
    }
    if (window.monaco?.editor) return Promise.resolve(window.monaco);
    if (monacoLoaderPromise) return monacoLoaderPromise;

    monacoLoaderPromise = new Promise((resolve, reject) => {
      const configureAndLoad = () => {
        if (typeof window.require !== "function") {
          reject(new Error("Monaco loader did not initialize."));
          return;
        }

        window.MonacoEnvironment = {
          getWorkerUrl() {
            return "/monacoWorker.js";
          },
        };

        window.require.config({ paths: { vs: "/vendor/monaco/vs" } });
        window.require(["vs/editor/editor.main"], () => resolve(window.monaco), reject);
      };

      if (document.querySelector("script[data-monaco-loader='true']")) {
        if (typeof window.require === "function") {
          configureAndLoad();
          return;
        }
      }

      const script = document.createElement("script");
      script.src = "/vendor/monaco/vs/loader.js";
      script.async = true;
      script.dataset.monacoLoader = "true";
      script.onload = configureAndLoad;
      script.onerror = () => reject(new Error("Could not load Monaco assets."));
      document.head.appendChild(script);
    });

    return monacoLoaderPromise;
  }

  function createMonacoTheme(monaco) {
    const styles = getComputedStyle(document.body);
    const foreground = normalizeColor(styles.getPropertyValue("--text"), "#cccccc");
    const background = normalizeColor(styles.getPropertyValue("--surface"), "#252526");
    const surface2 = normalizeColor(styles.getPropertyValue("--surface-2"), "#2d2d2d");
    const accent = normalizeColor(styles.getPropertyValue("--accent"), "#0078d4");
    const muted = normalizeColor(styles.getPropertyValue("--muted"), "#6b6b6b");
    const border = normalizeColor(styles.getPropertyValue("--border"), "#3c3c3c");
    const selection = normalizeColor(styles.getPropertyValue("--accent-soft"), "#264f78");
    const editorTheme = globalThis.PebloyThemes?.find((theme) => theme.id === document.body.dataset.theme)?.editor;

    monaco.editor.defineTheme("pebloy-manual-entry", {
      base: isLightTheme() ? "vs" : "vs-dark",
      inherit: editorTheme?.inherit ?? true,
      rules: editorTheme?.rules || [
        { token: "keyword.sql", foreground: accent.slice(1) },
        { token: "number.sql", foreground: normalizeColor(styles.getPropertyValue("--warning-ink"), accent).slice(1) },
        { token: "string.sql", foreground: normalizeColor(styles.getPropertyValue("--success-ink"), foreground).slice(1) },
        { token: "comment.sql", foreground: muted.slice(1) },
        { token: "operator.sql", foreground: foreground.slice(1) },
        { token: "predefined.sql", foreground: normalizeColor(styles.getPropertyValue("--info-ink"), foreground).slice(1) },
      ],
      colors: {
        "editor.background": background,
        "editor.foreground": foreground,
        "editorLineNumber.foreground": muted,
        "editorLineNumber.activeForeground": foreground,
        "editorCursor.foreground": accent,
        "editor.selectionBackground": selection,
        "editor.inactiveSelectionBackground": selection,
        "editor.lineHighlightBackground": surface2,
        "editorIndentGuide.background1": border,
        "editorIndentGuide.activeBackground1": accent,
        "editorBracketMatch.background": "#00000000",
        "editorBracketMatch.border": accent,
        "editorWidget.background": surface2,
        "editorWidget.border": border,
        ...editorTheme?.colors,
      },
    });

    monaco.editor.setTheme("pebloy-manual-entry");
  }

  function createReplaceInputEvent(type) {
    return new Event(type, { bubbles: true });
  }

  function fullModelRange(model) {
    const lastLineNumber = Math.max(1, model.getLineCount());
    return {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: lastLineNumber,
      endColumn: model.getLineMaxColumn(lastLineNumber),
    };
  }

  function transformEditorSelections(editor, transformer) {
    const model = editor.getModel();
    if (!model) return;

    const selections = editor.getSelections() || [];
    const nonEmptySelections = selections.filter((selection) => selection && !selection.isEmpty());
    const targetRanges = nonEmptySelections.length ? nonEmptySelections : [fullModelRange(model)];
    const edits = [];

    for (const range of targetRanges) {
      const sourceText = model.getValueInRange(range);
      const nextText = transformer(sourceText);
      if (nextText === sourceText) continue;
      edits.push({
        range,
        text: nextText,
        forceMoveMarkers: true,
      });
    }

    if (!edits.length) return;

    editor.executeEdits("manual-entry-transform", edits);
    editor.pushUndoStop();
  }

  async function createEnhancedTextareaEditor({ host, textarea, initialValue = "", placeholder = "" }) {
    if (!host || !textarea) {
      throw new Error("Enhanced editor requires both host and textarea elements.");
    }

    const monaco = await loadMonaco();
    createMonacoTheme(monaco);

    const shell = host.closest(".enhanced-text-editor-shell, .manual-entry-editor-shell");
    const model = monaco.editor.createModel(String(initialValue ?? textarea.value ?? ""), "plaintext");
    let syncingFromEditor = false;
    let syncingFromTextarea = false;

    const editor = monaco.editor.create(host, {
      model,
      automaticLayout: true,
      folding: false,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
      fontLigatures: true,
      lineNumbers: "on",
      lineNumbersMinChars: 3,
      minimap: { enabled: false },
      padding: { top: 12, bottom: 12 },
      placeholder,
      renderLineHighlight: "none",
      renderWhitespace: "selection",
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      tabSize: 4,
      wordWrap: "off",
    });

    function getValue() {
      return model.getValue();
    }

    function syncTextareaValue(eventType = null) {
      if (syncingFromTextarea) return;
      syncingFromEditor = true;
      textarea.value = getValue();
      if (eventType) {
        textarea.dispatchEvent(createReplaceInputEvent(eventType));
      }
      syncingFromEditor = false;
    }

    function applyEditorOptions() {
      createMonacoTheme(monaco);
      editor.updateOptions({
        fontSize: Math.max(12, Math.round(parseFloat(getComputedStyle(document.documentElement).fontSize || "14") - 1)),
        placeholder,
      });
    }

    function setValue(value, { emit = false } = {}) {
      const nextValue = String(value ?? "");
      if (nextValue !== getValue()) {
        syncingFromTextarea = true;
        model.setValue(nextValue);
        syncingFromTextarea = false;
      }
      syncTextareaValue(emit ? "input" : null);
      if (emit) {
        textarea.dispatchEvent(createReplaceInputEvent("change"));
      }
    }

    function focus() {
      editor.focus();
    }

    function openFind() {
      editor.focus();
      return editor.getAction("actions.find")?.run?.();
    }

    function openReplace() {
      editor.focus();
      return editor.getAction("editor.action.startFindReplaceAction")?.run?.();
    }

    function transformSelection(transformer) {
      editor.focus();
      transformEditorSelections(editor, transformer);
    }

    function isTextFocused() {
      return Boolean(editor.hasTextFocus?.() || editor.hasWidgetFocus?.());
    }

    function updatePlaceholder(nextPlaceholder) {
      placeholder = String(nextPlaceholder || "");
      editor.updateOptions({ placeholder });
    }

    model.onDidChangeContent(() => syncTextareaValue("input"));
    editor.onDidBlurEditorText(() => syncTextareaValue("change"));
    const handleTextareaInput = () => {
      if (syncingFromEditor) return;
      setValue(textarea.value, { emit: false });
    };
    textarea.addEventListener("input", handleTextareaInput);

    const themeObserver = new MutationObserver(() => applyEditorOptions());
    themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["data-theme", "style"],
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style"],
    });

    shell?.classList.add("has-enhanced-editor");
    host.classList.remove("hidden");
    syncTextareaValue(null);
    applyEditorOptions();

    return {
      dispose() {
        textarea.removeEventListener("input", handleTextareaInput);
        themeObserver.disconnect();
        model.dispose();
        editor.dispose();
        shell?.classList.remove("has-enhanced-editor");
      },
      focus,
      getValue,
      isTextFocused,
      layout() {
        editor.layout();
      },
      openFind,
      openReplace,
      setValue,
      transformSelection,
      updatePlaceholder,
    };
  }

  function createManualEntryEditor(options) {
    return createEnhancedTextareaEditor(options);
  }

  return {
    createEnhancedTextareaEditor,
    createManualEntryEditor,
  };
});
