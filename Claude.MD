# Prompt – Implement Correct Backup, CodeDiff, Deploy, and Object Discovery Logic in Existing DB Object Management App

Implement the following fixes and architectural changes in the existing application. The app already exists and the current logic is partially working, but several behaviors are incorrect and need to be redesigned properly.

The implementation must strictly preserve:
- Existing PowerShell script behavior
- Existing folder structure
- Existing file naming conventions
- Existing script output format

Do NOT redesign the folder structure or rename generated files unless explicitly required by the existing PowerShell scripts.

---

# CORE MODES

The application has 3 major modes:

1. Backup Mode
2. CodeDiff Mode
3. Deploy Mode

Each mode must behave exactly as described below.

---

# 1. BACKUP MODE

## Purpose

Backup mode ONLY generates DB object scripts and stores them in folders.

It is NOT:
- Full backup mode
- Differential backup mode
- Incremental backup mode

Remove any references or logic related to:
- Full backup
- Differential backup
- Incremental backup

Those concepts are irrelevant for this application.

---

## Required Behavior

Backup mode should:

1. Read selected object list
2. Generate scripts for those objects from the selected source database
3. Save generated scripts into folders using the exact existing PowerShell folder structure and nomenclature
4. NOT compare anything
5. NOT deploy anything
6. NOT execute any scripts

---

## Script Generation Logic

Backup mode should internally reuse the same script generation logic used by CodeDiff mode.

Meaning:
- Object extraction logic should be centralized/shared
- Folder creation logic should be centralized/shared
- Script generation process should be identical

Only the comparison/deployment behavior differs between modes.

---

# 2. CODEDIFF MODE

## Purpose

CodeDiff mode compares DB object scripts between DB1 and DB2.

---

## Required Workflow

### Step 1 – Generate Scripts

Generate object scripts from:
- Source DB (DB1)
- Target DB (DB2)

using the selected object list.

---

### Step 2 – Folder Structure

Create separate folders:

- DB1 objects folder
- DB2 objects folder

using the exact same PowerShell-generated structure and naming convention.

Example conceptually:

/Output
    /DB1
    /Procedures
    /Tables
    /Functions

    /DB2
    /Procedures
    /Tables
    /Functions

Do NOT redesign the structure if PowerShell scripts already define one.

---

### Step 3 – Comparison

After generation:
- Compare scripts line-by-line
- Produce meaningful diff output
- Show:
  - Added lines
  - Removed lines
  - Modified lines

Comparison must happen using freshly generated scripts from DB1 and DB2.

---

## Critical Fix Required

Currently CodeDiff compares against already generated/stale files.

This is WRONG.

Every CodeDiff execution must:
1. Pull latest object definitions directly from DB1 and DB2
2. Regenerate scripts
3. Then compare

Never compare old generated files.

---

## CodeDiff Must NOT

- Deploy scripts
- Execute scripts
- Modify databases

It is comparison-only.

---

# 3. DEPLOY MODE

## Purpose

Deploy mode is the ONLY mode that executes scripts against the target database.

No execution should happen in:
- Backup mode
- CodeDiff mode

---

# Deployment Rules By Object Type

Deployment logic must differ based on object type.

---

## A. Stored Procedures

The PowerShell scripts already generate:
- Combined stored procedure deployment file

Deploy mode should:
1. Use that combined SP deployment script
2. Execute it directly against target DB

Do NOT split procedure deployment unnecessarily.

---

## B. Tables

For tables:
- We must NOT use simple drop/recreate

Instead:

1. Generate delta script between source DB and target DB
2. Use the existing CompareTablesGenerateDelta PowerShell script
3. Generate ALTER/delta migration script
4. Execute delta script against target DB

This is mandatory because tables contain data.

---

## C. Other Object Types

For object types like:
- Views
- Synonyms
- Functions
- Sequences
- User-defined table types
- Other non-data-holding objects

Use:
- DROP + CREATE approach

Deploy mode should:
1. Generate combined script
2. Drop existing object if exists
3. Recreate object

This is acceptable because these objects do not hold persistent data.

---

# OBJECT DISCOVERY MODE FIXES

The discover/specify functionality currently has multiple issues.

Fix all of them.

---

# 1. Full Specify Issue

## Current Problem

When user:
- Pastes object name
- Selects object type
- Clicks "Add Full Specify Info"

The app always shows:
- PROCEDURE

even when the object is:
- View
- Function
- Table
- Synonym
- Sequence
etc.

This is incorrect.

---

## Required Fix

The system must:
1. Query actual object metadata from database
2. Detect true object type
3. Display:
   - Correct object type
   - Correct schema
   - Correct object name

Example:

dbo.usp_Test → PROCEDURE
dbo.vw_Test → VIEW
dbo.fn_Test → FUNCTION

Do NOT hardcode PROCEDURE.

---

# 2. Discover Object List Improvements

## Current Problem

Discover mode returns object list properly,
but there is no:
- Select All
- Unselect All

This makes bulk selection difficult.

---

## Required Fix

Add:
- Select All checkbox/button
- Unselect All checkbox/button

Behavior:
- Select all visible discovered objects
- Unselect all visible discovered objects

Should work efficiently even for large lists.

---

# EXECUTION RULES

## IMPORTANT

Script execution must happen ONLY in Deploy Mode.

Never execute scripts in:
- Backup
- CodeDiff
- Discover

Backup = script generation only
CodeDiff = comparison only
Deploy = execution only

Keep these responsibilities strictly isolated.

---

# ARCHITECTURE REQUIREMENTS

Refactor implementation to avoid duplicated logic.

Recommended architecture:

## Shared Services

### ScriptGenerationService
Responsible for:
- Object extraction
- Script generation
- Folder creation
- Naming convention preservation

Used by:
- Backup
- CodeDiff
- Deploy

---

### DiffService
Responsible for:
- Line-by-line comparison
- Diff generation

Used only by:
- CodeDiff

---

### DeploymentService
Responsible for:
- SP execution
- Table delta execution
- Drop/recreate deployment

Used only by:
- Deploy

---

### ObjectDiscoveryService
Responsible for:
- Metadata lookup
- Object type detection
- Discover mode queries

---

# PERFORMANCE REQUIREMENTS

- Avoid regenerating scripts unnecessarily
- Use async execution where possible
- Batch DB calls efficiently
- Handle large object lists properly
- Do not freeze UI during generation/comparison/deployment

---

# ERROR HANDLING

Implement proper handling for:
- Missing objects
- Invalid schemas
- DB connection failures
- PowerShell execution failures
- Delta generation failures
- Script execution failures
- Permission issues

Display meaningful logs/errors.

---

# LOGGING

Add detailed logging for:
- Object generation
- Diff generation
- Deployment execution
- Delta script generation
- PowerShell calls
- Failed objects

---

# UI REQUIREMENTS

Clearly separate:
- Backup
- CodeDiff
- Deploy

Show:
- Current mode
- Current DB connections
- Object counts
- Progress indicators
- Execution logs

Deploy mode must show:
- Which object is being deployed
- Deployment status
- Success/failure

---

# FINAL EXPECTED RESULT

After implementation:

## Backup Mode
- Generates scripts only

## CodeDiff Mode
- Regenerates latest scripts from DB1 + DB2
- Compares line-by-line
- No execution

## Deploy Mode
- Executes deployments correctly by object type
- SPs = combined execution
- Tables = delta deployment
- Other objects = drop/recreate

## Discover Mode
- Correct object type detection
- Select All / Unselect All support

All while preserving:
- Existing PowerShell behavior
- Existing folder structure
- Existing naming conventions
- Existing script generation format

Do not redesign the PowerShell conventions.

---

# IMPLEMENTATION STATUS NOTE — 2026-05-28

The current workspace implementation now also reflects the following session updates:

- Selected-object export matches the visible filtered/sorted grid and includes Created / Modified columns.
- UI dates are standardized to `dd:mm:yyyy`, log timestamps to `dd:mm:yyyy hh:mm:ss`, and durations to `mm:ss`.
- Backup, CodeDiff, and Deploy emit stage-specific progress text; Deploy still reports per-object execution status.
- Shared script-generation output now nests under Connection Alias → date → database.
- `DBObjectsBulkScriptGenerator.ps1` now writes schema/object paths using resolved database metadata casing.
- Deploy execution deduplicates repeated selected objects before execution, including duplicate synonyms.
- Logs now retain both `.log` and `.json` artifact paths, and the UI Open File action prefers the text log.

This note supplements the original request document; it does not replace the original requirements above.