# BDeploy — Security Notes

## Password Storage

- SQL Server passwords are encrypted with **Windows DPAPI** via `ConvertTo-SecureString` and stored as opaque ciphertext in `data/secrets.json`.
- Encrypted values cannot be decrypted on a different machine — they are tied to the Windows user account that created them.
- Passwords are never stored in plaintext, never printed in logs, and never transmitted in API responses.

## SQL Injection Prevention

- All database queries use parameterized literals via `escapeSqlLiteral` throughout `sqlService.js`.
- Object names and schema names are sanitized before being interpolated into generated scripts.

## Log Sanitization

Logs must never contain:

- Passwords or credentials
- Connection strings with embedded credentials
- Server-internal identifiers or tokens

All log events are reviewed before write to ensure no sensitive values are included.
`loggingService.js` redacts common sensitive keys such as `password`, `secret`, `secretReference`, `cipher`, `pwd`, and `credentials` before task events are written.

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

## API Security

- The Express API currently listens on localhost only (not exposed to the network in default configuration).
- HTTPS is not enabled by default but is recommended for any deployment accessible over a network.
- No authentication layer is currently implemented — BDeploy is designed for single-user local use.

## Reporting Security Issues

Do not open public issues for security vulnerabilities. Use GitHub private
vulnerability reporting if the repository has it enabled, or another private
maintainer channel for the published project.
