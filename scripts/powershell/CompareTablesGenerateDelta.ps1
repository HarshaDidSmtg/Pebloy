param(
    [string]$SourceServer = "",
    [string]$SourceDatabase = "",
    [string]$TargetServer = "",
    [string]$TargetDatabase = "",
    [string]$ObjectListPath = "",
    [string]$OutputPath = "",

    [ValidateSet("Windows", "Sql")]
    [string]$SourceAuthenticationType = "Windows",

    [string]$SourceUsername = "",
    [string]$SourcePassword = "",

    [ValidateSet("Windows", "Sql")]
    [string]$TargetAuthenticationType = "Windows",

    [string]$TargetUsername = "",
    [string]$TargetPassword = "",

    [switch]$IncludeForeignKeys = $true,
    [switch]$IncludeTriggers = $true
)

$ErrorActionPreference = "Stop"
if ($env:PEBLOY_CREDENTIAL_STDIN -eq "1") {
    $credentialInput = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())) | ConvertFrom-Json
    $SourcePassword = [string]$credentialInput.SourcePassword
    $TargetPassword = [string]$credentialInput.TargetPassword
    Remove-Variable credentialInput
}

function Ensure-Directory {
    param([Parameter(Mandatory)][string]$Path)

    if (!(Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Quote-SqlName {
    param([Parameter(Mandatory)][string]$Name)

    return "[" + $Name.Replace("]", "]]") + "]"
}

function Quote-SqlLiteral {
    param([AllowNull()][string]$Value)

    if ($null -eq $Value) {
        return "NULL"
    }

    return "N'" + $Value.Replace("'", "''") + "'"
}

function Get-QualifiedName {
    param(
        [Parameter(Mandatory)][string]$SchemaName,
        [Parameter(Mandatory)][string]$ObjectName
    )

    return "$(Quote-SqlName $SchemaName).$(Quote-SqlName $ObjectName)"
}

function Get-UnquotedQualifiedName {
    param(
        [Parameter(Mandatory)][string]$SchemaName,
        [Parameter(Mandatory)][string]$ObjectName
    )

    return "$SchemaName.$ObjectName"
}

function Convert-Script {
    param([Parameter(Mandatory)]$Script)

    $sb = [System.Text.StringBuilder]::new()
    foreach ($line in $Script) {
        $null = $sb.AppendLine($line)
    }

    return $sb.ToString()
}

function Add-Batch {
    param(
        [System.Collections.Generic.List[string]]$Batches,
        [Parameter(Mandatory)][string]$Sql
    )

    $clean = $Sql.Trim()
    if ([string]::IsNullOrWhiteSpace($clean)) {
        return
    }

    $Batches.Add($clean)
}

function Indent-Sql {
    param([Parameter(Mandatory)][string]$Sql)

    return (($Sql.Trim() -split "`r?`n" | ForEach-Object { "    $_" }) -join "`r`n")
}

function Escape-DynamicSql {
    param([Parameter(Mandatory)][string]$Sql)

    return $Sql.Trim().Replace("'", "''")
}

function New-IfTableMissingSql {
    param(
        [Parameter(Mandatory)][string]$SchemaName,
        [Parameter(Mandatory)][string]$TableName,
        [Parameter(Mandatory)][string]$Sql
    )

    $objectLiteral = Quote-SqlLiteral (Get-UnquotedQualifiedName $SchemaName $TableName)
    return "IF OBJECT_ID($objectLiteral, N'U') IS NULL`r`nBEGIN`r`n$(Indent-Sql $Sql)`r`nEND"
}

function New-IfColumnMissingSql {
    param(
        [Parameter(Mandatory)][string]$SchemaName,
        [Parameter(Mandatory)][string]$TableName,
        [Parameter(Mandatory)][string]$ColumnName,
        [Parameter(Mandatory)][string]$Sql
    )

    $objectLiteral = Quote-SqlLiteral (Get-UnquotedQualifiedName $SchemaName $TableName)
    $columnLiteral = Quote-SqlLiteral $ColumnName
    return "IF OBJECT_ID($objectLiteral, N'U') IS NOT NULL AND COL_LENGTH($objectLiteral, $columnLiteral) IS NULL`r`nBEGIN`r`n$(Indent-Sql $Sql)`r`nEND"
}

function New-IfColumnDifferentSql {
    param(
        [Parameter(Mandatory)]$Column,
        [Parameter(Mandatory)][string]$Sql
    )

    $objectLiteral = Quote-SqlLiteral (Get-UnquotedQualifiedName $Column.SchemaName $Column.TableName)
    $columnLiteral = Quote-SqlLiteral $Column.ColumnName
    $typeLiteral = Quote-SqlLiteral ([string]$Column.DataType)
    $typeSchemaPredicate = if ($Column.IsUserDefined) {
        "OR SCHEMA_NAME(ty.schema_id) <> $(Quote-SqlLiteral $Column.DataTypeSchema)"
    } else { "" }
    $collationPredicate = if ([string]::IsNullOrWhiteSpace($Column.CollationName)) {
        "c.collation_name IS NULL"
    }
    else {
        "ISNULL(c.collation_name, N'') = $(Quote-SqlLiteral $Column.CollationName)"
    }

    $expectedNullable = if ($Column.IsNullable) { 1 } else { 0 }
    $predicate = @"
EXISTS (
    SELECT 1
    FROM sys.columns c
    JOIN sys.types ty ON ty.user_type_id = c.user_type_id
    WHERE c.object_id = OBJECT_ID($objectLiteral, N'U')
      AND c.name = $columnLiteral
      AND (
                 ty.name <> $typeLiteral
             $typeSchemaPredicate
          OR c.max_length <> $($Column.max_length)
          OR c.precision <> $($Column.precision)
          OR c.scale <> $($Column.scale)
          OR c.is_nullable <> $expectedNullable
          OR NOT ($collationPredicate)
      )
)
"@.Trim()

    return "IF $predicate`r`nBEGIN`r`n$(Indent-Sql $Sql)`r`nEND"
}

function New-IfDefaultMissingSql {
    param(
        [Parameter(Mandatory)]$Column,
        [Parameter(Mandatory)][string]$Sql
    )

    $objectLiteral = Quote-SqlLiteral (Get-UnquotedQualifiedName $Column.SchemaName $Column.TableName)
    $columnLiteral = Quote-SqlLiteral $Column.ColumnName
    return @"
IF NOT EXISTS (
    SELECT 1
    FROM sys.default_constraints dc
    JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
    WHERE dc.parent_object_id = OBJECT_ID($objectLiteral, N'U')
      AND c.name = $columnLiteral
)
BEGIN
$(Indent-Sql $Sql)
END
"@.Trim()
}

function New-IfIndexMissingSql {
    param(
        [Parameter(Mandatory)]$Index,
        [Parameter(Mandatory)][string]$Sql
    )

    $objectLiteral = Quote-SqlLiteral (Get-UnquotedQualifiedName $Index.Parent.Schema $Index.Parent.Name)
    $indexLiteral = Quote-SqlLiteral $Index.Name
    return "IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID($objectLiteral, N'U') AND name = $indexLiteral)`r`nBEGIN`r`n$(Indent-Sql $Sql)`r`nEND"
}

function New-IfKeyConstraintMissingSql {
    param(
        [Parameter(Mandatory)][string]$SchemaName,
        [Parameter(Mandatory)][string]$TableName,
        [Parameter(Mandatory)][string]$ConstraintName,
        [Parameter(Mandatory)][string]$Sql
    )

    $objectLiteral = Quote-SqlLiteral (Get-UnquotedQualifiedName $SchemaName $TableName)
    $nameLiteral   = Quote-SqlLiteral $ConstraintName
    # Guard against re-adding a PRIMARY KEY / UNIQUE constraint that already exists.
    # sys.key_constraints covers both PK and UQ; sys.indexes alone is not enough
    # because SMO can emit ALTER TABLE ADD CONSTRAINT separately from CREATE INDEX.
    return "IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE parent_object_id = OBJECT_ID($objectLiteral, N'U') AND name = $nameLiteral)`r`nBEGIN`r`n$(Indent-Sql $Sql)`r`nEND"
}

function New-IfCheckMissingSql {
    param(
        [Parameter(Mandatory)]$Check,
        [Parameter(Mandatory)][string]$Sql
    )

    $objectLiteral = Quote-SqlLiteral (Get-UnquotedQualifiedName $Check.Parent.Schema $Check.Parent.Name)
    $nameLiteral = Quote-SqlLiteral $Check.Name
    return "IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE parent_object_id = OBJECT_ID($objectLiteral, N'U') AND name = $nameLiteral)`r`nBEGIN`r`n$(Indent-Sql $Sql)`r`nEND"
}

function New-IfForeignKeyMissingSql {
    param(
        [Parameter(Mandatory)]$ForeignKey,
        [Parameter(Mandatory)][string]$Sql
    )

    $objectLiteral = Quote-SqlLiteral (Get-UnquotedQualifiedName $ForeignKey.Parent.Schema $ForeignKey.Parent.Name)
    $nameLiteral = Quote-SqlLiteral $ForeignKey.Name
    return "IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE parent_object_id = OBJECT_ID($objectLiteral, N'U') AND name = $nameLiteral)`r`nBEGIN`r`n$(Indent-Sql $Sql)`r`nEND"
}

function New-IfTriggerMissingSql {
    param(
        [Parameter(Mandatory)]$Trigger,
        [Parameter(Mandatory)][string]$Sql
    )

    $parent = $Trigger.Parent
    $triggerLiteral = Quote-SqlLiteral (Get-UnquotedQualifiedName $parent.Schema $Trigger.Name)
    return "IF OBJECT_ID($triggerLiteral, N'TR') IS NULL`r`nBEGIN`r`n    EXEC(N'$(Escape-DynamicSql $Sql)')`r`nEND"
}

function Join-Batches {
    param([System.Collections.Generic.List[string]]$Batches)

    if ($Batches.Count -eq 0) {
        return "-- No table differences found.`r`n"
    }

    $body = ($Batches | ForEach-Object { $_.TrimEnd() }) -join "`r`nGO`r`n`r`n"
    return $body + "`r`nGO`r`n"
}

function New-SmoServer {
    param(
        [Parameter(Mandatory)][string]$ServerName,
        [Parameter(Mandatory)][string]$AuthType,
        [string]$SqlUsername,
        [string]$SqlPassword
    )

    $conn = [Microsoft.SqlServer.Management.Common.ServerConnection]::new($ServerName)
    $conn.TrustServerCertificate = $true
    $conn.EncryptConnection = $false
    $conn.NetworkProtocol = [Microsoft.SqlServer.Management.Common.NetworkProtocol]::NotSpecified

    if ($AuthType -eq "Windows") {
        $conn.LoginSecure = $true
    } else {
        $conn.LoginSecure = $false
        $conn.set_Login($SqlUsername)
        $conn.set_Password($SqlPassword)
    }

    return [Microsoft.SqlServer.Management.Smo.Server]::new($conn)
}

function New-TableScripter {
    param(
        [Parameter(Mandatory)]$SqlServer,
        [bool]$IncludeForeignKeysInTableScript = $true,
        [bool]$IncludeTriggersInTableScript = $true
    )

    $scripter = [Microsoft.SqlServer.Management.Smo.Scripter]::new($SqlServer)
    $scripter.Options.ScriptSchema = $true
    $scripter.Options.SchemaQualify = $true
    $scripter.Options.IncludeHeaders = $false
    $scripter.Options.ScriptBatchTerminator = $false
    $scripter.Options.NoCommandTerminator = $true
    $scripter.Options.ScriptData = $false
    $scripter.Options.Indexes = $true
    $scripter.Options.ClusteredIndexes = $true
    $scripter.Options.NonClusteredIndexes = $true
    $scripter.Options.Triggers = $IncludeTriggersInTableScript
    $scripter.Options.DriAll = $true
    $scripter.Options.DriForeignKeys = $IncludeForeignKeysInTableScript
    $scripter.Options.Permissions = $false
    $scripter.Options.ExtendedProperties = $false

    return $scripter
}

function Remove-NoiseFromScript {
    param([Parameter(Mandatory)][string]$Sql)

    $lines = $Sql -split "`r?`n"
    $out = @()

    foreach ($line in $lines) {
        $trim = $line.Trim()
        $upper = $trim.ToUpperInvariant()
        if ($upper -eq "GO") { continue }
        if ($upper -eq "SET ANSI_NULLS ON") { continue }
        if ($upper -eq "SET QUOTED_IDENTIFIER ON") { continue }
        if ($upper -eq "SET ANSI_PADDING ON") { continue }
        if ($upper -eq "SET ANSI_PADDING OFF") { continue }
        if ($upper.StartsWith("USE ")) { continue }

        $out += $line.TrimEnd()
    }

    return ($out -join "`r`n").Trim()
}

function Get-SqlTypeDefinition {
    param([Parameter(Mandatory)]$Column)

    if ($Column.IsComputed) {
        return $null
    }

    if ($Column.IsUserDefined) {
        return Get-QualifiedName $Column.DataTypeSchema $Column.DataType
    }

    $typeName = $Column.DataType.ToUpperInvariant()
    $maxLength = $Column.max_length
    $precision = $Column.precision
    $scale = $Column.scale

    switch ($typeName) {
        { $_ -in @("VARCHAR", "CHAR", "VARBINARY", "BINARY") } {
            $length = if ($maxLength -eq -1) { "MAX" } else { [string]$maxLength }
            return "$typeName($length)"
        }
        { $_ -in @("NVARCHAR", "NCHAR") } {
            $length = if ($maxLength -eq -1) { "MAX" } else { [string]($maxLength / 2) }
            return "$typeName($length)"
        }
        { $_ -in @("DECIMAL", "NUMERIC") } {
            return "$typeName($precision,$scale)"
        }
        { $_ -in @("DATETIME2", "DATETIMEOFFSET", "TIME") } {
            return "$typeName($scale)"
        }
        default {
            return $typeName
        }
    }
}

function Get-ColumnDefinition {
    param([Parameter(Mandatory)]$Column)

    $columnName = Quote-SqlName $Column.ColumnName

    if ($Column.IsComputed) {
        $persisted = if ($Column.IsPersisted) { " PERSISTED" } else { "" }
        return "$columnName AS $($Column.ComputedDefinition)$persisted"
    }

    $typeDefinition = Get-SqlTypeDefinition $Column
    if ($Column.CollationName -and $Column.DataType -match "char|text") {
        $typeDefinition += " COLLATE $($Column.CollationName)"
    }

    $identity = ""
    if ($Column.IsIdentity) {
        $identity = " IDENTITY($($Column.SeedValue),$($Column.IncrementValue))"
    }

    $nullability = if ($Column.IsNullable) { "NULL" } else { "NOT NULL" }
    $default = if (![string]::IsNullOrWhiteSpace($Column.DefaultDefinition)) {
        " CONSTRAINT $(Quote-SqlName $Column.DefaultConstraintName) DEFAULT $($Column.DefaultDefinition)"
    }
    else {
        ""
    }

    return "$columnName $typeDefinition$identity $nullability$default"
}

function Get-ColumnSignature {
    param([Parameter(Mandatory)]$Column)

    if ($Column.IsComputed) {
        return "COMPUTED|$($Column.ComputedDefinition)|$($Column.IsPersisted)"
    }

    return @(
        $Column.DataType
        $Column.DataTypeSchema
        $Column.IsUserDefined
        $Column.max_length
        $Column.precision
        $Column.scale
        $Column.IsNullable
        $Column.CollationName
        $Column.IsIdentity
    ) -join "|"
}

function Get-TableColumns {
    param(
        [Parameter(Mandatory)]$SmoDatabase,
        [Parameter(Mandatory)]$SelectedTableKeys
    )

    $tableFilterSql = Get-TableFilterSql -SelectedTableKeys $SelectedTableKeys

    $query = @"
SELECT
    s.name AS SchemaName,
    t.name AS TableName,
    c.name AS ColumnName,
    c.column_id AS ColumnId,
    ty.name AS DataType,
    SCHEMA_NAME(ty.schema_id) AS DataTypeSchema,
    ty.is_user_defined AS IsUserDefined,
    c.max_length,
    c.precision,
    c.scale,
    c.is_nullable AS IsNullable,
    c.is_identity AS IsIdentity,
    IDENT_SEED(QUOTENAME(s.name) + '.' + QUOTENAME(t.name)) AS SeedValue,
    IDENT_INCR(QUOTENAME(s.name) + '.' + QUOTENAME(t.name)) AS IncrementValue,
    c.collation_name AS CollationName,
    c.is_computed AS IsComputed,
    cc.definition AS ComputedDefinition,
    cc.is_persisted AS IsPersisted,
    dc.name AS DefaultConstraintName,
    dc.definition AS DefaultDefinition
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.columns c ON c.object_id = t.object_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
WHERE t.is_ms_shipped = 0
AND (
        $tableFilterSql
    )
ORDER BY s.name, t.name, c.column_id;
"@

    $SmoDatabase.ExecuteWithResults($query).Tables[0].Rows
}

function Get-ObjectKey {
    param(
        [Parameter(Mandatory)][string]$SchemaName,
        [Parameter(Mandatory)][string]$ObjectName
    )

    return "$SchemaName.$ObjectName"
}

function Get-IdentifierComparer {
    param([Parameter(Mandatory)]$Database)

    $query = @"
SELECT CONVERT(int, COLLATIONPROPERTY(
    CONVERT(sysname, SQL_VARIANT_PROPERTY(name, 'Collation')), 'ComparisonStyle')) AS ComparisonStyle
FROM sys.schemas WHERE schema_id = 1;
"@
    $rows = $Database.ExecuteWithResults($query).Tables[0].Rows
    if ($rows.Count -ne 1 -or $rows[0].ComparisonStyle -is [DBNull]) {
        throw "Cannot determine identifier case sensitivity for database $($Database.Name)."
    }
    if (([int]$rows[0].ComparisonStyle -band 1) -eq 1) {
        return [System.StringComparer]::OrdinalIgnoreCase
    }
    return [System.StringComparer]::Ordinal
}

function Read-ObjectList {
    param([Parameter(Mandatory)][string]$Path)

    if (!(Test-Path -LiteralPath $Path)) {
        throw "Object list file not found: $Path"
    }

    $selected = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)

    foreach ($line in Get-Content -LiteralPath $Path) {
        $clean = ($line -replace "\[|\]", "").Trim()
        $clean = ($clean -replace "\s*\.\s*", ".")

        if ([string]::IsNullOrWhiteSpace($clean)) { continue }
        if ($clean.StartsWith("--")) { continue }

        $parts = $clean.Split(".", 2)
        if ($parts.Count -ne 2 -or [string]::IsNullOrWhiteSpace($parts[0]) -or [string]::IsNullOrWhiteSpace($parts[1])) {
            Write-Warning "Skipping invalid object list entry: $line"
            continue
        }

        $null = $selected.Add((Get-ObjectKey $parts[0].Trim() $parts[1].Trim()))
    }

    return $selected
}

function ConvertTo-SqlStringLiteral {
    param([Parameter(Mandatory)][string]$Value)

    return "N'" + $Value.Replace("'", "''") + "'"
}

function Get-TableFilterSql {
    param([Parameter(Mandatory)]$SelectedTableKeys)

    $conditions = @()
    foreach ($tableKey in $SelectedTableKeys) {
        $parts = ([string]$tableKey).Split(".", 2)
        if ($parts.Count -ne 2) { continue }

        $schemaLiteral = ConvertTo-SqlStringLiteral $parts[0]
        $tableLiteral = ConvertTo-SqlStringLiteral $parts[1]
        $conditions += "(s.name = $schemaLiteral AND t.name = $tableLiteral)"
    }

    if ($conditions.Count -eq 0) {
        return "1 = 0"
    }

    return $conditions -join "`r`n        OR "
}

function Resolve-SelectedTableKeysFromDatabase {
    param(
        [Parameter(Mandatory)]$Database,
        [Parameter(Mandatory)]$SelectedTableKeys,
        [System.StringComparer]$NameComparer = [System.StringComparer]::OrdinalIgnoreCase
    )

    $tableFilterSql = Get-TableFilterSql -SelectedTableKeys $SelectedTableKeys
    $query = @"
SELECT
    s.name AS SchemaName,
    t.name AS TableName
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
WHERE t.is_ms_shipped = 0
AND (
        $tableFilterSql
    )
ORDER BY s.name, t.name;
"@

    $resolved = [System.Collections.Generic.HashSet[string]]::new($NameComparer)
    $rows = $Database.ExecuteWithResults($query).Tables[0].Rows
    foreach ($row in $rows) {
        $null = $resolved.Add((Get-ObjectKey ([string]$row.SchemaName) ([string]$row.TableName)))
    }

    foreach ($tableKey in $SelectedTableKeys) {
        if (-not $resolved.Contains([string]$tableKey)) {
            Write-Warning "Table not found in source database: $tableKey"
        }
    }

    return $resolved
}

function Find-DatabaseTable {
    param(
        [Parameter(Mandatory)]$Database,
        [Parameter(Mandatory)][string]$SchemaName,
        [Parameter(Mandatory)][string]$TableName,
        [System.StringComparer]$NameComparer = [System.StringComparer]::OrdinalIgnoreCase
    )

    $table = $Database.Tables[$TableName, $SchemaName]
    if ($null -ne $table -and !$table.IsSystemObject -and
        $NameComparer.Equals([string]$table.Schema, $SchemaName) -and $NameComparer.Equals([string]$table.Name, $TableName)) {
        return $table
    }

    foreach ($candidate in $Database.Tables) {
        if ($candidate.IsSystemObject) { continue }
        if ($NameComparer.Equals([string]$candidate.Schema, $SchemaName) -and $NameComparer.Equals([string]$candidate.Name, $TableName)) {
            return $candidate
        }
    }

    return $null
}

function Get-SelectedSmoTables {
    param(
        [Parameter(Mandatory)]$Database,
        [Parameter(Mandatory)]$SelectedTableKeys,
        [System.StringComparer]$NameComparer = [System.StringComparer]::OrdinalIgnoreCase
    )

    $tables = [System.Collections.Generic.Dictionary[string, object]]::new($NameComparer)

    foreach ($tableKey in $SelectedTableKeys) {
        $parts = ([string]$tableKey).Split(".", 2)
        if ($parts.Count -ne 2) { continue }

        $schemaName = $parts[0]
        $tableName = $parts[1]
        $table = Find-DatabaseTable -Database $Database -SchemaName $schemaName -TableName $tableName -NameComparer $NameComparer

        if ($null -ne $table -and !$table.IsSystemObject) {
            $tables[(Get-ObjectKey $table.Schema $table.Name)] = $table
        }
    }

    return $tables
}

function Get-IndexKey {
    param($Index)

    return "$($Index.Parent.Schema).$($Index.Parent.Name).$($Index.Name)"
}

function Get-IndexSignature {
    param(
        $Index,
        [System.StringComparer]$NameComparer = [System.StringComparer]::Ordinal
    )

    $indexedColumns = @()
    foreach ($column in $Index.IndexedColumns) {
        $sortOrder = if ($column.Descending) { "DESC" } else { "ASC" }
        $include = if ($column.IsIncluded) { "INCLUDE" } else { "KEY" }
        $columnKey = [string]$column.Name
        if ($NameComparer.Equals('A', 'a')) { $columnKey = $columnKey.ToUpperInvariant() }
        $indexedColumns += "${columnKey}:${include}:$sortOrder"
    }

    return @(
        $Index.IndexKeyType
        $Index.IndexType
        $Index.IsUnique
        $Index.IsClustered
        $Index.HasFilter
        $Index.FilterDefinition
        ($indexedColumns -join ",")
    ) -join "|"
}

function Get-IndexSignatureKey {
    param(
        $Index,
        [System.StringComparer]$NameComparer = [System.StringComparer]::Ordinal
    )

    $tableKey = Get-ObjectKey $Index.Parent.Schema $Index.Parent.Name
    if ($NameComparer.Equals('A', 'a')) { $tableKey = $tableKey.ToUpperInvariant() }
    return "$tableKey|$(Get-IndexSignature -Index $Index -NameComparer $NameComparer)"
}

function Get-ConstraintKey {
    param($Constraint)

    return "$($Constraint.Parent.Schema).$($Constraint.Parent.Name).$($Constraint.Name)"
}

trap {
    Write-Error "Table compare failed. $($_.Exception.Message)"
    exit 1
}

Import-Module SqlServer -ErrorAction Stop
Add-Type -AssemblyName "Microsoft.SqlServer.Smo"

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $desktop = [Environment]::GetFolderPath("Desktop")
    $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $OutputPath = Join-Path $desktop "TableDelta_${SourceDatabase}_to_${TargetDatabase}_$timestamp.sql"
}

Ensure-Directory (Split-Path $OutputPath -Parent)

$sourceServerObj = New-SmoServer -ServerName $SourceServer -AuthType $SourceAuthenticationType -SqlUsername $SourceUsername -SqlPassword $SourcePassword
$targetServerObj = New-SmoServer -ServerName $TargetServer -AuthType $TargetAuthenticationType -SqlUsername $TargetUsername -SqlPassword $TargetPassword

$sourceDb = $sourceServerObj.Databases[$SourceDatabase]
$targetDb = $targetServerObj.Databases[$TargetDatabase]

if ($null -eq $sourceDb) { throw "Source database not found: $SourceDatabase" }
if ($null -eq $targetDb) { throw "Target database not found: $TargetDatabase" }

$sourceNameComparer = Get-IdentifierComparer -Database $sourceDb
$targetNameComparer = Get-IdentifierComparer -Database $targetDb
$scripter = New-TableScripter -SqlServer $sourceServerObj
$createTableScripter = New-TableScripter -SqlServer $sourceServerObj -IncludeForeignKeysInTableScript $false -IncludeTriggersInTableScript $false
$batches = [System.Collections.Generic.List[string]]::new()

Add-Batch $batches "-- Generated from $SourceServer.$($sourceDb.Name) to $TargetServer.$($targetDb.Name) on $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Add-Batch $batches "USE $(Quote-SqlName $targetDb.Name);"

$selectedTableKeys = Read-ObjectList -Path $ObjectListPath
if ($selectedTableKeys.Count -eq 0) {
    throw "No valid schema.table entries found in object list file: $ObjectListPath"
}

$selectedTableKeys = Resolve-SelectedTableKeysFromDatabase -Database $sourceDb -SelectedTableKeys $selectedTableKeys -NameComparer $sourceNameComparer
if ($selectedTableKeys.Count -eq 0) {
    throw "No selected tables were resolved from source database metadata: $ObjectListPath"
}

$targetSelectionKeys = [System.Collections.Generic.HashSet[string]]::new($targetNameComparer)
foreach ($tableKey in $selectedTableKeys) {
    if (!$targetSelectionKeys.Add($tableKey)) {
        throw "Selected source table names collide under target identifier case sensitivity: $tableKey. Review the selection before generating a delta."
    }
}

Add-Batch $batches "-- Tables selected from $ObjectListPath : $($selectedTableKeys.Count)"

$sourceColumns = @(Get-TableColumns -SmoDatabase $sourceDb -SelectedTableKeys $selectedTableKeys)
$targetColumns = @(Get-TableColumns -SmoDatabase $targetDb -SelectedTableKeys $selectedTableKeys)

$sourceTables = Get-SelectedSmoTables -Database $sourceDb -SelectedTableKeys $selectedTableKeys -NameComparer $sourceNameComparer
$targetTables = Get-SelectedSmoTables -Database $targetDb -SelectedTableKeys $selectedTableKeys -NameComparer $targetNameComparer
$missingTableKeys = [System.Collections.Generic.HashSet[string]]::new($sourceNameComparer)

foreach ($selectedKey in ($selectedTableKeys | Sort-Object)) {
    if (!$sourceTables.ContainsKey($selectedKey)) {
        Add-Batch $batches "-- Source table listed but not found: $selectedKey"
    }
}

$targetColumnMap = [System.Collections.Generic.Dictionary[string, object]]::new($targetNameComparer)
foreach ($column in $targetColumns) {
    $key = "$(Get-ObjectKey $column.SchemaName $column.TableName)|$($column.ColumnName)"
    $targetColumnMap[$key] = $column
}

$sourceColumnMap = [System.Collections.Generic.Dictionary[string, object]]::new($sourceNameComparer)
foreach ($column in $sourceColumns) {
    $tableKey = Get-ObjectKey $column.SchemaName $column.TableName
    if (!$sourceColumnMap.ContainsKey($tableKey)) {
        $sourceColumnMap[$tableKey] = [System.Collections.Generic.List[object]]::new()
    }

    $sourceColumnMap[$tableKey].Add($column)
}

foreach ($sourceTableKey in ($sourceTables.Keys | Sort-Object)) {
    $sourceTable = $sourceTables[$sourceTableKey]
    $qualifiedTable = Get-QualifiedName $sourceTable.Schema $sourceTable.Name

    if (!$targetTables.ContainsKey($sourceTableKey)) {
        $null = $missingTableKeys.Add($sourceTableKey)
        $createTableSql = Remove-NoiseFromScript (Convert-Script ($createTableScripter.Script($sourceTable)))
        Add-Batch $batches "-- Create missing table $qualifiedTable`r`n$(New-IfTableMissingSql -SchemaName $sourceTable.Schema -TableName $sourceTable.Name -Sql $createTableSql)"
        continue
    }

    $sourceTableColumns = @()
    if ($sourceColumnMap.ContainsKey($sourceTableKey)) {
        $sourceTableColumns = @($sourceColumnMap[$sourceTableKey] | Sort-Object ColumnId)
    }

    foreach ($sourceColumn in $sourceTableColumns) {
        $columnKey = "$sourceTableKey|$($sourceColumn.ColumnName)"
        $targetColumn = $targetColumnMap[$columnKey]

        if ($null -eq $targetColumn) {
            if ($sourceColumn.IsIdentity) {
                Add-Batch $batches "-- Manual review required: cannot add identity column $(Quote-SqlName $sourceColumn.ColumnName) to existing table $qualifiedTable with ALTER TABLE."
                continue
            }

            $addColumnSql = "ALTER TABLE $qualifiedTable ADD $(Get-ColumnDefinition $sourceColumn);"
            Add-Batch $batches (New-IfColumnMissingSql -SchemaName $sourceColumn.SchemaName -TableName $sourceColumn.TableName -ColumnName $sourceColumn.ColumnName -Sql $addColumnSql)
            continue
        }

        if ((Get-ColumnSignature $sourceColumn) -cne (Get-ColumnSignature $targetColumn)) {
            if ($sourceColumn.IsComputed -or $targetColumn.IsComputed -or $sourceColumn.IsIdentity -or $targetColumn.IsIdentity) {
                Add-Batch $batches "-- Manual review required: computed/identity column differs on $qualifiedTable.$(Quote-SqlName $sourceColumn.ColumnName)."
                continue
            }

            $typeDefinition = Get-SqlTypeDefinition $sourceColumn
            if ($sourceColumn.CollationName -and $sourceColumn.DataType -match "char|text") {
                $typeDefinition += " COLLATE $($sourceColumn.CollationName)"
            }
            $nullability = if ($sourceColumn.IsNullable) { "NULL" } else { "NOT NULL" }

            $alterColumnSql = "ALTER TABLE $qualifiedTable ALTER COLUMN $(Quote-SqlName $sourceColumn.ColumnName) $typeDefinition $nullability;"
            Add-Batch $batches (New-IfColumnDifferentSql -Column $sourceColumn -Sql $alterColumnSql)
        }

        if (![string]::IsNullOrWhiteSpace($sourceColumn.DefaultDefinition)) {
            if ([string]::IsNullOrWhiteSpace($targetColumn.DefaultDefinition)) {
                $defaultSql = "ALTER TABLE $qualifiedTable ADD CONSTRAINT $(Quote-SqlName $sourceColumn.DefaultConstraintName) DEFAULT $($sourceColumn.DefaultDefinition) FOR $(Quote-SqlName $sourceColumn.ColumnName);"
                Add-Batch $batches (New-IfDefaultMissingSql -Column $sourceColumn -Sql $defaultSql)
            }
            elseif ($sourceColumn.DefaultDefinition -cne $targetColumn.DefaultDefinition) {
                Add-Batch $batches "-- Manual review required: default constraint differs on $qualifiedTable.$(Quote-SqlName $sourceColumn.ColumnName). Source: $($sourceColumn.DefaultDefinition) Target: $($targetColumn.DefaultDefinition)"
            }
        }
    }
}

$targetIndexMap = [System.Collections.Generic.Dictionary[string, object]]::new($targetNameComparer)
$targetIndexSignatureKeys = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
foreach ($table in $targetTables.Values) {
    foreach ($index in $table.Indexes) {
        $targetIndexMap[(Get-IndexKey $index)] = $index
        $null = $targetIndexSignatureKeys.Add((Get-IndexSignatureKey -Index $index -NameComparer $targetNameComparer))
    }
}

foreach ($table in $sourceTables.Values) {
    if (!$targetTables.ContainsKey((Get-ObjectKey $table.Schema $table.Name))) { continue }

    foreach ($index in $table.Indexes) {
        if ($index.IsHypothetical) { continue }
        $indexKey = Get-IndexKey $index
        $indexSignatureKey = Get-IndexSignatureKey -Index $index -NameComparer $targetNameComparer
        if ($targetIndexMap.ContainsKey($indexKey)) {
            if ((Get-IndexSignature -Index $index -NameComparer $targetNameComparer) -cne (Get-IndexSignature -Index $targetIndexMap[$indexKey] -NameComparer $targetNameComparer)) {
                Add-Batch $batches "-- Manual review required: index/key differs and may need DROP/CREATE: $(Quote-SqlName $index.Name) on $(Get-QualifiedName $table.Schema $table.Name)."
            }
            continue
        }

        if ($targetIndexSignatureKeys.Contains($indexSignatureKey)) {
            continue
        }

        $indexSql = Remove-NoiseFromScript (Convert-Script ($index.Script()))
        if ($index.IndexKeyType -in 'DriPrimaryKey','DriUniqueKey') {
            $wrapped = New-IfKeyConstraintMissingSql -SchemaName $index.Parent.Schema -TableName $index.Parent.Name -ConstraintName $index.Name -Sql $indexSql
        } else {
            $wrapped = New-IfIndexMissingSql -Index $index -Sql $indexSql
        }
        Add-Batch $batches "-- Create missing index/key $(Quote-SqlName $index.Name) on $(Get-QualifiedName $table.Schema $table.Name)`r`n$wrapped"
    }
}

$targetConstraintKeys = [System.Collections.Generic.HashSet[string]]::new($targetNameComparer)
foreach ($table in $targetTables.Values) {
    foreach ($check in $table.Checks) { $null = $targetConstraintKeys.Add((Get-ConstraintKey $check)) }
    foreach ($fk in $table.ForeignKeys) { $null = $targetConstraintKeys.Add((Get-ConstraintKey $fk)) }
}

foreach ($table in $sourceTables.Values) {
    if (!$targetTables.ContainsKey((Get-ObjectKey $table.Schema $table.Name))) { continue }

    foreach ($check in $table.Checks) {
        if ($targetConstraintKeys.Contains((Get-ConstraintKey $check))) { continue }
        $checkSql = Remove-NoiseFromScript (Convert-Script ($check.Script()))
        Add-Batch $batches "-- Create missing check constraint $(Quote-SqlName $check.Name) on $(Get-QualifiedName $table.Schema $table.Name)`r`n$(New-IfCheckMissingSql -Check $check -Sql $checkSql)"
    }

    if ($IncludeForeignKeys) {
        foreach ($fk in $table.ForeignKeys) {
            if ($targetConstraintKeys.Contains((Get-ConstraintKey $fk))) { continue }
            $foreignKeySql = Remove-NoiseFromScript (Convert-Script ($fk.Script()))
            Add-Batch $batches "-- Create missing foreign key $(Quote-SqlName $fk.Name) on $(Get-QualifiedName $table.Schema $table.Name)`r`n$(New-IfForeignKeyMissingSql -ForeignKey $fk -Sql $foreignKeySql)"
        }
    }
}

if ($IncludeForeignKeys -and $missingTableKeys.Count -gt 0) {
    foreach ($table in $sourceTables.Values) {
        if (!$missingTableKeys.Contains((Get-ObjectKey $table.Schema $table.Name))) { continue }

        foreach ($fk in $table.ForeignKeys) {
            $foreignKeySql = Remove-NoiseFromScript (Convert-Script ($fk.Script()))
            Add-Batch $batches "-- Create foreign key after table creation $(Quote-SqlName $fk.Name) on $(Get-QualifiedName $table.Schema $table.Name)`r`n$(New-IfForeignKeyMissingSql -ForeignKey $fk -Sql $foreignKeySql)"
        }
    }
}

if ($IncludeTriggers) {
    $targetTriggerKeys = [System.Collections.Generic.HashSet[string]]::new($targetNameComparer)
    foreach ($table in $targetTables.Values) {
        foreach ($trigger in $table.Triggers) {
            $null = $targetTriggerKeys.Add("$($table.Schema).$($table.Name).$($trigger.Name)")
        }
    }

    foreach ($table in $sourceTables.Values) {
        $tableKey = Get-ObjectKey $table.Schema $table.Name
        if (!$targetTables.ContainsKey($tableKey) -and !$missingTableKeys.Contains($tableKey)) { continue }

        foreach ($trigger in $table.Triggers) {
            $triggerKey = "$($table.Schema).$($table.Name).$($trigger.Name)"
            if ($targetTriggerKeys.Contains($triggerKey)) { continue }
            $triggerSql = Remove-NoiseFromScript (Convert-Script ($trigger.Script()))
            Add-Batch $batches "-- Create missing trigger $(Quote-SqlName $trigger.Name) on $(Get-QualifiedName $table.Schema $table.Name)`r`n$(New-IfTriggerMissingSql -Trigger $trigger -Sql $triggerSql)"
        }
    }
}

$content = Join-Batches $batches
$utf8WithBom = [System.Text.UTF8Encoding]::new($true)
$contentText = [string]$content
if (!$contentText.EndsWith("`n")) { $contentText += [Environment]::NewLine }
[System.IO.File]::WriteAllText($OutputPath, $contentText, $utf8WithBom)

Write-Host "Delta script generated: $OutputPath" -ForegroundColor Green
