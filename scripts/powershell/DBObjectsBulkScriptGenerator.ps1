param(
    [string]$Server,
    [string[]]$Databases,
    [string]$ObjectListPath = "",
    [string]$OutputBasePath = "",
    [string]$BuildPathFileName = "BuildPaths.txt",

    #Authentication parameters
    [ValidateSet("Windows","Sql")]
    [string]$AuthenticationType = "Sql",

    # Only used for SQL Auth
    [string]$Username,
    [string]$Password,

    # Optional JSON object mapping TypeDesc keys to custom folder names
    # e.g. '{"USER_TABLE":"Tables","SQL_STORED_PROCEDURE":"SP"}'
    [string]$FolderNameOverrides = "",

    # Caller mode controls whether programmable objects are deploy-ready or source backups.
    [ValidateSet("backup", "deploy", "code_diff")]
    [string]$app_task_mode = "backup"
)

$ErrorActionPreference = "Stop"

# Parse folder name overrides (if provided)
$_folderOverrides = @{}
if (![string]::IsNullOrWhiteSpace($FolderNameOverrides)) {
    try {
        $parsed = $FolderNameOverrides | ConvertFrom-Json
        foreach ($prop in $parsed.PSObject.Properties) {
            $_folderOverrides[$prop.Name] = $prop.Value
        }
    } catch {
        # Ignore invalid JSON — fall back to defaults
    }
}

# ------------------ Helpers ------------------

function Write-CleanError {
    param(
        [Parameter(Mandatory)]
        [string]$Message,

        [object]$Details
    )

    [Console]::Error.WriteLine("ERROR: $Message")

    if ($null -ne $Details) {
        if ($Details -is [System.Management.Automation.ErrorRecord]) {
            $detailText = $Details.Exception.Message
        }
        elseif ($Details -is [System.Exception]) {
            $detailText = $Details.Message
        }
        else {
            $detailText = [string]$Details
        }

        if (![string]::IsNullOrWhiteSpace($detailText)) {
            [Console]::Error.WriteLine("DETAIL: $detailText")
        }
    }
}

function Exit-WithError {
    param(
        [Parameter(Mandatory)]
        [string]$Message,

        [object]$Details,

        [int]$ExitCode = 1
    )

    Write-CleanError -Message $Message -Details $Details
    exit $ExitCode
}

function Ensure-Directory($path) {
    if (!(Test-Path $path)) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
    }
}

function Get-DefaultOutputBasePath {
    $desktop = [Environment]::GetFolderPath("Desktop")
    $basePath = Join-Path $desktop "GITPUSHCOPY"
    return $basePath
    #$uatPath = Join-Path $basePath "Reports_UAT"
    #return $uatPath

}

function Sanitize($name) {
    $invalid = [System.IO.Path]::GetInvalidFileNameChars()
    foreach ($c in $invalid) { $name = $name.Replace($c, "_") }
    return $name.Trim().TrimEnd(".")
}
function Convert-Script($script) {
    $sb = [System.Text.StringBuilder]::new()
    foreach ($line in $script) { $null = $sb.AppendLine($line) }
    return $sb.ToString()
}
function Quote-SqlIdentifier {
    param([Parameter(Mandatory)][string]$Name)

    return "[" + ($Name -replace "]", "]]" ) + "]"
}

function Get-QualifiedSqlName {
    param(
        [Parameter(Mandatory)][string]$SchemaName,
        [Parameter(Mandatory)][string]$ObjectName
    )

    return "$(Quote-SqlIdentifier $SchemaName).$(Quote-SqlIdentifier $ObjectName)"
}

function Write-ContentAtomically($path, $content) {
    $dir = Split-Path $path
    Ensure-Directory $dir
    $tmp = Join-Path $dir ([System.IO.Path]::GetRandomFileName())
    Set-Content -Path $tmp -Value $content -Encoding utf8
    Move-Item -Path $tmp -Destination $path -Force
}
function Format-DdlKeywords($text) {
    # SMO sometimes splits DDL keywords across lines (e.g. CREATE\nPROCEDURE).
    # Collapse them so downstream diffs and regex substitutions work correctly.
    $text = [regex]::Replace($text, '(?im)\bCREATE\s*\r?\n\s*OR\s*\r?\n?\s*ALTER\b', 'CREATE OR ALTER')
    $text = [regex]::Replace($text, '(?im)\b(CREATE(?:\s+OR\s+ALTER)?|ALTER)\s*\r?\n\s*(PROCEDURE|PROC|VIEW|FUNCTION|TRIGGER|TABLE|INDEX)\b', '$1 $2')
    return $text
}

function Clean-SqlScript($text) {
    $text = Format-DdlKeywords $text

    $lines = $text -split "`r?`n"
    $out = @()

    foreach ($line in $lines) {
        $trim = $line.Trim().ToUpper()
        if ($trim -eq "SET ANSI_NULLS ON") { continue }
        if ($trim -eq "SET QUOTED_IDENTIFIER ON") { continue }
        if ($trim -eq "GO") { continue }
        $out += $line
    }

    return ($out -join "`r`n")
}

function Remove-LeadingModuleBatchHeaders {
    param([Parameter(Mandatory)][string]$Text)

    return ([regex]::Replace(
        $Text,
        '(?ims)^\s*SET\s+ANSI_NULLS\s+(?:ON|OFF)\s*;?\s*\r?\nGO\s*\r?\nSET\s+QUOTED_IDENTIFIER\s+(?:ON|OFF)\s*;?\s*\r?\nGO\s*\r?\n?',
        ''
    )).Trim()
}

function Format-ModuleDefinitionText {
    param(
        [Parameter(Mandatory)][string]$DefinitionText,
        $UsesAnsiNulls = $null,
        $UsesQuotedIdentifier = $null
    )

    $text = Format-DdlKeywords $DefinitionText
    $text = Remove-LeadingModuleBatchHeaders $text
    if ([string]::IsNullOrWhiteSpace($text)) {
        return ""
    }

    return $text
}

function Set-ScriptingOptionIfAvailable {
    param(
        [Parameter(Mandatory)]$Options,
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)]$Value
    )

    $property = $Options.GetType().GetProperty($Name)
    if ($null -ne $property -and $property.CanWrite) {
        $Options.$Name = $Value
    }
}

function New-BaseScripter {
    param([Parameter(Mandatory)]$SqlServer)

    $newScripter = [Microsoft.SqlServer.Management.Smo.Scripter]::new($SqlServer)
    $newScripter.Options.ScriptSchema = $true
    $newScripter.Options.SchemaQualify = $true
    $newScripter.Options.IncludeHeaders = $false
    $newScripter.Options.ScriptBatchTerminator = $false

    return $newScripter
}

function New-DacpacTableScripter {
    param([Parameter(Mandatory)]$SqlServer)

    $tableScripter = New-BaseScripter $SqlServer
    $tableScripter.Options.ScriptData = $false
    $tableScripter.Options.Indexes = $true
    $tableScripter.Options.ClusteredIndexes = $true
    $tableScripter.Options.NonClusteredIndexes = $true
    $tableScripter.Options.Triggers = $true
    $tableScripter.Options.DriAll = $true
    $tableScripter.Options.DriAllConstraints = $true
    $tableScripter.Options.DriAllKeys = $true
    $tableScripter.Options.DriDefaults = $true
    $tableScripter.Options.DriForeignKeys = $true
    $tableScripter.Options.DriPrimaryKey = $true
    $tableScripter.Options.DriUniqueKeys = $true
    $tableScripter.Options.Permissions = $false

    Set-ScriptingOptionIfAvailable -Options $tableScripter.Options -Name "DriChecks" -Value $true
    Set-ScriptingOptionIfAvailable -Options $tableScripter.Options -Name "DriClustered" -Value $true
    Set-ScriptingOptionIfAvailable -Options $tableScripter.Options -Name "DriIndexes" -Value $true
    Set-ScriptingOptionIfAvailable -Options $tableScripter.Options -Name "DriNonClustered" -Value $true
    Set-ScriptingOptionIfAvailable -Options $tableScripter.Options -Name "DriWithNoCheck" -Value $true
    Set-ScriptingOptionIfAvailable -Options $tableScripter.Options -Name "FullTextIndexes" -Value $false
    Set-ScriptingOptionIfAvailable -Options $tableScripter.Options -Name "NoCommandTerminator" -Value $true
    Set-ScriptingOptionIfAvailable -Options $tableScripter.Options -Name "NoIdentities" -Value $false
    Set-ScriptingOptionIfAvailable -Options $tableScripter.Options -Name "Statistics" -Value $false

    Set-ScriptingOptionIfAvailable -Options $tableScripter.Options -Name "NoFileGroup" -Value $true
    Set-ScriptingOptionIfAvailable -Options $tableScripter.Options -Name "NoFileStream" -Value $true
    Set-ScriptingOptionIfAvailable -Options $tableScripter.Options -Name "NoTablePartitioningSchemes" -Value $true
    Set-ScriptingOptionIfAvailable -Options $tableScripter.Options -Name "NoIndexPartitioningSchemes" -Value $true

    return $tableScripter
}

function New-SmoServer {
    param(
        [Parameter(Mandatory)][string]$ServerName,
        [Parameter(Mandatory)][string]$AuthType,
        [string]$SqlUsername,
        [string]$SqlPassword
    )

    if ($AuthType -ne "Windows" -and ($AuthType -ne "Sql" -or [string]::IsNullOrWhiteSpace($SqlUsername) -or [string]::IsNullOrWhiteSpace($SqlPassword))) {
        if ($AuthType -eq "Sql") {
            Exit-WithError "SQL Authentication selected but username/password not provided."
        }
    }

    $connection = [Microsoft.SqlServer.Management.Common.ServerConnection]::new($ServerName)
    $connection.TrustServerCertificate = $true
    $connection.EncryptConnection = $false
    $connection.NetworkProtocol = [Microsoft.SqlServer.Management.Common.NetworkProtocol]::NotSpecified

    if ($AuthType -eq "Windows") {
        $connection.LoginSecure = $true
    } else {
        $connection.LoginSecure = $false
        $connection.set_Login($SqlUsername)
        $connection.set_Password($SqlPassword)
    }

    return [Microsoft.SqlServer.Management.Smo.Server]::new($connection)
}

function Get-DatabaseFromServer {
    param(
        [Parameter(Mandatory)]$SmoServer,
        [Parameter(Mandatory)][string]$DatabaseName
    )

    $normalizedDbName = [string]$DatabaseName
    $normalizedDbName = $normalizedDbName.Trim().Trim('[', ']')
    if ([string]::IsNullOrWhiteSpace($normalizedDbName)) {
        return $null
    }

    $dbCollection = $SmoServer.Databases
    if ($null -ne $dbCollection) {
        $resolved = $dbCollection | Where-Object { $_.Name -ieq $normalizedDbName } | Select-Object -First 1
        if ($null -ne $resolved) {
            return $resolved
        }
    }

    # Some logins cannot enumerate all databases; fall back to direct binding by name.
    try {
        $directDb = [Microsoft.SqlServer.Management.Smo.Database]::new($SmoServer, $normalizedDbName)
        return $directDb
    }
    catch {
        return $null
    }
}

function Remove-DacpacUnsupportedIndexOptions {
    param([Parameter(Mandatory)][string]$Sql)

    $clean = $Sql

    if ($clean -match "(?is)^\s*CREATE\s+(?:OR\s+ALTER\s+)?TRIGGER\b" -or
        $clean -match "(?is)^\s*ALTER\s+TRIGGER\b") {
        return $clean.Trim()
    }

    if ($clean -notmatch "(?is)\b(?:CREATE|ALTER)\s+(?:UNIQUE\s+)?(?:CLUSTERED\s+|NONCLUSTERED\s+|COLUMNSTORE\s+|NONCLUSTERED\s+COLUMNSTORE\s+|XML\s+|SPATIAL\s+)?INDEX\b" -and
        $clean -notmatch "(?is)\b(?:PRIMARY\s+KEY|UNIQUE)\b" -and
        $clean -notmatch "(?is)^\s*CREATE\s+STATISTICS\b" -and
        $clean -notmatch "(?is)^\s*CREATE\s+FULLTEXT\s+INDEX\b") {
        return $clean.Trim()
    }

    # SSDT/DACPAC model validation rejects deployment-time index build options
    # such as SqlIndex.Online. Remove those while preserving the schema definition.
    $unsupportedOptions = @(
        "ONLINE\s*=\s*(?:ON|OFF)(?:\s*\(\s*WAIT_AT_LOW_PRIORITY\s*\([^)]*\)\s*\))?",
        "RESUMABLE\s*=\s*(?:ON|OFF)",
        "MAX_DURATION\s*=\s*\d+\s+MINUTES?",
        "SORT_IN_TEMPDB\s*=\s*(?:ON|OFF)",
        "DROP_EXISTING\s*=\s*(?:ON|OFF)",
        "MAXDOP\s*=\s*\d+",
        "OPTIMIZE_FOR_SEQUENTIAL_KEY\s*=\s*(?:ON|OFF)",
        "COMPRESSION_DELAY\s*=\s*\d+\s+MINUTES?",
        "XML_COMPRESSION\s*=\s*(?:ON|OFF)"
    )

    foreach ($optionPattern in $unsupportedOptions) {
        $clean = [regex]::Replace($clean, "(?is),\s*$optionPattern", "")
        $clean = [regex]::Replace($clean, "(?is)$optionPattern\s*,\s*", "")
        $clean = [regex]::Replace($clean, "(?is)$optionPattern", "")
    }

    $clean = [regex]::Replace($clean, "(?is)WITH\s*\(\s*\)", "")
    $clean = [regex]::Replace($clean, "(?is)CREATE\s+STATISTICS\b.*?(?=;?\s*$)", "")
    $clean = [regex]::Replace($clean, "(?is)CREATE\s+FULLTEXT\s+INDEX\b.*?(?=;?\s*$)", "")
    $clean = [regex]::Replace($clean, "(?m)[ \t]+$", "")

    return $clean.Trim()
}

function Assert-DacpacTableScriptIsClean {
    param(
        [Parameter(Mandatory)][string]$Sql,
        [Parameter(Mandatory)][string]$ObjectName
    )

    $blockedPatterns = @(
        "\bONLINE\s*=",
        "\bRESUMABLE\s*=",
        "\bMAX_DURATION\s*=",
        "\bSORT_IN_TEMPDB\s*=",
        "\bDROP_EXISTING\s*=",
        "\bMAXDOP\s*=",
        "\bOPTIMIZE_FOR_SEQUENTIAL_KEY\s*=",
        "\bCOMPRESSION_DELAY\s*=",
        "\bXML_COMPRESSION\s*=",
        "\bCREATE\s+STATISTICS\b",
        "\bCREATE\s+FULLTEXT\s+INDEX\b"
    )

    $sqlWithoutTriggerBodies = [regex]::Replace($Sql, "(?is)CREATE\s+(?:OR\s+ALTER\s+)?TRIGGER\b.*?(?=\r?\nGO\r?\n|$)", "")

    foreach ($pattern in $blockedPatterns) {
        if ($sqlWithoutTriggerBodies -match $pattern) {
            throw "DACPAC-incompatible table script generated for $ObjectName. Remaining unsupported token matched pattern: $pattern"
        }
    }
}

function Format-DacpacTableScript {
    param(
        [Parameter(Mandatory)]$ScriptLines,
        [string]$ObjectName = "table"
    )

    $statements = @()

    foreach ($scriptLine in $ScriptLines) {
        $statementLines = @()

        foreach ($line in ([string]$scriptLine -split "`r?`n")) {
            $trim = $line.Trim()
            $upper = $trim.ToUpperInvariant()

            if ([string]::IsNullOrWhiteSpace($trim) -and $statementLines.Count -eq 0) { continue }
            if ($upper -eq "GO") { continue }
            if ($upper -eq "SET ANSI_NULLS ON") { continue }
            if ($upper -eq "SET QUOTED_IDENTIFIER ON") { continue }
            if ($upper -eq "SET ANSI_PADDING ON") { continue }
            if ($upper -eq "SET ANSI_PADDING OFF") { continue }
            if ($upper.StartsWith("USE ")) { continue }

            $statementLines += $line.TrimEnd()
        }

        $rawStatement = ($statementLines -join "`r`n").Trim()
        if ([string]::IsNullOrWhiteSpace($rawStatement)) {
            continue
        }

        $statement = Remove-DacpacUnsupportedIndexOptions $rawStatement
        if (![string]::IsNullOrWhiteSpace($statement)) {
            $statements += $statement
        }
    }

    if ($statements.Count -eq 0) {
        return ""
    }

    $formatted = (($statements | ForEach-Object { $_.TrimEnd() }) -join "`r`nGO`r`n`r`n") + "`r`nGO`r`n"
    Assert-DacpacTableScriptIsClean -Sql $formatted -ObjectName $ObjectName

    return $formatted
}

trap {
    Exit-WithError "Script failed." $_
}

Import-Module SqlServer -ErrorAction Stop
Add-Type -AssemblyName "Microsoft.SqlServer.Smo"
Add-Type -AssemblyName "Microsoft.SqlServer.ConnectionInfo"

# ------------------ Setup ------------------

if ([string]::IsNullOrWhiteSpace($OutputBasePath)) {
    $OutputBasePath = Get-DefaultOutputBasePath
}

Ensure-Directory $OutputBasePath

$today = (Get-Date).ToString("dd-MM-yyyy")
$RunRoot = Join-Path $OutputBasePath $today
Ensure-Directory $RunRoot

# SMO connection (safe)

$smoServer = New-SmoServer -ServerName $Server -AuthType $AuthenticationType -SqlUsername $Username -SqlPassword $Password

# ------------------ Connection Test ------------------

try {
    # Test server connectivity
    $null = $smoServer.Information.Version
}
catch {
    Exit-WithError "Failed to connect to SQL Server: $Server" $_
}

# Normalize database input list once and continue with scripting flow.
$Databases = @($Databases | ForEach-Object {
    [string]$_
} | ForEach-Object {
    $_.Trim().Trim('[', ']')
} | Where-Object {
    -not [string]::IsNullOrWhiteSpace($_)
})

if ($Databases.Count -eq 0) {
    Exit-WithError "No valid database names supplied."
}

Write-Host "Connection successful to server $Server and DB ($($Databases -join ', '))" -ForegroundColor Green
# ------------------ Read + Deduplicate ------------------

$objects = @()
$seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

foreach ($line in Get-Content $ObjectListPath) {


    $clean = ($line -replace "\[|\]", "").Trim()
    $clean = ($clean -replace "\s*\.\s*", ".")

    if ([string]::IsNullOrWhiteSpace($clean)) { continue }

    if ($seen.Add($clean)) {
        $objects += $clean
    }


}

$total = [Math]::Max(1, $objects.Count * $Databases.Count)
$count = 0

$summary = @{}

# ------------------ Main Loop ------------------

foreach ($dbName in $Databases) {

    $allSPContent = @()
    $allTableContent = @()
    $tableDropStatements = @()
    $buildEntries = @()
    $shouldWriteCombinedArtifacts = $app_task_mode -eq "backup"
    $shouldWriteCombinedTableScript = $shouldWriteCombinedArtifacts
    $allTableUpdateTemplates = @()

    $db = Get-DatabaseFromServer -SmoServer $smoServer -DatabaseName $dbName

    if (!$db) {
        Write-Warning "SMO database binding unavailable for: $dbName. Continuing with SQL fallback where possible."
    }

    $dbFolder = Join-Path $RunRoot $dbName
    Ensure-Directory $dbFolder

    # Prepare SQL lookup list
    $nameArray = @()
    foreach ($o in $objects) {
        $schema, $name = $o.Split(".", 2)
        if ($name) { $nameArray += "'$name'" }
    }
    $nameList = $nameArray -join ","


    $query = @"
SELECT
SCHEMA_NAME(o.schema_id) AS SchemaName,
o.name AS ObjectName,
o.type_desc AS TypeDesc,
o.create_date AS CreateDate
FROM sys.objects o WITH (NOLOCK)
WHERE o.type IN ('U','FN','IF','TF','V','SN','SO','P')
AND o.name IN ($nameList)

UNION ALL

SELECT
s.name AS SchemaName,
tt.name AS ObjectName,
'USER_TABLE_TYPE' AS TypeDesc,
o.create_date AS CreateDate
FROM sys.table_types tt WITH (NOLOCK)
JOIN sys.schemas s ON tt.schema_id = s.schema_id
JOIN sys.objects o ON tt.type_table_object_id = o.object_id
WHERE tt.name IN ($nameList)
"@


    if (!$db) {
        Exit-WithError "Script failed." "Cannot connect to database: $dbName"
    }

    # Performance: if the JS layer wrote a sidecar JSON with pre-resolved object
    # types (because resolveObjectTypes already queried them), use it and skip
    # the per-database discovery query above.
    $sidecarPath = $ObjectListPath -replace '\.txt$', '.json'
    $preTyped = $null
    if (Test-Path $sidecarPath) {
        try {
            $preTyped = Get-Content $sidecarPath -Raw | ConvertFrom-Json
            Write-Host "Using pre-typed object list ($sidecarPath); skipping discovery query." -ForegroundColor DarkGray
        } catch {
            $preTyped = $null
        }
    }

    $resolvedDbObjects = $db.ExecuteWithResults($query).Tables[0].Rows
    if ($resolvedDbObjects -and $resolvedDbObjects.Count -gt 0) {
        $dbObjects = $resolvedDbObjects
    }
    elseif ($preTyped) {
        $typeMap = @{
            'TABLE'             = 'USER_TABLE'
            'VIEW'              = 'VIEW'
            'PROCEDURE'         = 'SQL_STORED_PROCEDURE'
            'FUNCTION'          = 'SQL_INLINE_TABLE_VALUED_FUNCTION'
            'SYNONYM'           = 'SYNONYM'
            'SEQUENCE'          = 'SEQUENCE_OBJECT'
            'USER_DEFINED_TYPE' = 'USER_TABLE_TYPE'
            'TRIGGER'           = 'SQL_TRIGGER'
        }
        $dbObjects = @($preTyped | ForEach-Object {
            [PSCustomObject]@{
                SchemaName = [string]$_.schemaName
                ObjectName = [string]$_.objectName
                TypeDesc   = if ($typeMap.ContainsKey([string]$_.objectType)) { $typeMap[[string]$_.objectType] } else { [string]$_.objectType }
                CreateDate = $null
            }
        })
    }
    else {
        $dbObjects = $resolvedDbObjects
    }

    # SMO scripting options
    $scripter = New-BaseScripter $smoServer
    $scripter.Options.Indexes = $true
    $scripter.Options.Triggers = $true
    $scripter.Options.DriAll = $true

    $tableScripter = New-DacpacTableScripter $smoServer

    foreach ($entry in $objects) {

        $count++

        if ($count % 5 -eq 0 -or $count -eq $total) {
            Write-Progress -Id 1 -Activity "Exporting DB Objects" -Status "$count / $total" -PercentComplete ([int](($count / $total) * 100))
        }

        $schema, $name = $entry.Split(".", 2)

        $actual = $dbObjects | Where-Object {
            $_.ObjectName -ieq $name -and $_.SchemaName -ieq $schema
        } | Select-Object -First 1

        if (!$actual) {
            Write-Warning "Object not found: $schema.$name"
            continue
        }

        $resolvedSchema = [string]$actual.SchemaName
        $resolvedObjectName = [string]$actual.ObjectName

        # Map TypeDesc to canonical key (used for SMO lookup) and folder name (may be overridden)
        $typeKey = switch ($actual.TypeDesc) {
            "USER_TABLE"           { "Tables" }
            "VIEW"                 { "Views" }
            "SQL_STORED_PROCEDURE" { "Stored Procedures" }
            "SYNONYM"              { "Synonyms" }
            "SEQUENCE_OBJECT"      { "Sequences" }
            "USER_TABLE_TYPE"      { "User Defined Types" }
            default                { "Functions" }
        }

        # Apply folder name override if provided; $type is used for folder creation
        $type = if ($_folderOverrides.ContainsKey($actual.TypeDesc)) { $_folderOverrides[$actual.TypeDesc] } else { $typeKey }

        # Get SMO object (always use canonical $typeKey for collection lookup)
        $obj = $null
    if ($typeKey -eq "Stored Procedures") { $obj = $db.StoredProcedures[$resolvedObjectName, $resolvedSchema] }
    elseif ($typeKey -eq "Views") { $obj = $db.Views[$resolvedObjectName, $resolvedSchema] }
    elseif ($typeKey -eq "Functions") { $obj = $db.UserDefinedFunctions[$resolvedObjectName, $resolvedSchema] }
    elseif ($typeKey -eq "Tables") { $obj = $db.Tables[$resolvedObjectName, $resolvedSchema] }
    elseif ($typeKey -eq "Synonyms") { $obj = $db.Synonyms[$resolvedObjectName, $resolvedSchema] }
    elseif ($typeKey -eq "Sequences") { $obj = $db.Sequences[$resolvedObjectName, $resolvedSchema] }
    elseif ($typeKey -eq "User Defined Types") { $obj = $db.UserDefinedTableTypes[$resolvedObjectName, $resolvedSchema] }

        $text = ""
        if ($typeKey -in @("Stored Procedures", "Views", "Functions")) {
            # Prefer the database module definition so source exports preserve the authored formatting.
            $escapedSchema = $resolvedSchema.Replace("'", "''")
            $escapedName = $resolvedObjectName.Replace("'", "''")
            $definitionQuery = @"
SELECT TOP 1 m.definition AS DefinitionText
    , m.uses_ansi_nulls AS UsesAnsiNulls
    , m.uses_quoted_identifier AS UsesQuotedIdentifier
FROM sys.objects o
INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
LEFT JOIN sys.sql_modules m ON m.object_id = o.object_id
WHERE s.name = N'$escapedSchema'
  AND o.name = N'$escapedName';
"@

            try {
                $defRow = $db.ExecuteWithResults($definitionQuery).Tables[0].Rows | Select-Object -First 1
                if ($defRow -and $defRow.DefinitionText) {
                    $text = Format-ModuleDefinitionText -DefinitionText ([string]$defRow.DefinitionText) -UsesAnsiNulls $defRow.UsesAnsiNulls -UsesQuotedIdentifier $defRow.UsesQuotedIdentifier
                }
            }
            catch {
                # Fall back to SMO scripting below if the definition query fails.
            }
        }

        if ([string]::IsNullOrWhiteSpace($text) -and $obj) {
            # Fall back to SMO scripting for tables, synonyms, sequences, types, or when a module definition is unavailable.
            if ($typeKey -eq "Tables") {
                $text = Format-DacpacTableScript -ScriptLines ($tableScripter.Script($obj)) -ObjectName "$resolvedSchema.$resolvedObjectName"
            }
            else {
                $text = Clean-SqlScript (Convert-Script ($scripter.Script($obj)))
            }
        }

        if ([string]::IsNullOrWhiteSpace($text)) {
            Write-Warning "Scripting failed: $resolvedSchema.$resolvedObjectName"
            continue
        }

        if ($app_task_mode -eq "deploy" -and $typeKey -in @("Stored Procedures", "Views", "Functions")) {
            $text = $text -replace "(?im)^\s*CREATE\s+(?:OR\s+ALTER\s+)?(?:PROCEDURE|PROC)\b", "CREATE OR ALTER PROCEDURE"
            $text = $text -replace "(?im)^\s*CREATE\s+(?:OR\s+ALTER\s+)?VIEW\b", "CREATE OR ALTER VIEW"
            $text = $text -replace "(?im)^\s*CREATE\s+(?:OR\s+ALTER\s+)?FUNCTION\b", "CREATE OR ALTER FUNCTION"
        }

        # Combine SP file using the same CREATE/CREATE OR ALTER mode as the individual files.
        if ($shouldWriteCombinedArtifacts -and $type -eq "Stored Procedures") {
            $spScript = $text
            $spScript = $spScript -replace "(?im)^\s*CREATE\s+(?:OR\s+ALTER\s+)?(?:PROCEDURE|PROC)\b", "CREATE OR ALTER PROCEDURE"
            $spScript = [regex]::Replace($spScript.Trim(), "(?im)(?:\r?\n)?GO\s*$", "")

            $allSPContent += $spScript.Trim()
            $allSPContent += "GO"
        }

        if ($type -eq "Tables" -and $shouldWriteCombinedTableScript) {
            $qualifiedTableName = Get-QualifiedSqlName -SchemaName $resolvedSchema -ObjectName $resolvedObjectName
            $tableDropStatements += "IF OBJECT_ID(N'$qualifiedTableName', N'U') IS NOT NULL"
            $tableDropStatements += "    DROP TABLE $qualifiedTableName"
            $tableDropStatements += "GO"

            $tableScript = $text -replace "(?im)^\s*GO\s*$", ""
            $allTableContent += $tableScript.Trim()
            $allTableContent += "GO"

            # Generate update template for this table
            $pkCols = @()
            $pkTypes = @()
            if ($obj -and $obj.Columns) {
                foreach ($col in $obj.Columns) {
                    if ($col.InPrimaryKey) {
                        $pkCols += $col.Name
                        $pkTypes += $col.DataType.Name
                    }
                }
            }
            if ($pkCols.Count -gt 0) {
                $updateTemplate = @()
                $updateTemplate += "-- Update for $qualifiedTableName"
                for ($i = 0; $i -lt $pkCols.Count; $i++) {
                    $pkVar = "@${($pkCols[$i])}"
                    $pkType = $pkTypes[$i]
                    $updateTemplate += "DECLARE $pkVar $pkType"
                }
                $updateTemplate += "UPDATE $qualifiedTableName"
                $updateTemplate += "SET /* column = value */"
                $whereClause = ($pkCols | ForEach-Object { "$_ = @$_" }) -join ' AND '
                $updateTemplate += "WHERE $whereClause"
                $updateTemplate += "GO"
                $updateTemplate += ""
                $allTableUpdateTemplates += $updateTemplate
            }
            else {
                $allTableUpdateTemplates += "-- Update for $qualifiedTableName (no PK detected)"
                $allTableUpdateTemplates += "-- No primary key found, manual edit required."
                $allTableUpdateTemplates += "GO"
                $allTableUpdateTemplates += ""
            }
        }

        # Save individual file
        $typeFolder = Join-Path (Join-Path $dbFolder $resolvedSchema) $type
        Ensure-Directory $typeFolder

        $fileName = "$resolvedObjectName.sql"
        $savePath = Join-Path $typeFolder $fileName
        Write-ContentAtomically $savePath $text

        # BuildPaths entry
        $buildEntries += [pscustomobject]@{
            CreateDate = $actual.CreateDate
            Path       = "$resolvedSchema\$type\$fileName"
        }

        # Summary
        $key = "$resolvedSchema|$type"
        if (!$summary.ContainsKey($key)) { $summary[$key] = 0 }
        $summary[$key]++
    }

    # BuildPaths file per DB
    $buildEntries = $buildEntries | Sort-Object CreateDate
    $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $buildFileName = [System.IO.Path]::GetFileNameWithoutExtension($BuildPathFileName) + "_$timestamp" + [System.IO.Path]::GetExtension($BuildPathFileName)

    $buildFilePath = Join-Path $dbFolder $buildFileName
    $lines = @()
    foreach ($e in $buildEntries) {
        $lines += "<Build Include=""$($e.Path)"" />"
    }

    Set-Content -Path $buildFilePath -Value $lines

    # Combined Stored Procedures file
if ($shouldWriteCombinedArtifacts -and $allSPContent.Count -gt 0) {

    $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"

    $spFileName = "AllStoredProcedures_$timestamp.sql"
    $spFilePath = Join-Path $dbFolder $spFileName

    Write-ContentAtomically $spFilePath ($allSPContent -join "`r`n`r`n")

    Write-Host "Combined SP file: $spFilePath"
}

    # Combined Tables file
    if ($shouldWriteCombinedTableScript -and $allTableContent.Count -gt 0) {

        $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"

        $tableFileName = "AllTables_$timestamp.sql"
        $tableFilePath = Join-Path $dbFolder $tableFileName
        $combinedTableContent = @()
        $combinedTableContent += $tableDropStatements
        $combinedTableContent += ""
        $combinedTableContent += $allTableContent

        Write-ContentAtomically $tableFilePath ($combinedTableContent -join "`r`n`r`n")

        Write-Host "Combined table file: $tableFilePath"

        # Write combined update templates
        if ($allTableUpdateTemplates.Count -gt 0) {
            $updateFileName = "AllTables_UpdateTemplates_$timestamp.sql"
            $updateFilePath = Join-Path $dbFolder $updateFileName
            Write-ContentAtomically $updateFilePath ($allTableUpdateTemplates -join "`r`n")
            Write-Host "Combined table update template file: $updateFilePath"
        }
    }
    Write-Host "`nCompleted DB: $dbName"


}

# Close progress bar

Write-Progress -Id 1 -Activity "Exporting DB Objects" -Completed

# Summary

Write-Host "`n========== EXPORT SUMMARY =========="
foreach ($k in $summary.Keys) {
    $p = $k.Split("|")
    Write-Host "$($p[0]) - $($p[1]) : $($summary[$k])"
}

Write-Host "`nCompleted Successfully." -ForegroundColor Green
