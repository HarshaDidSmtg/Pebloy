# Pebloy — Improvements Roadmap

## Completed (v1.3.1)

- **Selection export parity** — saved object lists now match the visible filtered/sorted grid and include Type, Schema, Object, Created, and Modified headers.
- **Stage-based task progress** — Backup, Code Diff, and Deploy now emit stage text during execution instead of only generic running/completed states.
- **Log usability polish** — task summaries now carry both `.log` and `.json` paths, the Logs tab opens the preferred text log, and durations are shown as `mm:ss`.
- **Connection Alias output roots** — generated script output now nests under the selected Connection Alias before the date/database path.
- **Database-authoritative file casing** — generated schema/object folders, filenames, and `BuildPaths` entries now use resolved metadata casing from the database.
- **Duplicate deploy prevention** — duplicate selected objects, including synonyms, are deduplicated before deployment execution.

## Completed (v1.2.0)

- **App renamed to BDeploy** — Updated title, header, logo, package.json, notification title.
- **Logo fixed** — `index.html` referenced missing `new-logo.svg`; corrected to `logo.svg`.
- **Nothing OS UI redesign** — Pure black backgrounds, `#ff2340` red accent, flat buttons, dot-grid texture, Space Grotesk font applied to the Dark theme.
- **Label field improvements** — "Profile Label"→"Connection Name", "Server Name"→"SQL Server Host", "Destination"→"Target Database", etc.
- **Specify mode: bracket stripping** — `[dbo].[MyProc]` style inputs cleaned automatically.
- **Specify mode: UX simplified** — Single "Detect & Add Objects" button replaces two redundant buttons.
- **Discover grid: date+time columns** — Created and Modified timestamps (date + time) shown in the Discover object picker grid and Specify mode selection table.
- **Discover grid: header checkbox** — Replaces Select All / Unselect All buttons with indeterminate-state header checkbox.
- **Theme persistence fixed** — Spider-Man and Batman themes restored; theme selection persists through file-backed app state.
- **Font selector implemented** — Customize tab font selector applies and persists chosen font.
- **Font size slider** — Customize tab font size control (11–20 px) persisted in localStorage.
- **Font options expanded** — Added Space Grotesk, Fira Code, Segoe UI, Roboto, Poppins to the font selector.
- **Clear All Logs** — Button in Logs tab deletes all log files via `DELETE /api/logs`.
- **Desktop notifications toggle** — Customize tab toggle enables/disables desktop task notifications.
- **Default path settings** — Customize tab inputs pre-fill Backup and Deploy script-output folder paths on app start.
- **Fullscreen maximize/restore** — ↗/↙ buttons on "Enter Objects" and "Diff Viewer" sections expand the panel to cover the full screen; ESC restores.
- **Inline theme swatches** — Customize tab shows theme swatches so theme can be changed without going to the header.
- **Tab order updated** — Tabs reordered to match workflow: Credentials → Objects → Code Diff → Backup → Deployment → Logs → Customize.
- **Desktop launcher refreshed** — Launch scripts now start Electron directly, refresh the desktop shortcut, and use the BDeploy logo icon assets.
- **DDL keyword normalization** — SMO line-break splits (`CREATE\nPROCEDURE`) collapsed to single-line at source (PowerShell), deploy, and diff layers — eliminates spurious code diff results.
- **Script whitespace trimming** — Generated scripts trimmed before storing or diffing; no leading/trailing blank lines in artifacts.
- **Security: CompareTablesGenerateDelta.ps1** — Removed hardcoded server IPs, database names, usernames, and plaintext passwords from default parameter values.
- **Security: DBObjectsBulkScriptGenerator.ps1** — Removed hardcoded default `ObjectListPath`.

---

## Future Enhancements

### Strategic Direction

- Keep SQL Server as the first-class platform while evolving the core engine toward production-grade, long-term maintainability.
- Prioritize deterministic script generation, fast execution, reliability under large object sets, and safe deployment behavior over short-term feature count.
- Treat Backup-generated artifacts as a trusted source format with strict validation rules instead of allowing arbitrary folder inputs.

### Customizable Formatting Options

- Add configurable formatting profiles for generated SQL so teams can choose between strict canonical output and house-style output.
- Support per-object-type formatting preferences where needed, while keeping a default production-safe formatting profile for backup, diff, and deploy flows.
- Add a formatting preview so users can see exactly how a script will be normalized before it is used in Code Diff or Deploy.
- Keep formatting deterministic so the same input always generates the same output, reducing noisy diffs and improving review quality.
- Validate that configurable formatting never breaks executable batches, session-setting headers, object ordering, or deployment safety.

### Folder-As-Source Workflows

- Enable Code Diff to use a folder generated by Backup mode as the source instead of requiring a live source database.
- Enable Deploy to use a folder generated by Backup mode as the source for deployment artifacts.
- Restrict folder-based source mode to Pebloy Backup-generated folders only; do not accept arbitrary hand-built folder structures.
- Add manifest validation for folder-based source mode, including object list, object type, schema, object name, generation timestamp, connection alias, database name, and artifact version.
- Add hash/signature validation so the app can detect tampered, incomplete, stale, or mixed-run artifact folders before compare or deploy starts.
- Warn when the folder source was generated from a different app version or schema manifest version than the current runtime.

### Support for Other SQL Engines

- Introduce a provider-based architecture so scripting, metadata lookup, diffing, and deployment are no longer hardwired only to SQL Server.
- Add a capability matrix per provider instead of assuming all database engines support the same object model or deployment semantics.
- Start with a clear provider contract covering: discovery, scripting, diff, deployment, object dependency ordering, session settings, and validation.
- Keep SQL Server as the reference implementation until provider parity and test coverage for additional engines are proven.
- Evaluate future support for PostgreSQL, MySQL, Oracle, and other engines only through provider-specific implementations, not one generic lowest-common-denominator path.

### Migration to .NET Core Engine

- Migrate the core scripting/diff/deployment engine from PowerShell orchestration toward a typed .NET helper or service while keeping the current UI shell in Node/Electron.
- Use .NET for direct access to SMO, DacFx, and other SQL Server libraries where stronger typing, better testability, and better performance are needed.
- Keep PowerShell only where it remains the best operational wrapper, or phase it out once feature parity is achieved.
- Design the .NET engine with stable contracts for: object extraction, manifest generation, diff computation, deployment planning, table delta generation, and validation.
- Perform the migration incrementally so existing output structure, naming conventions, and Backup-generated folder compatibility are preserved.

### Production-Grade Script Quality

- Add generation quality gates so produced SQL is validated before it is accepted for backup, diff, or deploy use.
- Verify session-setting correctness (`SET ANSI_NULLS`, `SET QUOTED_IDENTIFIER`, batch separators, executable ordering) for programmable objects.
- Add parser/build validation for generated SQL wherever practical, including SQL project or dacpac-oriented validation for SQL Server artifacts.
- Add golden-file regression tests for representative procedures, views, functions, triggers, tables, synonyms, sequences, and user-defined types.
- Ensure object generation remains deterministic across runs for the same source metadata.
- Add artifact-level warnings when a generated script had to fall back to a lower-fidelity path.

### Performance, Reliability, and Long-Term Use

- Optimize large selection handling with better batching, streaming, and concurrency controls while keeping progress reporting accurate.
- Add resumable task execution and retryable task slices for long-running backup, diff, and deploy operations.
- Add manifest-aware caching so repeated folder-based operations do not re-parse every file unnecessarily.
- Improve deployment planning with stronger dependency handling, more reliable ordering, and explicit detection of blocking prerequisites.
- Add richer observability: per-object timings, bottleneck metrics, artifact validation results, and root-cause summaries for failures.
- Define clear backward-compatibility rules for generated artifact versions so teams can rely on Pebloy for long-term operational use.

### Suggested Implementation Principles

- No compromise on generated script quality for convenience features.
- New source modes must be auditable, versioned, and reproducible.
- New database providers must plug into a formal contract, not ad hoc conditionals.
- Migration work must preserve existing PowerShell folder structure and artifact naming until the replacement engine fully proves parity.

## UI/UX Modernization

- Redesign the UI to feel like a fusion of Azure DevOps, GitHub Desktop, and minimal Nothing OS aesthetics.
- Interface should feel minimal, fluid, developer-centric, and productivity-focused.
- Use smooth transitions, subtle gradients, clean spacing, rounded corners, compact layouts, and soft shadows where appropriate.
- Improve dark mode polish.
- Rename unclear labels, buttons, and fields to technically meaningful names.
- Ensure naming consistency across tabs, forms, logs, deployment sections, backup sections, and compare sections.

### Suggested Tab Order (by workflow + frequency)

1. Dashboard
2. Code Diff
3. Backup
4. Deploy
5. Object Explorer
6. Logs
7. Settings
8. About

---

## Theme System (v1.3+ Planned)

- Improve overall theme engine architecture — themes should dynamically affect icons, hover states, and borders beyond background/text color.
- Add more developer-friendly themes (e.g., Dracula, Monokai, Nord).
- Sync theme preference across devices (requires shared backend profile storage).
- See [THEMES.md](THEMES.md) for full theme documentation.

---

## Branding

- Evaluate whether the current app name and logo can be improved.
- If a better name/logo is possible: generate modern alternatives, maintain DevOps/database tooling identity, keep branding minimal and professional.
- Logo should work for: GitHub repo, desktop app, web app, installer icon, favicon.

---

## Logging Improvements

- Reduce log file size — current logs are excessively verbose.
- Remove duplicate log entries.
- Avoid dumping entire object contents unless necessary.
- Store only meaningful execution details per event.

### Planned Logging Features (v1.3+)

- Log rotation with configurable max file size
- Timestamp grouping in log viewer
- Log filtering by: Error / Warning / Info / Deployment / Backup / Compare

### Sensitive Data Protection

Ensure logs never expose:

- Passwords
- Connection strings
- Server credentials
- Authentication tokens

---

## Security Improvements

- Remove all hardcoded server names, IPs, usernames, and passwords from PowerShell scripts.
- Replace with config-driven approach: environment variables, encrypted local settings, or secure credential prompts.
- Audit all PowerShell scripts for security issues and unsafe execution patterns.
- Implement HTTPS for all API endpoints in production mode.
- Use environment variables for all sensitive configurations instead of any hardcoded values.
- Regularly audit log output for accidental sensitive data exposure.

---

## Error Handling Improvements

- Provide detailed error messages with potential resolution steps.
- Implement a centralized error-handling middleware in the Express backend.
- Surface PowerShell script errors clearly with the failing object name and script line.
- Partial deployment recovery: after a failure, allow retrying only the failed objects.

---

## Scalability

- Paginate large object lists in the UI (virtual scrolling for 500+ objects).
- Archive old task logs to a separate storage location automatically.
- Batch database calls efficiently to avoid per-object round trips.

---

## GitHub Readiness

- Ensure `.gitignore` excludes `data/`, `artifacts/`, `.env`, and all generated/temp files.
- Verify `LICENSE` file is present and accurate.
- Establish a versioning strategy (semver).
- Ensure no sensitive data exists anywhere in the repository or git history.
- Clean, consistent commit history.

---

## Additional Features (Future Phases)

1. **Deployment Plan Preview** — Show exact ordered execution plan before running.
2. **Approval Workflow** — Require reviewer approval before PROD deployments.
3. **Dry Run Mode** — Validate deployment without executing changes.
4. **Rollback Assistant** — Auto-generate rollback scripts where possible.
5. **Object Dependency Visualizer** — Graph view of object dependencies.
6. **Scheduling and Automation** — Run backup/diff/deploy as scheduled jobs.
7. **Notifications** — Email/Teams/Slack alerts on task success or failure.
8. **Environment Guardrails** — Block dangerous operations (e.g., deploy to PROD from wrong source).
9. **Artifact Versioning** — Store generated scripts and diffs with version tags.
10. **Search and Filter at Scale** — Fast filtering for 10,000+ object databases.
11. **CLI Companion** — Optional command-line mode for CI/CD pipelines.
12. **Import/Export Profiles** — Backup and migrate credential profile metadata safely (without secrets).
