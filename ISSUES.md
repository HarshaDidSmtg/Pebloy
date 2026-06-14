# BDeploy — Known Issues

## Active Bugs (In Progress)

- No currently documented active bugs. See the sections below for known risks and improvement areas.

---

## Identified Issues

### Security

- **Context exposure by design:** Task logs intentionally retain non-secret operator context such as profile labels, object names, and artifact paths. Secret values are redacted, but environment names still appear in logs.
- **Encryption in transit:** While passwords are encrypted at rest using DPAPI, all API traffic currently runs over HTTP. HTTPS should be enforced for production deployments.

### Error Handling

- **Generic error messages:** Errors from backend services (`backupService`, `deploymentService`) are generic and do not provide actionable resolution steps.
- **PowerShell error propagation:** Errors from `DBObjectsBulkScriptGenerator.ps1` and `CompareTablesGenerateDelta.ps1` are not always surfaced clearly to the UI.

### Code Quality

- **Hardcoded paths:** Some services use hardcoded paths (e.g., `artifacts/temp`, script paths). Reduces portability across machines.
- **Redundant utility functions:** `normalizeAuthType` and `normalizeSqlName` in `scriptAutomationService.js` are duplicated in other places and could be centralized.

### Scalability

- **Large object lists:** Performance may degrade when handling 500+ objects for diff, backup, or deployment simultaneously.
- **Log file growth:** Task logs are stored as individual JSON files. No automatic archival or rotation is currently in place.

### UI/UX

- **Theme persistence scope:** Theme preference is stored per machine in `data/app-state.json`; it does not sync across devices or browsers.
- **PowerShell progress granularity:** Task bars now show stage-level progress, but deeply granular PowerShell step progress is still coarse for long-running script generation.

### Deployment Semantics

- **Synonym grouping rule undefined:** Duplicate selections are deduplicated safely, but there is still no documented business rule for additional “logical grouping” of different synonym names.

### Documentation

- **Troubleshooting gaps:** Advanced error scenarios (permission errors, module loading failures, partial deployment recovery) are not fully documented.
