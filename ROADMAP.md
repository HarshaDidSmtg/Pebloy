# Pebloy — Roadmap

Tracked improvements and planned features. Items are grouped by scope; there are no committed release targets.

## Review Follow-Up

Implemented locally: mode isolation; fresh/literal-sensitive diffs; combined
procedure and table execution guards; SQL-aware batch handling; bounded workers;
credential transport and rotation; local API/IPC protection; atomic writes and log
checkpoints; paginated selection; reconnect progress; dirty-editor protection;
Windows CI and unpacked-app smoke tests. See [the changelog](CHANGELOG.md) and
[security notes](SECURITY.md) for the changed contracts.

The follow-up implementation restores Format & Execute as a confirmed source
action available only from Backup, adds dynamic deployment order and required plan
confirmation, OS-managed runtime ownership, preference recovery,
PID-reuse-safe Interrupted detection, task-registry shutdown draining, signer
certificate pinning, and distinct ReviewRequired migration results. Offline tests
cover these paths. SQL fixtures now include row retention and injected-failure
rollback checks, but those live cases have not been executed.

The remaining gates need an authorized environment or a database-owner decision:

1. **Live execution (on hold):** authorize two disposable `_PebloyTest` databases and run the guarded suite, including source formatting and failure injection. Shared DEV/INT databases must not be seeded.
2. **Release installation (on hold):** provision signing outside chat and verify an actual signed installer/update. Updates pin the current app's certificate; certificate changes require a separately verified manual upgrade. Remote CI still needs a published branch and an authorized workflow run.
3. **Interrupted SQL reconciliation:** addressed as far as it can be without live validation. Deploy now has a **Dry Run** mode that writes every script without executing, and an interrupted, failed, or review-required task offers a read-only **Verify Target** check comparing the target's current module definitions against the source. Force-cancellation and automatic retries remain unavailable: neither this check nor the runtime locks can prove whether an aborted transaction committed, and only a live disposable environment can establish that.
4. **Metadata migrations:** guarded refusals are no longer dead ends. **Generate migration script** captures the target's permissions, ownership, signatures, sequence current value, and dependent objects into a reviewable scaffold under `artifacts/exports/migration-prep`. Pebloy never executes that scaffold and still refuses to drop protected objects; authoring and running the migration stays a deliberate human decision.

---

## Near-Term Improvements

### Connections

- **Connection profile grouping: implemented locally.** Optional Group values organize connection rows and native dropdowns and survive import/export.

- **SQL Server module helper: implemented locally.** Read-only pinned-module status and explicit installation for source runs; packaged missing resources require installation repair.

### Object Discovery

- **Discover page size: implemented locally.** Persisted 25/50/100 choices preserve selection.

### Build

- **Clean-runner validation** — the current builder prepares missing icons, pinned SMO, and self-contained DacFx resources. Run the optional Windows package-smoke CI job on a clean hosted runner; local cached-tool success is not proof of first-run provisioning. The old prebuild workaround is no longer invoked.

### Logging

- **Log retention: implemented locally.** Configurable archive-age previews require explicit confirmation, expire, and reject changed file lists. No automatic deletion occurs. Text-log trimming preserves selected objects; JSON retains complete events.

---

## Medium-Term Features

### Folder-as-Source Workflows

Implemented locally through explicit SQL Folder selection, fresh ScriptDom inspection, source-preserving copies, content fingerprints, and the existing guarded deployment path. Offline tables can be compared but cannot be deployed; mandatory table deltas still require two live databases. Folder module SET metadata defaults to ON unless supplied in the file.

### SQL Parser / Build Validation (DacFx)

The .NET 8 DacFx worker now provides offline compiler validation and optional
comparison. Expand reference/compatibility coverage as needed; deployment remains
PowerShell-first and explicitly rejects the DacFx execution engine.

### Check for Updates — Release Publishing

The updater flow is covered by service tests, including trusted URLs, hashes, and
signature refusal. A real update requires a semantic-versioned GitHub release with
a signed non-portable Setup `.exe`, a GitHub SHA-256 asset digest, and validation of
the actual install flow. Nothing in the validation workflow publishes a release.

### Diff Export Improvements

- Implemented locally: Markdown, HTML, JSON, and standalone syntax-highlighted HTML.
- Implemented locally: Markdown clipboard copying and Ctrl+Shift+C from Code Diff without regenerating the report.

### Deploy — Dry-Run Report

Implemented as the **Dry Run** execution mode: it generates every deployment script, including the table delta, writes them to the run's `Deployment Scripts` folder for SSMS review, and executes nothing.

---

## Longer-Term / Exploratory

### Multi-Database Batch Operations

Multi-database deployment is implemented locally: up to 20 distinct resolved targets, sequential execution, combined reviewed plans, per-target logs/results/output roots, and explicit stop/continue policies. No cross-database transaction is claimed.

### Scheduled Deployments

Implemented locally: reviewed once/daily/weekly jobs, app-open execution, optional Windows Task Scheduler wake-up through the ScheduledTasks API, no embedded credentials, no overlap/backlog replay, and reapproval after changed plans or uncertain outcomes. Windows wake-up requires a signed-in user. Native registration is covered with mocked process tests; actual registration and live SQL execution remain user-confirmed operations.

### Dark Mode Auto-Detection

Implemented locally: first-launch `prefers-color-scheme` following and an explicit Follow system checkbox. Existing named themes remain preserved.

### Integration Test Database

The integration suite is opt-in and requires two distinct databases ending in
`_PebloyTest`, with configured/resolved identity checks and tracked guarded fixtures.
CI deliberately disables it. Provision dedicated disposable SQL infrastructure and
separate credentials before enabling live database execution in automation.

---

## Known Limitations

| Area | Limitation |
| ---- | ---------- |
| Platform | Windows only — DPAPI and PowerShell SMO are Windows-specific. No Linux/macOS support planned. |
| SQL Server | Tested against SQL Server 2016–2022. Azure SQL and SQL Managed Instance may work but are not validated. |
| Tables | Delta generation requires both databases live. Folder scripts support textual table comparison, not offline table deployment. |
| Release packaging | Unpacked Windows builds and native file smoke tests pass locally. A clean hosted run and an actual signed-installer/update test remain release gates. |
| Exact definitions | Some object types (synonyms, sequences, UDTs) do not have exact-definition metadata and fall back to SMO-generated scripts, which may differ slightly in whitespace or casing from the original DDL. |
