# Pebloy — Security Notes

## Password Storage

- SQL Server passwords are encrypted with **Windows DPAPI** via `ConvertTo-SecureString` and stored as opaque ciphertext in `data/secrets.json`.
- Encrypted values cannot be decrypted on a different machine — they are tied to the Windows user account that created them.
- App-managed passwords are passed to PowerShell over stdin, not embedded in temporary wrapper files or command-line arguments. Base64 is transport encoding, not encryption.
- DPAPI calls have a 15-second bound. Decrypted secrets have a bounded in-process cache; local code running as the same Windows user is outside this protection boundary.
- Credential rotation preserves the previously referenced secret until the profile write succeeds. Writes use unique atomic replacement files. Settings/app state also have last-known-good recovery; credentials intentionally do not automatically revert to older values.

## SQL Injection Prevention

- Metadata queries escape SQL literals using `escapeSqlLiteral`; these are escaped query strings, not parameterized commands.
- Identifiers are quoted/escaped where interpolated. API object names are limited to 128 characters and reject control-line/null characters; object arrays are bounded.
- SQL-aware batch splitting and normalization preserve comments and literals. Generated SQL still requires review; validation is not an SQL sandbox.

## Log Sanitization

Logs must never contain:

- Passwords or credentials
- Connection strings with embedded credentials
- Session tokens

The logging service redacts common sensitive keys such as `password`, `secret`,
`secretReference`, `cipher`, `pwd`, and `credentials`, including final summaries.
Redaction is best-effort: free-text SQL/errors and artifacts can contain sensitive
business data, server names, and object definitions. Review logs before sharing and
restrict access to the runtime directories.

## File Exclusions

The following directories are excluded from git and should never be committed:

- `data/` — contains profiles and encrypted secrets
- `artifacts/` — contains generated scripts, logs, and exports
- `.env` — contains environment variable overrides

These are listed in `.gitignore`.

## PowerShell Scripts

- PowerShell scripts must not contain hardcoded server names, IP addresses, usernames, or passwords.
- All connection parameters are passed dynamically by the Node.js service layer at runtime.
- Scripts should be audited periodically for accidental credential exposure.

## Local Trust Boundary

- The API binds to loopback and validates Host/Origin, including the port. Opaque and cross-site browser origins are rejected.
- Mutations require `X-Pebloy-Token`, obtained from the same-origin `/api/session` endpoint. This is browser request protection, not multi-user authentication or protection from other local processes.
- Do not expose the API through a public listener, tunnel, or reverse proxy. Remote/multi-user deployment is unsupported.
- Electron IPC accepts only the main frame at the current app origin. File writes require a native-dialog-issued token, `.sql`/`.txt` extension, size limit, and an unchanged file hash before overwrite. Unsaved SQL requires confirmation before discard.

## Deployment Safety

Backup and CodeDiff do not execute generated SQL. Deployment rejects matching
resolved source/target databases for ordinary deployment, unknown modes, unsupported engines, missing fresh
source scripts, and dependency cycles between mandatory execution groups.

Every Deploy run, including Dry Run and rollback validation, requires an ordered
plan confirmation in the UI. The API requires the plan fingerprint; execution
rechecks current selected-object dependencies and configured connection identities
before generating SQL. A changed plan or failed metadata lookup blocks execution.
The fingerprint detects plan drift, not SQL-definition changes, and is not an
authentication mechanism. Dynamic SQL and external references still need review.

Format & Execute is available only from Backup's formatting menu. Its confirmation
shows a source-execution plan; the request targets the source profile through the
guarded deployment service without changing the Deployment tab's target selection.
It requires confirmation of that source database on every request.
It formats and reapplies programmable modules only; tables and
other non-module objects are skipped. This action modifies the source database and
uses the same guarded execution strategies as other deployment actions.

Procedures use the combined artifact; tables use the existing delta generator;
other objects use guarded DROP/CREATE. DROP/CREATE requires metadata visibility and
refuses objects with explicit grants, ownership, or signatures. Referenced types
require a reviewed migration; the app does not drop unselected dependencies.
These guards refuse unsafe work, rather than automatically preserving every kind
of metadata. CREATE OR ALTER also refuses signed modules unless handled through a
reviewed re-signing migration. Known guard refusals are reported as ReviewRequired,
not success or an automatic retry. Sequence recreation resets sequence state and
must be reviewed.

Atomicity is per group/object. Earlier successful groups can remain committed when
later work fails. Rollback validation executes real SQL, and cannot undo every
external/non-transactional effect or protect against SQL that controls its own
transactions. Timeout, missing execution output, and Interrupted task status mean
the outcome must be checked against the target before retrying. Forced process
termination is not safe cancellation. Do not close/kill the app during deployment.

Each backend exclusively owns its configured data/artifact directories through
OS-managed Windows named pipes. Normal shutdown waits for tasks even after client
disconnection. A unique runtime ID distinguishes abandoned tasks from reused PIDs.
External writers and older app versions bypass these locks and are unsupported on
shared runtime directories. Settings recovery preserves corrupt evidence and warns
operators; if both copies are invalid, loading fails rather than silently resetting.

## Updates and Release Gates

The updater permits only this project's HTTPS GitHub release paths and approved
GitHub asset redirect hosts. It verifies the release asset's SHA-256 digest and a
Valid Authenticode signature before launch, with download and verification limits.
Unsigned assets or missing digests are refused. The installer certificate thumbprint
must match the currently running application's valid signer. Unsigned development
builds cannot establish that trust. Certificate rotation requires an independently
verified manual installation; no renderer-provided pin can bypass the check.

Release approval still requires testing on two authorized disposable SQL databases
and validation of the actual signed installer. Offline tests and unpacked desktop
smoke tests do not replace those gates. Live tests are opt-in and require database
names ending in `_PebloyTest`; never bypass that protection for shared databases.

## Reporting Security Issues

Do not open public issues for security vulnerabilities. Use GitHub private
vulnerability reporting if the repository has it enabled, or another private
maintainer channel for the published project.
