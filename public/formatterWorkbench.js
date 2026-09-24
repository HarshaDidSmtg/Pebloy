(function initPebloyFormatterWorkbench(globalScope) {
  const FILE_FILTERS = [{ name: "SQL Files", extensions: ["sql", "txt"] }];
  const DEFAULT_EDITOR_STATE = Object.freeze({
    wordWrap: false,
    minimapEnabled: true,
    lineNumbers: true,
  });
  const DEFAULT_LAYOUT_STATE = Object.freeze({
    sidebarWidth: 360,
  });

  let monacoLoaderPromise = null;

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function clamp(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  function detectEol(text) {
    return String(text || "").includes("\r\n") ? "CRLF" : "LF";
  }

  function countLines(text) {
    if (!text) return 1;
    return String(text).split(/\r?\n/).length;
  }

  function toHexPair(value) {
    return Number(value).toString(16).padStart(2, "0");
  }

  function normalizeColor(value, fallback) {
    const input = String(value || "").trim();
    if (!input) return fallback;
    if (input.startsWith("#")) return input;
    const rgbMatch = input.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/i);
    if (!rgbMatch) return fallback;
    const r = toHexPair(rgbMatch[1]);
    const g = toHexPair(rgbMatch[2]);
    const b = toHexPair(rgbMatch[3]);
    if (rgbMatch[4] === undefined) return `#${r}${g}${b}`;
    const alpha = toHexPair(Math.round(Number(rgbMatch[4]) * 255));
    return `#${r}${g}${b}${alpha}`;
  }

  function isLightTheme() {
    return document.documentElement.style.colorScheme === "light" || document.body.getAttribute("data-theme") === "light";
  }

  function loadMonaco() {
    if (globalScope.monaco?.editor) return Promise.resolve(globalScope.monaco);
    if (monacoLoaderPromise) return monacoLoaderPromise;

    monacoLoaderPromise = new Promise((resolve, reject) => {
      const configureAndLoad = () => {
        if (typeof globalScope.require !== "function") {
          reject(new Error("Monaco loader did not initialize."));
          return;
        }

        globalScope.MonacoEnvironment = {
          getWorkerUrl() {
            return "/monacoWorker.js";
          },
        };

        globalScope.require.config({ paths: { vs: "/vendor/monaco/vs" } });
        globalScope.require(["vs/editor/editor.main"], () => resolve(globalScope.monaco), reject);
      };

      if (document.querySelector("script[data-monaco-loader='true']")) {
        if (typeof globalScope.require === "function") {
          configureAndLoad();
          return;
        }
      }

      const script = document.createElement("script");
      script.src = "/vendor/monaco/vs/loader.js";
      script.async = true;
      script.dataset.monacoLoader = "true";
      script.onload = configureAndLoad;
      script.onerror = () => reject(new Error("Could not load local Monaco assets."));
      document.head.appendChild(script);
    });

    return monacoLoaderPromise;
  }

  function optionMetadataById(capabilities) {
    const metadata = new Map();
    for (const group of capabilities.groups || []) {
      for (const option of group.options || []) {
        metadata.set(option.id, option);
      }
    }
    return metadata;
  }

  function defaultOptionsFromCapabilities(capabilities) {
    const defaults = {};
    for (const group of capabilities.groups || []) {
      for (const option of group.options || []) {
        defaults[option.id] = deepClone(option.defaultValue);
      }
    }
    return defaults;
  }

  function defaultSectionsFromCapabilities(capabilities) {
    return Object.fromEntries((capabilities.groups || []).map((group) => [group.id, true]));
  }

  function normalizeOptionValue(option, value) {
    if (!option) return value;
    if (option.type === "boolean") {
      return Boolean(value);
    }
    if (option.type === "number") {
      return clamp(value, option.min, option.max, option.defaultValue);
    }
    if (option.type === "select") {
      return (option.values || []).includes(value) ? value : option.defaultValue;
    }
    return value === undefined ? option.defaultValue : value;
  }

  function sanitizePersistedState(capabilities, rawState = {}) {
    const optionMetadata = optionMetadataById(capabilities);
    const optionDefaults = defaultOptionsFromCapabilities(capabilities);
    const sectionDefaults = defaultSectionsFromCapabilities(capabilities);
    const source = rawState && typeof rawState === "object" ? rawState : {};
    const sourceOptions = source.options && typeof source.options === "object" ? source.options : {};

    return {
      dialect: String(source.dialect || capabilities.defaultDialect || "tsql").trim().toLowerCase() === "tsql"
        ? "tsql"
        : (capabilities.defaultDialect || "tsql"),
      compareMode: Boolean(source.compareMode),
      inlineDiff: Boolean(source.inlineDiff),
      options: Object.fromEntries(
        Object.entries(optionDefaults).map(([key, defaultValue]) => [
          key,
          normalizeOptionValue(optionMetadata.get(key), sourceOptions[key] === undefined ? defaultValue : sourceOptions[key]),
        ])
      ),
      editor: {
        wordWrap: Boolean(source?.editor?.wordWrap),
        minimapEnabled: source?.editor?.minimapEnabled === undefined
          ? DEFAULT_EDITOR_STATE.minimapEnabled
          : Boolean(source.editor.minimapEnabled),
        lineNumbers: source?.editor?.lineNumbers === undefined
          ? DEFAULT_EDITOR_STATE.lineNumbers
          : Boolean(source.editor.lineNumbers),
      },
      layout: {
        sidebarWidth: clamp(source?.layout?.sidebarWidth, 280, 520, DEFAULT_LAYOUT_STATE.sidebarWidth),
      },
      sections: Object.fromEntries(
        Object.keys(sectionDefaults).map((key) => [
          key,
          source?.sections?.[key] === undefined ? sectionDefaults[key] : Boolean(source.sections[key]),
        ])
      ),
    };
  }

  function setModelText(monaco, model, text) {
    const value = String(text ?? "");
    model.setValue(value);
    model.setEOL(detectEol(value) === "CRLF"
      ? monaco.editor.EndOfLineSequence.CRLF
      : monaco.editor.EndOfLineSequence.LF);
  }

  function modelText(monaco, model) {
    return model.getValue(monaco.editor.EndOfLinePreference.TextDefined, true);
  }

  function createMonacoTheme(monaco) {
    const styles = getComputedStyle(document.body);
    const foreground = normalizeColor(styles.getPropertyValue("--text"), "#cccccc");
    const background = normalizeColor(styles.getPropertyValue("--surface"), "#252526");
    const accent = normalizeColor(styles.getPropertyValue("--accent"), "#0078d4");
    const muted = normalizeColor(styles.getPropertyValue("--muted"), "#6b6b6b");
    const border = normalizeColor(styles.getPropertyValue("--border"), "#3c3c3c");
    const lineHighlight = normalizeColor(styles.getPropertyValue("--surface-2"), "#2d2d2d");
    const selection = normalizeColor(styles.getPropertyValue("--accent-soft"), "#264f78");
    const editorTheme = globalThis.PebloyThemes?.find((theme) => theme.id === document.body.dataset.theme)?.editor;

    monaco.editor.defineTheme("pebloy-dynamic", {
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
        "editor.lineHighlightBackground": lineHighlight,
        "editorIndentGuide.background1": border,
        "editorIndentGuide.activeBackground1": accent,
        "editorBracketMatch.background": "#00000000",
        "editorBracketMatch.border": accent,
        "editorWidget.background": normalizeColor(styles.getPropertyValue("--surface-2"), background),
        "editorWidget.border": border,
        ...editorTheme?.colors,
      },
    });
    monaco.editor.setTheme("pebloy-dynamic");
  }

  async function createFormatterWorkbench(context) {
    const monaco = await loadMonaco();
    const capabilities = await context.api("/api/format/capabilities");
    const state = sanitizePersistedState(capabilities, context.initialState || {});

    const shell = document.getElementById("formatterShell");
    const sidebar = document.getElementById("formatterSidebar");
    const resizer = document.getElementById("formatterSidebarResizer");
    const editorHost = document.getElementById("formatterMonacoEditor");
    const diffHost = document.getElementById("formatterMonacoDiff");
    const stage = document.getElementById("formatterEditorStage");
    const dropHint = document.getElementById("formatterDropHint");
    const overlay = document.getElementById("formatterLoadingOverlay");
    const overlayTitle = document.getElementById("formatterLoadingTitle");
    const overlayDetail = document.getElementById("formatterLoadingDetail");
    const statusEl = document.getElementById("formatterStatus");
    const metricsEl = document.getElementById("formatterMetrics");
    const optionsPanel = document.getElementById("formatterOptionsPanel");
    const dialectBadge = document.getElementById("formatterDialectBadge");
    const capabilityNote = document.getElementById("formatterCapabilitiesNote");
    const fileInput = document.getElementById("formatterFileInput");
    const compareToggle = document.getElementById("formatterCompareToggle");
    const inlineToggle = document.getElementById("formatterInlineDiffToggle");
    const wrapToggle = document.getElementById("formatterWordWrapToggle");
    const minimapToggle = document.getElementById("formatterMinimapToggle");
    const lineNumbersToggle = document.getElementById("formatterLineNumbersToggle");

    const session = {
      fileName: "",
      filePath: "",
      fileToken: "",
      originalText: "",
      savedText: "",
      progressTimer: null,
    };

    const optionMetadata = optionMetadataById(capabilities);
    const optionDefaults = defaultOptionsFromCapabilities(capabilities);
    const presets = {
      sqlReview: {
        label: "SQL Review",
        options: {
          ...optionDefaults,
          trailingCommas: false,
          spaceAfterExpandedComma: true,
          expandCommaLists: true,
          expandBooleanExpressions: true,
          expandCaseStatements: true,
          breakJoinOnSections: true,
        },
      },
      leadingCommas: {
        label: "Leading Commas",
        options: null,
      },
      trailingCommas: {
        label: "Trailing Commas",
        options: null,
      },
      procedureStyle: {
        label: "Procedure Style",
        options: {
          ...state.options,
          statementBreaks: 2,
          clauseBreaks: 1,
          expandCommaLists: true,
          expandBooleanExpressions: true,
          expandCaseStatements: true,
          breakJoinOnSections: true,
          trailingCommas: false,
          spaceAfterExpandedComma: true,
        },
      },
      compact: {
        label: "Compact",
        options: {
          ...state.options,
          statementBreaks: 1,
          clauseBreaks: 0,
          expandCommaLists: false,
          expandBooleanExpressions: false,
          expandCaseStatements: false,
          expandInLists: false,
        },
      },
    };

    const mainModel = monaco.editor.createModel("", "sql");
    const originalModel = monaco.editor.createModel("", "sql");

    createMonacoTheme(monaco);

    const editor = monaco.editor.create(editorHost, {
      model: mainModel,
      automaticLayout: true,
      bracketPairColorization: { enabled: true },
      folding: true,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace",
      fontLigatures: true,
      lineNumbersMinChars: 3,
      matchBrackets: "always",
      minimap: { enabled: true },
      padding: { top: 14, bottom: 14 },
      renderWhitespace: "selection",
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      tabSize: 4,
    });

    const diffEditor = monaco.editor.createDiffEditor(diffHost, {
      automaticLayout: true,
      enableSplitViewResizing: true,
      ignoreTrimWhitespace: false,
      originalEditable: false,
      renderIndicators: true,
      renderMarginRevertIcon: false,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
    });
    diffEditor.setModel({ original: originalModel, modified: mainModel });

    function persist(delay = 250) {
      if (typeof context.onStateChange === "function") {
        context.onStateChange(getPersistedState(), { delay });
      }
    }

    function setSidebarWidth(width) {
      state.layout.sidebarWidth = clamp(width, 280, 520, DEFAULT_LAYOUT_STATE.sidebarWidth);
      shell.style.setProperty("--formatter-sidebar-width", `${state.layout.sidebarWidth}px`);
    }

    function currentText() {
      return modelText(monaco, mainModel);
    }

    function activeEditor() {
      return state.compareMode ? diffEditor.getModifiedEditor() : editor;
    }

    function updateMetrics() {
      const text = currentText();
      const parts = [
        `${countLines(text).toLocaleString()} line${countLines(text) === 1 ? "" : "s"}`,
        `${text.length.toLocaleString()} chars`,
        detectEol(text),
      ];
      if (session.fileName) parts.unshift(session.fileName);
      metricsEl.textContent = parts.join("  ·  ");
    }

    function updateStatus(text) {
      statusEl.textContent = text;
      updateMetrics();
    }

    function applyEditorOptions() {
      createMonacoTheme(monaco);
      const fontSize = Math.max(12, Math.round(parseFloat(getComputedStyle(document.documentElement).fontSize || "14") - 1));
      const lineNumbers = state.editor.lineNumbers ? "on" : "off";
      const wrap = state.editor.wordWrap ? "on" : "off";
      const common = {
        fontSize,
        lineNumbers,
        minimap: { enabled: state.editor.minimapEnabled },
        wordWrap: wrap,
      };

      editor.updateOptions(common);
      diffEditor.updateOptions({
        renderSideBySide: !state.inlineDiff,
      });
      diffEditor.getModifiedEditor().updateOptions(common);
      diffEditor.getOriginalEditor().updateOptions({
        fontSize,
        lineNumbers,
        minimap: { enabled: false },
        readOnly: true,
        wordWrap: wrap,
      });
    }

    function syncToggles() {
      compareToggle.checked = state.compareMode;
      inlineToggle.checked = state.inlineDiff;
      wrapToggle.checked = state.editor.wordWrap;
      minimapToggle.checked = state.editor.minimapEnabled;
      lineNumbersToggle.checked = state.editor.lineNumbers;
      inlineToggle.disabled = !state.compareMode;
    }

    function updateEditorMode() {
      syncToggles();
      editorHost.classList.toggle("hidden", state.compareMode);
      diffHost.classList.toggle("hidden", !state.compareMode);
      stage.classList.toggle("formatter-stage-compare", state.compareMode);
      if (state.compareMode) {
        diffEditor.layout();
        diffEditor.getModifiedEditor().focus();
      } else {
        editor.layout();
      }
      updateStatus(
        state.compareMode
          ? (session.originalText ? "Compare mode shows the original script against the formatted result." : "Compare mode is ready. Format once to snapshot the original text.")
          : "Interactive formatter is ready. All processing stays local to Pebloy."
      );
    }

    function beginBusy(actionLabel) {
      clearInterval(session.progressTimer);
      overlayTitle.textContent = actionLabel;
      overlayDetail.textContent = "Large scripts stay inside Pebloy and never leave your machine.";
      overlay.classList.remove("hidden");
      context.beginTaskProgress("formatter", actionLabel);
      const startedAt = Date.now();
      session.progressTimer = setInterval(() => {
        const seconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
        context.updateTaskProgress("formatter", `${actionLabel}  ${seconds}s`, null);
      }, 1000);
    }

    function endBusy(ok, label) {
      clearInterval(session.progressTimer);
      session.progressTimer = null;
      overlay.classList.add("hidden");
      context.endTaskProgress("formatter", ok, label);
    }

    function resetBusy() {
      clearInterval(session.progressTimer);
      session.progressTimer = null;
      overlay.classList.add("hidden");
      context.resetTaskProgress("formatter");
    }

    function loadTextIntoEditor(text, file = {}) {
      if (currentText() !== session.savedText && !window.confirm("Discard unsaved SQL changes?")) return;
      session.savedText = text;
      setModelText(monaco, mainModel, text);
      setModelText(monaco, originalModel, text);
      session.originalText = text;
      session.fileName = String(file.fileName || file.name || "");
      session.filePath = String(file.filePath || file.path || "");
      session.fileToken = String(file.fileToken || "");
      updateEditorMode();
      updateStatus(
        session.fileName
          ? `Loaded ${session.fileName}. Ready to format locally.`
          : "Ready to format locally."
      );
    }

    function clearEditor() {
      if (currentText() !== session.savedText && !window.confirm("Discard unsaved SQL changes?")) return false;
      session.savedText = "";
      session.fileName = "";
      session.filePath = "";
      session.fileToken = "";
      session.originalText = "";
      setModelText(monaco, mainModel, "");
      setModelText(monaco, originalModel, "");
      resetBusy();
      updateEditorMode();
      return true;
    }

    async function openViaDialog() {
      const electronApi = context.electronAPI;
      if (electronApi?.pickFile) {
        const file = await electronApi.pickFile({
          allowOverwrite: true,
          description: "Open SQL script",
          initialPath: session.filePath,
          filters: FILE_FILTERS,
        });
        if (file) loadTextIntoEditor(file.content || "", file);
        return;
      }
      fileInput.click();
    }

    async function saveAs() {
      const text = currentText();
      if (!text.trim()) {
        context.showToast("Nothing to save", true);
        return;
      }

      const electronApi = context.electronAPI;
      const suggestedName = session.fileName || `formatted_${context.buildTimestampFileSuffix()}.sql`;
      if (electronApi?.saveFile) {
        const saved = await electronApi.saveFile({
          allowOverwrite: true,
          description: "Save formatted SQL",
          defaultPath: session.filePath || suggestedName,
          content: text,
          filters: FILE_FILTERS,
        });
        if (saved) {
          session.savedText = text;
          session.fileName = saved.fileName || suggestedName;
          session.filePath = saved.filePath || "";
          session.fileToken = saved.fileToken || "";
          updateStatus(`Saved ${session.fileName}`);
          context.showToast(`Saved ${session.fileName}`);
        }
        return;
      }

      context.downloadTextFile(suggestedName, text, "text/x-sql");
      session.savedText = text;
      context.showToast(`Saved ${suggestedName}`);
    }

    async function saveCurrent() {
      const text = currentText();
      if (!text.trim()) {
        context.showToast("Nothing to save", true);
        return;
      }
      if (!session.filePath) {
        await saveAs();
        return;
      }
      const electronApi = context.electronAPI;
      if (!electronApi?.overwriteFile || !session.fileToken) {
        await saveAs();
        return;
      }

      const saved = await electronApi.overwriteFile({
        fileToken: session.fileToken,
        content: text,
      });
      session.savedText = text;
      session.fileName = saved.fileName || session.fileName;
      session.filePath = saved.filePath || session.filePath;
      session.fileToken = saved.fileToken || session.fileToken;
      updateStatus(`Saved ${session.fileName}`);
      context.showToast(`Saved ${session.fileName}`);
    }

    async function formatCurrentSql() {
      const beforeText = currentText();
      if (!beforeText.trim()) {
        context.showToast("Nothing to format", true);
        return;
      }

      beginBusy(`Formatting ${countLines(beforeText).toLocaleString()} lines locally…`);
      try {
        const result = await context.api("/api/format", {
          method: "POST",
          body: JSON.stringify({
            sql: beforeText,
            dialect: state.dialect,
            options: state.options,
          }),
        });

        session.originalText = beforeText;
        setModelText(monaco, originalModel, beforeText);
        setModelText(monaco, mainModel, result.formatted || "");
        updateEditorMode();
        updateStatus(`Formatted ${countLines(result.formatted || "").toLocaleString()} lines in ${result.durationMs} ms`);
        endBusy(true, "Formatting");
        if ((result.formatted || "") === beforeText) {
          context.showToast("SQL already matched the selected local style");
        } else {
          context.showToast("SQL formatted locally");
        }
      } catch (error) {
        endBusy(false, "Formatting");
        context.showToast(`Formatting failed: ${error.message}`, true);
      }
    }

    function attachFileDrop() {
      const onDrag = (event) => {
        event.preventDefault();
        stage.classList.add("is-drop-target");
      };
      const onDragLeave = (event) => {
        event.preventDefault();
        stage.classList.remove("is-drop-target");
      };
      ["dragenter", "dragover"].forEach((eventName) => stage.addEventListener(eventName, onDrag));
      ["dragleave", "drop"].forEach((eventName) => stage.addEventListener(eventName, onDragLeave));
      stage.addEventListener("drop", async (event) => {
        event.preventDefault();
        const file = event.dataTransfer?.files?.[0];
        if (!file) return;
        if (!/\.(sql|txt)$/i.test(file.name)) {
          context.showToast("Drop a .sql or .txt file", true);
          return;
        }
        loadTextIntoEditor(await file.text(), { fileName: file.name, filePath: file.path || "" });
      });
    }

    function renderOptions() {
      optionsPanel.innerHTML = "";
      capabilityNote.textContent = "Unsupported groups are shown explicitly so editor-only preferences never silently change Pebloy’s shared generated SQL output.";
      dialectBadge.textContent = (capabilities.dialects?.[0]?.label || "T-SQL").toUpperCase();

      for (const group of capabilities.groups || []) {
        const details = document.createElement("details");
        details.className = "formatter-option-group";
        details.open = state.sections[group.id] !== false;
        details.addEventListener("toggle", () => {
          state.sections[group.id] = details.open;
          persist(0);
        });

        const summary = document.createElement("summary");
        summary.className = "formatter-option-summary";

        const titleWrap = document.createElement("div");
        titleWrap.className = "formatter-option-titlewrap";
        const title = document.createElement("span");
        title.className = "formatter-option-title";
        title.textContent = group.title;
        titleWrap.appendChild(title);
        if (group.supported === false) {
          const badge = document.createElement("span");
          badge.className = "formatter-option-badge is-muted";
          badge.textContent = "Fixed";
          titleWrap.appendChild(badge);
        }
        summary.appendChild(titleWrap);
        details.appendChild(summary);

        const body = document.createElement("div");
        body.className = "formatter-option-body";

        if (group.description) {
          const description = document.createElement("p");
          description.className = "muted formatter-option-copy";
          description.textContent = group.description;
          body.appendChild(description);
        }

        if (group.supported === false && (!group.options || !group.options.length)) {
          const message = document.createElement("div");
          message.className = "formatter-option-note";
          message.textContent = "This behavior is deterministic and intentionally not user-configurable in the current offline engine.";
          body.appendChild(message);
        }

        for (const option of group.options || []) {
          const field = document.createElement("label");
          field.className = `formatter-field formatter-field-${option.type}`;

          const label = document.createElement("span");
          label.className = "formatter-field-label";
          label.textContent = option.id.replace(/([A-Z])/g, " $1").replace(/^./, (char) => char.toUpperCase());
          field.appendChild(label);

          let input;
          if (option.type === "boolean") {
            input = document.createElement("input");
            input.type = "checkbox";
            input.checked = Boolean(state.options[option.id]);
            input.className = "formatter-checkbox";
            input.addEventListener("change", () => {
              state.options[option.id] = Boolean(input.checked);
              persist();
            });
            field.classList.add("is-checkbox-row");
          } else if (option.type === "number") {
            input = document.createElement("input");
            input.type = "number";
            input.min = option.min;
            input.max = option.max;
            input.step = option.step || 1;
            input.value = state.options[option.id];
            input.addEventListener("change", () => {
              state.options[option.id] = normalizeOptionValue(optionMetadata.get(option.id), input.value);
              input.value = state.options[option.id];
              persist();
            });
          } else {
            input = document.createElement("select");
            for (const value of option.values || []) {
              const optionEl = document.createElement("option");
              optionEl.value = value;
              optionEl.textContent = value;
              input.appendChild(optionEl);
            }
            input.value = state.options[option.id];
            input.addEventListener("change", () => {
              state.options[option.id] = normalizeOptionValue(optionMetadata.get(option.id), input.value);
              persist();
            });
          }
          input.classList.add("formatter-field-input");
          field.appendChild(input);

          if (option.description) {
            const hint = document.createElement("small");
            hint.className = "formatter-field-hint muted";
            hint.textContent = option.description;
            field.appendChild(hint);
          }

          body.appendChild(field);
        }

        if (Array.isArray(group.guarantees) && group.guarantees.length) {
          for (const item of group.guarantees) {
            const guarantee = document.createElement("div");
            guarantee.className = "formatter-option-note";
            guarantee.textContent = item;
            body.appendChild(guarantee);
          }
        }

        details.appendChild(body);
        optionsPanel.appendChild(details);
      }
    }

    function normalizeOptionsMap(nextOptions) {
      return Object.fromEntries(
        Object.entries(optionDefaults).map(([key, defaultValue]) => [
          key,
          normalizeOptionValue(optionMetadata.get(key), nextOptions[key] === undefined ? defaultValue : nextOptions[key]),
        ])
      );
    }

    function getPresetOptions(presetId) {
      if (presetId === "sqlReview") return presets.sqlReview.options;
      if (presetId === "leadingCommas") {
        return { ...state.options, trailingCommas: false, spaceAfterExpandedComma: true, expandCommaLists: true };
      }
      if (presetId === "trailingCommas") {
        return { ...state.options, trailingCommas: true, spaceAfterExpandedComma: false, expandCommaLists: true };
      }
      if (presetId === "procedureStyle") return presets.procedureStyle.options;
      if (presetId === "compact") return presets.compact.options;
      return null;
    }

    function applyPreset(presetId) {
      const preset = presets[presetId];
      const nextOptions = getPresetOptions(presetId);
      if (!preset || !nextOptions) return;
      state.options = normalizeOptionsMap(nextOptions);
      renderOptions();
      persist(0);
      updateStatus(`${preset.label} formatter preset applied.`);
      context.showToast(`${preset.label} preset applied`);
    }

    function getPersistedState() {
      return deepClone({
        dialect: state.dialect,
        compareMode: state.compareMode,
        inlineDiff: state.inlineDiff,
        options: state.options,
        editor: state.editor,
        layout: state.layout,
        sections: state.sections,
      });
    }

    function applyPersistedState(nextState) {
      const sanitized = sanitizePersistedState(capabilities, nextState || {});
      state.compareMode = sanitized.compareMode;
      state.inlineDiff = sanitized.inlineDiff;
      state.options = sanitized.options;
      state.editor = sanitized.editor;
      state.layout = sanitized.layout;
      state.sections = sanitized.sections;
      setSidebarWidth(state.layout.sidebarWidth);
      renderOptions();
      applyEditorOptions();
      updateEditorMode();
      syncToggles();
    }

    document.getElementById("formatterOpenBtn").addEventListener("click", () => {
      openViaDialog().catch((error) => context.showToast(`Open failed: ${error.message}`, true));
    });
    document.getElementById("formatterSaveBtn").addEventListener("click", () => {
      saveCurrent().catch((error) => context.showToast(`Save failed: ${error.message}`, true));
    });
    document.getElementById("formatterSaveAsBtn").addEventListener("click", () => {
      saveAs().catch((error) => context.showToast(`Save failed: ${error.message}`, true));
    });
    document.getElementById("formatterCopyBtn").addEventListener("click", () => {
      const text = currentText();
      if (!text) {
        context.showToast("Nothing to copy", true);
        return;
      }
      navigator.clipboard.writeText(text).then(
        () => context.showToast("Copied SQL"),
        () => context.showToast("Copy failed", true)
      );
    });
    document.getElementById("formatterClearBtn").addEventListener("click", () => {
      if (!clearEditor()) return;
      updateStatus("Interactive formatter is ready. All processing stays local to Pebloy.");
      context.showToast("Formatter cleared");
    });
    document.getElementById("formatterFindBtn").addEventListener("click", () => {
      activeEditor().getAction("actions.find")?.run();
    });
    document.getElementById("formatterReplaceBtn").addEventListener("click", () => {
      activeEditor().getAction("editor.action.startFindReplaceAction")?.run();
    });
    document.getElementById("formatterFormatBtn").addEventListener("click", () => {
      formatCurrentSql();
    });
    document.querySelectorAll("[data-formatter-preset]").forEach((button) => {
      button.addEventListener("click", () => applyPreset(button.dataset.formatterPreset));
    });

    compareToggle.addEventListener("change", () => {
      state.compareMode = compareToggle.checked;
      updateEditorMode();
      persist(0);
    });
    inlineToggle.addEventListener("change", () => {
      state.inlineDiff = inlineToggle.checked;
      applyEditorOptions();
      updateEditorMode();
      persist(0);
    });
    wrapToggle.addEventListener("change", () => {
      state.editor.wordWrap = wrapToggle.checked;
      applyEditorOptions();
      persist(0);
    });
    minimapToggle.addEventListener("change", () => {
      state.editor.minimapEnabled = minimapToggle.checked;
      applyEditorOptions();
      persist(0);
    });
    lineNumbersToggle.addEventListener("change", () => {
      state.editor.lineNumbers = lineNumbersToggle.checked;
      applyEditorOptions();
      persist(0);
    });

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      fileInput.value = "";
      loadTextIntoEditor(await file.text(), { fileName: file.name, filePath: file.path || "" });
    });

    mainModel.onDidChangeContent(() => {
      updateMetrics();
    });

    window.addEventListener("beforeunload", (event) => {
      if (currentText() === session.savedText) return;
      event.preventDefault();
      event.returnValue = "";
    });

    attachFileDrop();
    setSidebarWidth(state.layout.sidebarWidth);
    renderOptions();
    applyEditorOptions();
    updateEditorMode();
    syncToggles();
    updateStatus("Interactive formatter is ready. All processing stays local to Pebloy.");
    dropHint.textContent = "Drop a .sql or .txt file here, or open one from disk. Search, replace, folding, bracket matching, multiple cursors, and undo/redo are all local.";

    let resizeActive = false;
    resizer.addEventListener("mousedown", (event) => {
      resizeActive = true;
      event.preventDefault();
    });
    window.addEventListener("mousemove", (event) => {
      if (!resizeActive) return;
      const shellBounds = shell.getBoundingClientRect();
      const nextWidth = shellBounds.right - event.clientX;
      setSidebarWidth(nextWidth);
    });
    window.addEventListener("mouseup", () => {
      if (resizeActive) persist(0);
      resizeActive = false;
    });

    const themeObserver = new MutationObserver(() => {
      applyEditorOptions();
    });
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ["data-theme", "style"] });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });

    const resizeObserver = new ResizeObserver(() => {
      editor.layout();
      diffEditor.layout();
    });
    resizeObserver.observe(stage);

    return {
      applyPersistedState,
      destroy() {
        themeObserver.disconnect();
        resizeObserver.disconnect();
        clearInterval(session.progressTimer);
        editor.dispose();
        diffEditor.dispose();
        originalModel.dispose();
        mainModel.dispose();
      },
      getPersistedState,
      layout() {
        editor.layout();
        diffEditor.layout();
      },
    };
  }

  globalScope.PebloyFormatterWorkbench = {
    createFormatterWorkbench,
  };
})(window);