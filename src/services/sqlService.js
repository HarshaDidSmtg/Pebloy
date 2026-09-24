const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { execFile } = require("child_process");
const { normalizeDdlKeywords } = require("./scriptAutomationService");
const { splitSqlBatches, replaceSqlCode } = require("./sqlBatchService");

const SQL_QUERY_TIMEOUT_MS = 120000;
const POWERSHELL_TIMEOUT_MS = 180000;

// Read per call so a Settings change applies without restarting the backend.
function executionTimeouts() {
  try {
    const { execution } = require("./settingsService").getSettings();
    return {
      queryMs: execution.queryTimeoutSeconds * 1000,
      shellMs: execution.powershellTimeoutSeconds * 1000,
    };
  } catch (_error) {
    return { queryMs: SQL_QUERY_TIMEOUT_MS, shellMs: POWERSHELL_TIMEOUT_MS };
  }
}

function queryTimeoutSeconds() {
  return Math.floor(executionTimeouts().queryMs / 1000);
}

function normalizeAuthenticationType(rawType) {
  const value = String(rawType || "").trim().toLowerCase();
  if (value === "sql" || value === "sqlauth" || value === "sqlauthentication") {
    return "Sql";
  }
  if (value === "windows") {
    return "Windows";
  }
  return "Unknown";
}

function escapeSingleQuotes(value) {
  return String(value || "").replace(/'/g, "''");
}

function escapeSqlLiteral(value) {
  return `N'${escapeSingleQuotes(value)}'`;
}

function quoteSqlName(value) {
  return `[${String(value || "").replace(/]/g, "]]")}]`;
}

function splitSqlServerName(serverName) {
  const value = String(serverName || "").trim();
  const commaIndex = value.indexOf(",");
  const slashIndex = value.indexOf("\\");
  const cutIndex =
    commaIndex === -1 ? slashIndex : slashIndex === -1 ? commaIndex : Math.min(commaIndex, slashIndex);

  if (cutIndex === -1) {
    return { host: value, suffix: "" };
  }

  return {
    host: value.slice(0, cutIndex),
    suffix: value.slice(cutIndex),
  };
}

function parseSqlNetworkTarget(serverName) {
  const { host, suffix } = splitSqlServerName(serverName);
  const portMatch = suffix.match(/^,(\d+)$/);
  return {
    host: host || serverName,
    port: portMatch ? Number.parseInt(portMatch[1], 10) : 1433,
  };
}

// PowerShell 7 colors its error stream with ANSI escapes even when
// redirected; they must never reach logs or the UI.
function stripAnsiCodes(text) {
  return String(text || "").replace(/\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function cleanPowerShellError(raw) {
  const text = stripAnsiCodes(raw);
  const xmlErrorParts = Array.from(text.matchAll(/<S S=\"Error\">([\s\S]*?)<\/S>/g)).map((m) => m[1]);
  const xmlText = xmlErrorParts
    .join(" ")
    .replace(/_x000D__x000A_/g, "\n")
    .replace(/\s+/g, " ")
    .trim();

  const fallbackText = text
    .replace(/_x000D__x000A_/g, "\n")
    .replace(/\s+/g, " ")
    .trim();

  return xmlText || fallbackText;
}

function withUtf8PowerShellPreamble(scriptText) {
  const normalized = String(scriptText || "").replace(/^\uFEFF/, "");
  return [
    "$OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$PebloyPassword = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()))",
    normalized,
  ].join("\n");
}

function runPowerShell(scriptText, maxBuffer = 1024 * 1024 * 20, password = "") {
  const tempFile = path.join(os.tmpdir(), `pebloy_${randomUUID()}.ps1`);
  fs.writeFileSync(tempFile, withUtf8PowerShellPreamble(scriptText), "utf8");

  return new Promise((resolve, reject) => {
    const child = execFile(
      "pwsh",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", tempFile],
      {
        encoding: "utf8",
        maxBuffer,
        timeout: executionTimeouts().shellMs,
        env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
      },
      (error, stdout, stderr) => {
        try {
          fs.unlinkSync(tempFile);
        } catch (_e) {
          // Ignore cleanup errors for temp files.
        }

        if (error) {
          error.cleanedMessage = cleanPowerShellError(stderr || stdout || error.message);
          reject(error);
          return;
        }
        resolve(String(stdout || "").trim());
      }
    );
    child?.stdin?.on("error", (error) => { if (error.code !== "EPIPE") child.kill(); });
    child?.stdin?.end(Buffer.from(String(password || ""), "utf8").toString("base64"));
  });
}

function runPowerShellLines(
  scriptText,
  onLine,
  maxBuffer = 1024 * 1024 * 20,
  timeoutMs = null,
  password = ""
) {
  const tempFile = path.join(os.tmpdir(), `pebloy_${randomUUID()}.ps1`);
  fs.writeFileSync(tempFile, withUtf8PowerShellPreamble(scriptText), "utf8");

  return new Promise((resolve, reject) => {
    let pending = "";
    let lineError = null;
    const child = execFile(
      "pwsh",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", tempFile],
      {
        encoding: "utf8",
        maxBuffer,
        timeout: timeoutMs || executionTimeouts().shellMs,
        env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
      },
      (error, stdout, stderr) => {
        try {
          fs.unlinkSync(tempFile);
        } catch (_e) {
          // Ignore cleanup errors for temp files.
        }

        if (!lineError && pending.trim()) {
          try {
            onLine(pending.trim());
          } catch (error) {
            lineError = error;
          }
        }
        pending = "";
        if (lineError) {
          reject(lineError);
          return;
        }
        if (error) {
          error.cleanedMessage = cleanPowerShellError(stderr || stdout || error.message);
          reject(error);
          return;
        }
        resolve();
      }
    );

    child.stdin?.on("error", (error) => { if (error.code !== "EPIPE") child.kill(); });
    child.stdin?.end(Buffer.from(String(password || ""), "utf8").toString("base64"));
    child.stdout.on("data", (chunk) => {
      if (lineError) return;
      try {
        pending += String(chunk || "");
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || "";
        for (const line of lines) {
          if (line.trim()) {
            onLine(line.trim());
          }
        }
      } catch (error) {
        lineError = error;
        pending = "";
        child.kill();
      }
    });
  });
}

async function runSmoQuery(profile, queryText, options = {}) {
  const authType = normalizeAuthenticationType(profile.authenticationType);
  if (authType !== "Windows" && authType !== "Sql") {
    throw new Error("Unsupported authentication type.");
  }

  if (authType === "Sql" && (!profile.username || !profile.password)) {
    throw new Error("SQL Authentication selected but username/password not provided.");
  }

  const { host, suffix } = splitSqlServerName(profile.serverName);
  const server = escapeSingleQuotes(profile.serverName);
  const serverHost = escapeSingleQuotes(host);
  const serverSuffix = escapeSingleQuotes(suffix);
  const database = escapeSingleQuotes(profile.databaseName);
  const username = escapeSingleQuotes(profile.username);
  const queryBase64 = Buffer.from(queryText, "utf8").toString("base64");
  const executionMode = options.executionMode === "nonQuery" ? "nonQuery" : "query";

  const psScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Data
$query = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${queryBase64}'))
$serverCandidates = New-Object System.Collections.Generic.List[string]

if ('${serverHost}' -match '^\\d{1,3}(\\.\\d{1,3}){3}$') {
  try {
    $resolved = [System.Net.Dns]::GetHostEntry('${serverHost}').HostName
    if ($resolved) {
      $resolvedCandidate = "$resolved${serverSuffix}"
      $serverCandidates.Add($resolvedCandidate)
    }
  } catch {
    # Ignore DNS reverse lookup errors.
  }
}

if (-not $serverCandidates.Contains('${server}')) {
  $serverCandidates.Add('${server}')
}

$lastError = $null
foreach ($candidate in $serverCandidates) {
  $connection = $null
  try {
    $builder = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
    $builder['Data Source'] = "tcp:$candidate"
    $builder['Initial Catalog'] = '${database}'
    $builder['TrustServerCertificate'] = $true
    $builder['Encrypt'] = $false
    $builder['Connect Timeout'] = 10
    $builder['Application Name'] = 'Pebloy'

    if ('${authType}' -eq 'Windows') {
      $builder['Integrated Security'] = $true
    } else {
      $builder['User ID'] = '${username}'
      $builder['Password'] = $PebloyPassword
      $builder['Integrated Security'] = $false
    }
    $connectionString = $builder.ConnectionString

    $connection = New-Object System.Data.SqlClient.SqlConnection($connectionString)
    $connection.Open()
    $command = $connection.CreateCommand()
    $command.CommandText = $query
    $command.CommandTimeout = ${queryTimeoutSeconds()}

    if ('${executionMode}' -eq 'nonQuery') {
      $rowsAffected = $command.ExecuteNonQuery()
      [pscustomobject]@{ rowsAffected = $rowsAffected } | ConvertTo-Json -Compress
      exit 0
    }

    $adapter = New-Object System.Data.SqlClient.SqlDataAdapter($command)
    $dataSet = New-Object System.Data.DataSet
    [void]$adapter.Fill($dataSet)
    if ($null -eq $dataSet -or $dataSet.Tables.Count -eq 0) {
      Write-Output '[]'
      exit 0
    }

    $table = $dataSet.Tables[0]
    $rows = New-Object System.Collections.Generic.List[object]
    foreach ($row in $table.Rows) {
      $obj = [ordered]@{}
      foreach ($col in $table.Columns) {
        $val = $row[$col]
        if ($val -is [System.DBNull]) {
          $obj[$col.ColumnName] = $null
        } elseif ($val -is [System.DateTime]) {
          $obj[$col.ColumnName] = $val.ToString('yyyy-MM-ddTHH:mm:ss')
        } else {
          $obj[$col.ColumnName] = $val
        }
      }
      $rows.Add([pscustomobject]$obj)
    }

    $rows | ConvertTo-Json -Depth 30 -Compress
    exit 0
  } catch {
    $messages = New-Object System.Collections.Generic.List[string]
    $ex = $_.Exception
    while ($null -ne $ex) {
      if (![string]::IsNullOrWhiteSpace($ex.Message)) {
        $messages.Add($ex.Message)
      }
      $ex = $ex.InnerException
    }
    $lastError = "Server '$candidate' failed: $($messages -join ' | ')"
  } finally {
    if ($null -ne $connection) {
      $connection.Close()
      $connection.Dispose()
    }
  }
}

if ($lastError) {
  throw $lastError
} else {
  throw "SQL query failed for unknown reason."
}
`;

  let output;
  try {
    output = await runPowerShell(psScript, 1024 * 1024 * 20, profile.password);
  } catch (error) {
    const text = error.cleanedMessage || cleanPowerShellError(error.message);

    if (/timeout/i.test(text)) {
      throw new Error(
        `SQL connection timed out for ${profile.serverName}/${profile.databaseName}. Verify SQL server reachability, firewall, and instance/network settings.`
      );
    }

    if (/login failed/i.test(text)) {
      throw new Error(
        "Login failed. Verify server/database, authentication type, username, and password. If password was recently changed, edit and save the profile again."
      );
    }

    throw new Error(text || "SQL query failed.");
  }

  if (!output) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (_err) {
    throw new Error(`PowerShell returned non-JSON output: ${output.slice(0, 300)}`);
  }
  if (Array.isArray(parsed)) {
    return parsed;
  }
  return parsed ? [parsed] : [];
}

function runPowerShellJson(scriptText) {
  return runPowerShell(scriptText, 1024 * 1024 * 10).then((output) => {
    if (!output) {
      return null;
    }
    try {
      return JSON.parse(output);
    } catch (_err) {
      throw new Error(`PowerShell returned non-JSON output: ${output.slice(0, 300)}`);
    }
  });
}

async function testConnection(profile) {
  const authType = normalizeAuthenticationType(profile.authenticationType);
  if (authType === "Windows" || authType === "Sql") {
    const rows = await runSmoQuery(profile, "SELECT @@SERVERNAME AS serverName, DB_NAME() AS databaseName;");
    return rows[0] || null;
  }

  throw new Error("Unsupported authentication type.");
}

async function runConnectionDiagnostics(profile) {
  const diagnostics = {
    server: profile.serverName,
    database: profile.databaseName,
    authenticationType: profile.authenticationType,
    network: null,
    sqlConnection: null,
    summary: {
      status: "Unknown",
      checksPassed: 0,
      checksFailed: 0,
    },
  };

  try {
    const target = parseSqlNetworkTarget(profile.serverName);
    const server = escapeSingleQuotes(target.host);
    const networkPs = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$tnc = Test-NetConnection -ComputerName '${server}' -Port ${target.port} -WarningAction SilentlyContinue
[pscustomobject]@{
  computerName = $tnc.ComputerName
  remotePort = ${target.port}
  remoteAddress = [string]$tnc.RemoteAddress
  tcpTestSucceeded = [bool]$tnc.TcpTestSucceeded
  pingSucceeded = [bool]$tnc.PingSucceeded
} | ConvertTo-Json -Compress
`;
    diagnostics.network = await runPowerShellJson(networkPs);
    diagnostics.summary.checksPassed += diagnostics.network && diagnostics.network.tcpTestSucceeded ? 1 : 0;
    diagnostics.summary.checksFailed += diagnostics.network && diagnostics.network.tcpTestSucceeded ? 0 : 1;
  } catch (error) {
    diagnostics.network = { error: error.message };
    diagnostics.summary.checksFailed += 1;
  }

  try {
    const result = await testConnection(profile);
    diagnostics.sqlConnection = {
      ok: true,
      serverName: result?.serverName || null,
      databaseName: result?.databaseName || null,
    };
    diagnostics.summary.checksPassed += 1;
  } catch (error) {
    diagnostics.sqlConnection = {
      ok: false,
      error: error.message,
    };
    diagnostics.summary.checksFailed += 1;
  }

  if (diagnostics.summary.checksFailed === 0) {
    diagnostics.summary.status = "Healthy";
  } else if (diagnostics.summary.checksPassed > 0) {
    diagnostics.summary.status = "Warning";
  } else {
    diagnostics.summary.status = "Failed";
  }

  return diagnostics;
}

async function discoverObjects(profile, filters = {}) {
  const typeFilter = filters.type || "";
  const schemaFilter = filters.schema || "";
  const searchFilter = filters.search || "";

  const query = `
WITH ObjectCatalog AS (
  SELECT
    'TABLE' AS objectType,
    s.name AS schemaName,
    t.name AS objectName,
    t.create_date AS createdDate,
    t.modify_date AS modifiedDate
  FROM sys.tables t
  INNER JOIN sys.schemas s ON s.schema_id = t.schema_id

  UNION ALL

  SELECT
    CASE o.type
      WHEN 'V' THEN 'VIEW'
      WHEN 'P' THEN 'PROCEDURE'
      WHEN 'FN' THEN 'FUNCTION'
      WHEN 'TF' THEN 'FUNCTION'
      WHEN 'IF' THEN 'FUNCTION'
      WHEN 'TR' THEN 'TRIGGER'
      ELSE 'OTHER'
    END,
    s.name,
    o.name,
    o.create_date,
    o.modify_date
  FROM sys.objects o
  INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
  WHERE o.type IN ('V','P','FN','TF','IF','TR')

  UNION ALL

  SELECT 'SYNONYM', s.name, sn.name, sn.create_date, sn.modify_date
  FROM sys.synonyms sn
  INNER JOIN sys.schemas s ON s.schema_id = sn.schema_id

  UNION ALL

  SELECT 'SEQUENCE', s.name, sq.name, sq.create_date, sq.modify_date
  FROM sys.sequences sq
  INNER JOIN sys.schemas s ON s.schema_id = sq.schema_id

  UNION ALL

  SELECT 'USER_DEFINED_TYPE', s.name, ty.name, NULL AS createdDate, NULL AS modifiedDate
  FROM sys.types ty
  INNER JOIN sys.schemas s ON s.schema_id = ty.schema_id
  WHERE ty.is_user_defined = 1
)
SELECT objectType, schemaName, objectName, createdDate, modifiedDate
FROM ObjectCatalog
WHERE (@typeFilter = '' OR objectType = @typeFilter)
  AND (@schemaFilter = '' OR schemaName = @schemaFilter)
  AND (@searchFilter = '' OR objectName LIKE '%' + @searchFilter + '%' OR schemaName LIKE '%' + @searchFilter + '%')
ORDER BY
  CASE objectType
    WHEN 'USER_DEFINED_TYPE' THEN 1
    WHEN 'SEQUENCE' THEN 2
    WHEN 'TABLE' THEN 3
    WHEN 'VIEW' THEN 4
    WHEN 'FUNCTION' THEN 5
    WHEN 'PROCEDURE' THEN 6
    WHEN 'SYNONYM' THEN 7
    WHEN 'TRIGGER' THEN 8
    ELSE 9
  END,
  schemaName,
  objectName;
`;

  const authType = normalizeAuthenticationType(profile.authenticationType);
  if (authType === "Windows" || authType === "Sql") {
    const wrapped = `
DECLARE @typeFilter nvarchar(256) = ${escapeSqlLiteral(typeFilter)};
DECLARE @schemaFilter nvarchar(256) = ${escapeSqlLiteral(schemaFilter)};
DECLARE @searchFilter nvarchar(256) = ${escapeSqlLiteral(searchFilter)};
${query}
`;
    return await runSmoQuery(profile, wrapped);
  }

  throw new Error("Unsupported authentication type.");
}

function normalizeDefinition(value) {
  return normalizeDdlKeywords(String(value || "").replace(/\r\n/g, "\n").trim());
}

const MODULE_DEFINITION_OBJECT_TYPES = new Set(["PROCEDURE", "VIEW", "FUNCTION", "TRIGGER"]);
const MODULE_DDL_START_PATTERN = /(^|\n)\s*((?:CREATE(?:\s+OR\s+ALTER)?|ALTER)\s+(?:PROCEDURE|PROC|VIEW|FUNCTION|TRIGGER)\b)/im;

function normalizeBitFlag(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return null;
}

const MODULE_DDL_LINE_PATTERN = /^(?:CREATE(?:\s+OR\s+ALTER)?|ALTER)\s+(?:PROCEDURE|PROC|VIEW|FUNCTION|TRIGGER)\b/i;
const SESSION_SET_LINE_PATTERN = /^SET\s+(?:ANSI_NULLS|QUOTED_IDENTIFIER)\s+(?:ON|OFF)\s*;?\s*$/i;
const GO_SEPARATOR_LINE_PATTERN = /^GO(?:\s+\d+)?\s*$/i;

// Remove ONLY session-setting headers (SET ANSI_NULLS / SET QUOTED_IDENTIFIER
// and their GO separators) that precede the module DDL. Authored comments
// above CREATE are part of the module definition and MUST be preserved —
// slicing at the DDL start used to delete developers' header banners.
function stripLeadingSessionSetHeaders(text) {
  const lines = String(text || "").split("\n");
  const result = [];
  let reachedDdl = false;
  let blockCommentDepth = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!reachedDdl && blockCommentDepth === 0) {
      if (MODULE_DDL_LINE_PATTERN.test(trimmed)) {
        reachedDdl = true;
      } else if (SESSION_SET_LINE_PATTERN.test(trimmed) || GO_SEPARATOR_LINE_PATTERN.test(trimmed)) {
        continue;
      }
    }

    if (!reachedDdl) {
      blockCommentDepth += (trimmed.match(/\/\*/g) || []).length;
      blockCommentDepth -= (trimmed.match(/\*\//g) || []).length;
      if (blockCommentDepth < 0) blockCommentDepth = 0;
    }

    result.push(line);
  }

  return result.join("\n").trim();
}

function composeModuleDefinition(definition, usesAnsiNulls, usesQuotedIdentifier) {
  const body = normalizeDefinition(definition);
  if (!body) {
    return "";
  }

  // Downgrade deploy-only CREATE OR ALTER to canonical CREATE at the DDL
  // line itself so leading comments do not defeat the anchor.
  return replaceSqlCode(stripLeadingSessionSetHeaders(body),
    /(^|\n)([ \t]*)CREATE\s+OR\s+ALTER\s+(PROCEDURE|PROC|VIEW|FUNCTION|TRIGGER)\b/i,
    (_match, prefix, indent, objectType) => `${prefix}${indent}CREATE ${objectType}`
  );
}

async function fetchObjectDefinitionMap(profile, selectedObjects = []) {
  const selectedConditions = (selectedObjects || [])
    .map((item) => ({
      objectType: String(item.objectType || "").toUpperCase().trim(),
      schemaName: String(item.schemaName || "").trim(),
      objectName: String(item.objectName || "").trim(),
    }))
    .filter((item) => item.objectType && item.schemaName && item.objectName)
    .map(
      (item) =>
        `(objectType = ${escapeSqlLiteral(item.objectType)} AND schemaName = ${escapeSqlLiteral(
          item.schemaName
        )} AND objectName = ${escapeSqlLiteral(item.objectName)})`
    );

  const selectedFilterSql = selectedConditions.length ? `WHERE ${selectedConditions.join(" OR ")}` : "";

  const query = `
WITH ObjectDefinitions AS (
SELECT
  CASE
    WHEN o.type IN ('FN','TF','IF') THEN 'FUNCTION'
    WHEN o.type = 'P' THEN 'PROCEDURE'
    WHEN o.type = 'V' THEN 'VIEW'
    WHEN o.type = 'TR' THEN 'TRIGGER'
    ELSE o.type
  END AS objectType,
  s.name AS schemaName,
  o.name AS objectName,
  m.definition AS definition,
  m.uses_ansi_nulls AS usesAnsiNulls,
  m.uses_quoted_identifier AS usesQuotedIdentifier
FROM sys.objects o
INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
LEFT JOIN sys.sql_modules m ON m.object_id = o.object_id
WHERE o.type IN ('FN','TF','IF','P','V','TR')

UNION ALL

SELECT
  'TABLE' AS objectType,
  s.name AS schemaName,
  t.name AS objectName,
  STUFF((
    SELECT CHAR(10) +
      QUOTENAME(c.name) + ' ' + ty.name +
      CASE
        WHEN ty.name IN ('varchar','char','varbinary','binary')
          THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length AS varchar(10)) END + ')'
        WHEN ty.name IN ('nvarchar','nchar')
          THEN '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length / 2 AS varchar(10)) END + ')'
        WHEN ty.name IN ('decimal','numeric')
          THEN '(' + CAST(c.precision AS varchar(10)) + ',' + CAST(c.scale AS varchar(10)) + ')'
        WHEN ty.name IN ('datetime2','datetimeoffset','time')
          THEN '(' + CAST(c.scale AS varchar(10)) + ')'
        ELSE ''
      END +
      CASE WHEN c.is_identity = 1 THEN ' IDENTITY' ELSE '' END +
      CASE WHEN c.is_nullable = 1 THEN ' NULL' ELSE ' NOT NULL' END +
      CASE WHEN pkc.column_id IS NOT NULL THEN ' [PK]' ELSE '' END +
      CASE WHEN dc.definition IS NOT NULL THEN ' DEFAULT ' + dc.definition ELSE '' END
    FROM sys.columns c
    INNER JOIN sys.types ty ON ty.user_type_id = c.user_type_id
    LEFT JOIN (
      SELECT ic_pk.object_id, ic_pk.column_id
      FROM sys.index_columns ic_pk
      INNER JOIN sys.indexes idx_pk
        ON idx_pk.object_id = ic_pk.object_id AND idx_pk.index_id = ic_pk.index_id AND idx_pk.is_primary_key = 1
    ) pkc ON pkc.object_id = c.object_id AND pkc.column_id = c.column_id
    LEFT JOIN sys.default_constraints dc
      ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
    WHERE c.object_id = t.object_id AND c.is_computed = 0
    ORDER BY c.column_id
    FOR XML PATH(''), TYPE
  ).value('.', 'nvarchar(max)'), 1, 1, '') +
  COALESCE((
    SELECT CHAR(10) + STUFF((
      SELECT CHAR(10) + 'INDEX ' + QUOTENAME(idx.name) +
        ' (' +
        STUFF((
          SELECT ',' + QUOTENAME(c2.name) +
            CASE ic2.is_descending_key WHEN 1 THEN ' DESC' ELSE '' END
          FROM sys.index_columns ic2
          INNER JOIN sys.columns c2
            ON c2.object_id = ic2.object_id AND c2.column_id = ic2.column_id
          WHERE ic2.object_id = idx.object_id AND ic2.index_id = idx.index_id
            AND ic2.is_included_column = 0
          ORDER BY ic2.key_ordinal
          FOR XML PATH(''), TYPE
        ).value('.', 'nvarchar(max)'), 1, 1, '') + ')' +
        CASE WHEN idx.is_unique = 1 AND idx.is_primary_key = 0 THEN ' UNIQUE' ELSE '' END +
        CASE WHEN idx.is_primary_key = 1 THEN ' [PK]' ELSE '' END
      FROM sys.indexes idx
      WHERE idx.object_id = t.object_id AND idx.type > 0
      ORDER BY idx.is_primary_key DESC, idx.name
      FOR XML PATH(''), TYPE
    ).value('.', 'nvarchar(max)'), 1, 1, '')
  ), '') AS definition,
  CAST(NULL AS bit) AS usesAnsiNulls,
  CAST(NULL AS bit) AS usesQuotedIdentifier
FROM sys.tables t
INNER JOIN sys.schemas s ON s.schema_id = t.schema_id

UNION ALL

SELECT
  'SYNONYM',
  s.name,
  sn.name,
  sn.base_object_name,
  CAST(NULL AS bit),
  CAST(NULL AS bit)
FROM sys.synonyms sn
INNER JOIN sys.schemas s ON s.schema_id = sn.schema_id

UNION ALL

SELECT
  'SEQUENCE',
  s.name,
  sq.name,
  CONCAT(
    'START WITH ',
    CONVERT(nvarchar(100), sq.start_value),
    '; INCREMENT BY ',
    CONVERT(nvarchar(100), sq.increment)
  ),
  CAST(NULL AS bit),
  CAST(NULL AS bit)
FROM sys.sequences sq
INNER JOIN sys.schemas s ON s.schema_id = sq.schema_id

UNION ALL

SELECT
  'USER_DEFINED_TYPE',
  s.name,
  ty.name,
  CONCAT(ty.name, ' based on ', bty.name),
  CAST(NULL AS bit),
  CAST(NULL AS bit)
FROM sys.types ty
INNER JOIN sys.types bty ON bty.user_type_id = ty.system_type_id AND bty.user_type_id = bty.system_type_id
INNER JOIN sys.schemas s ON s.schema_id = ty.schema_id
WHERE ty.is_user_defined = 1
)
SELECT objectType, schemaName, objectName, definition, usesAnsiNulls, usesQuotedIdentifier
FROM ObjectDefinitions
${selectedFilterSql};
`;

  const authType = normalizeAuthenticationType(profile.authenticationType);
  if (authType !== "Windows" && authType !== "Sql") {
    throw new Error("Unsupported authentication type.");
  }

  const rows = await runSmoQuery(profile, query);

  const map = new Map();
  rows.forEach((row) => {
    const key = `${row.objectType}|${row.schemaName}|${row.objectName}`;
    const definition = MODULE_DEFINITION_OBJECT_TYPES.has(String(row.objectType || "").toUpperCase())
      ? composeModuleDefinition(row.definition, row.usesAnsiNulls, row.usesQuotedIdentifier)
      : normalizeDefinition(row.definition);

    map.set(key, {
      objectType: row.objectType,
      schemaName: row.schemaName,
      objectName: row.objectName,
      definition,
      usesAnsiNulls: normalizeBitFlag(row.usesAnsiNulls),
      usesQuotedIdentifier: normalizeBitFlag(row.usesQuotedIdentifier),
    });
  });
  return map;
}

async function executeSql(profile, sqlText) {
  return executeSqlScript(profile, sqlText);
}

async function executeSqlScript(profile, sqlText, options = {}) {
  const authType = normalizeAuthenticationType(profile.authenticationType);
  if (authType !== "Windows" && authType !== "Sql") {
    throw new Error("Unsupported authentication type.");
  }

  const batches = splitSqlBatches(sqlText);

  if (!batches.length) {
    return;
  }

  const { host, suffix } = splitSqlServerName(profile.serverName);
  const server = escapeSingleQuotes(profile.serverName);
  const serverHost = escapeSingleQuotes(host);
  const serverSuffix = escapeSingleQuotes(suffix);
  const database = escapeSingleQuotes(profile.databaseName);
  const username = escapeSingleQuotes(profile.username);
  const payloadBase64 = Buffer.from(JSON.stringify(batches), "utf8").toString("base64");

  const psScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Data
$batches = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${payloadBase64}')) | ConvertFrom-Json
$serverCandidates = New-Object System.Collections.Generic.List[string]

if ('${serverHost}' -match '^\\d{1,3}(\\.\\d{1,3}){3}$') {
  try {
    $resolved = [System.Net.Dns]::GetHostEntry('${serverHost}').HostName
    if ($resolved) {
      $resolvedCandidate = "$resolved${serverSuffix}"
      $serverCandidates.Add($resolvedCandidate)
    }
  } catch {
    # Ignore DNS reverse lookup errors.
  }
}

if (-not $serverCandidates.Contains('${server}')) {
  $serverCandidates.Add('${server}')
}

$lastError = $null
foreach ($candidate in $serverCandidates) {
  $connection = $null
  $connected = $false
  $transaction = $null
  try {
    $builder = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
    $builder['Data Source'] = "tcp:$candidate"
    $builder['Initial Catalog'] = '${database}'
    $builder['TrustServerCertificate'] = $true
    $builder['Encrypt'] = $false
    $builder['Connect Timeout'] = 10
    $builder['Application Name'] = 'Pebloy'

    if ('${authType}' -eq 'Windows') {
      $builder['Integrated Security'] = $true
    } else {
      $builder['User ID'] = '${username}'
      $builder['Password'] = $PebloyPassword
      $builder['Integrated Security'] = $false
    }

    $connection = New-Object System.Data.SqlClient.SqlConnection($builder.ConnectionString)
    $connection.Open()
    $connected = $true
    if (${options.atomic ? "$true" : "$false"}) { $transaction = $connection.BeginTransaction() }

    foreach ($batch in @($batches)) {
      $text = [string]$batch
      if ([string]::IsNullOrWhiteSpace($text)) { continue }
      $command = $connection.CreateCommand()
      if ($null -ne $transaction) { $command.Transaction = $transaction }
      $command.CommandText = $text
      $command.CommandTimeout = ${queryTimeoutSeconds()}
      [void]$command.ExecuteNonQuery()
      $command.Dispose()
    }

    if ($null -ne $transaction) { $transaction.Commit(); $transaction.Dispose(); $transaction = $null }
    Write-Output '{"ok":true}'
    exit 0
  } catch {
    $messages = New-Object System.Collections.Generic.List[string]
    $ex = $_.Exception
    while ($null -ne $ex) {
      if (![string]::IsNullOrWhiteSpace($ex.Message)) {
        $messages.Add($ex.Message)
      }
      $ex = $ex.InnerException
    }
    $lastError = "Server '$candidate' failed: $($messages -join ' | ')"
    if ($connected) { throw $lastError }
  } finally {
    if ($null -ne $transaction) { try { $transaction.Rollback() } catch {}; $transaction.Dispose() }
    if ($null -ne $connection) {
      $connection.Close()
      $connection.Dispose()
    }
  }
}

if ($lastError) {
  throw $lastError
}

throw 'SQL script failed for unknown reason.'
`;

  try {
    const output = await runPowerShell(psScript, 1024 * 1024 * 20, profile.password);
    let result;
    try { result = JSON.parse(output); } catch { result = null; }
    if (!result || result.ok !== true) {
      throw new Error("SQL execution did not return a valid success acknowledgement. Database outcome is uncertain; inspect the target before retrying.");
    }
  } catch (error) {
    const text = error.cleanedMessage || cleanPowerShellError(error.message);

    if (/timeout/i.test(text)) {
      throw new Error(
        `SQL execution timed out for ${profile.serverName}/${profile.databaseName}. Database outcome is uncertain; inspect the target and logs before retrying.`
      );
    }

    if (/login failed/i.test(text)) {
      throw new Error(
        "Login failed. Verify server/database, authentication type, username, and password. If password was recently changed, edit and save the profile again."
      );
    }

    throw new Error(text || "SQL script failed.");
  }
}

async function executeSqlScriptsIndividually(profile, scripts, options = {}) {
  const authType = normalizeAuthenticationType(profile.authenticationType);
  if (authType !== "Windows" && authType !== "Sql") {
    throw new Error("Unsupported authentication type.");
  }

  const entries = (scripts || []).map((entry, index) => ({
    key: String(entry.key || index),
    batches: splitSqlBatches(entry.sqlText),
  }));
  if (!entries.length) {
    return [];
  }
  if (new Set(entries.map((entry) => entry.key)).size !== entries.length) {
    throw new Error("Execution entries must have unique object keys.");
  }

  const { host, suffix } = splitSqlServerName(profile.serverName);
  const server = escapeSingleQuotes(profile.serverName);
  const serverHost = escapeSingleQuotes(host);
  const serverSuffix = escapeSingleQuotes(suffix);
  const database = escapeSingleQuotes(profile.databaseName);
  const username = escapeSingleQuotes(profile.username);
  const payloadBase64 = Buffer.from(
    JSON.stringify({ entries, continueOnError: Boolean(options.continueOnError) }),
    "utf8"
  ).toString("base64");
  const batchCount = entries.reduce((count, entry) => count + entry.batches.length, 0);
  const { queryMs, shellMs } = executionTimeouts();
  const sessionTimeoutMs = Math.min(30 * 60 * 1000, shellMs + (batchCount * queryMs));

  const psScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Data
$payload = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${payloadBase64}')) | ConvertFrom-Json
$serverCandidates = New-Object System.Collections.Generic.List[string]

function Get-TransactionCount($connection) {
  $command = $connection.CreateCommand()
  try {
    $command.CommandText = 'SELECT @@TRANCOUNT;'
    $command.CommandTimeout = ${queryTimeoutSeconds()}
    return [int]$command.ExecuteScalar()
  } finally {
    $command.Dispose()
  }
}

function Reset-SessionTransaction($connection) {
  $command = $connection.CreateCommand()
  try {
    $command.CommandText = 'IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION; SELECT @@TRANCOUNT;'
    $command.CommandTimeout = ${queryTimeoutSeconds()}
    return [int]$command.ExecuteScalar()
  } finally {
    $command.Dispose()
  }
}

if ('${serverHost}' -match '^\\d{1,3}(\\.\\d{1,3}){3}$') {
  try {
    $resolved = [System.Net.Dns]::GetHostEntry('${serverHost}').HostName
    if ($resolved) {
      $serverCandidates.Add("$resolved${serverSuffix}")
    }
  } catch {
    # Ignore DNS reverse lookup errors.
  }
}

if (-not $serverCandidates.Contains('${server}')) {
  $serverCandidates.Add('${server}')
}

$lastError = $null
foreach ($candidate in $serverCandidates) {
  $connection = $null
  $connected = $false
  try {
    $builder = New-Object System.Data.SqlClient.SqlConnectionStringBuilder
    $builder['Data Source'] = "tcp:$candidate"
    $builder['Initial Catalog'] = '${database}'
    $builder['TrustServerCertificate'] = $true
    $builder['Encrypt'] = $false
    $builder['Connect Timeout'] = 10
    $builder['Application Name'] = 'Pebloy'

    if ('${authType}' -eq 'Windows') {
      $builder['Integrated Security'] = $true
    } else {
      $builder['User ID'] = '${username}'
      $builder['Password'] = $PebloyPassword
      $builder['Integrated Security'] = $false
    }

    $connection = New-Object System.Data.SqlClient.SqlConnection($builder.ConnectionString)
    $connection.Open()
    $connected = $true
    foreach ($entry in @($payload.entries)) {
      $entryError = $null
      $startTranCount = 0
      try {
        $startTranCount = Get-TransactionCount $connection
      } catch {
        $entryError = "Failed to inspect shared SQL session state before '$($entry.key)': $($_.Exception.Message)"
      }

      if (-not $entryError -and $startTranCount -ne 0) {
        try {
          $remainingTranCount = Reset-SessionTransaction $connection
          $entryError = "Shared SQL session was not clean before '$($entry.key)'. Rolled back open transactions and reset session state to @@TRANCOUNT=$remainingTranCount."
        } catch {
          $entryError = "Shared SQL session was not clean before '$($entry.key)', and cleanup failed: $($_.Exception.Message)"
        }
      }

      if (-not $entryError) {
        try {
          $beginCommand = $connection.CreateCommand()
          try { $beginCommand.CommandText = 'BEGIN TRANSACTION;'; [void]$beginCommand.ExecuteNonQuery() }
          finally { $beginCommand.Dispose() }
          foreach ($batch in @($entry.batches)) {
            $text = [string]$batch
            if ([string]::IsNullOrWhiteSpace($text)) { continue }
            $command = $connection.CreateCommand()
            try {
              $command.CommandText = $text
              $command.CommandTimeout = ${queryTimeoutSeconds()}
              [void]$command.ExecuteNonQuery()
            } finally {
              $command.Dispose()
            }
          }
        } catch {
          $messages = New-Object System.Collections.Generic.List[string]
          $ex = $_.Exception
          while ($null -ne $ex) {
            if (![string]::IsNullOrWhiteSpace($ex.Message)) {
              $messages.Add($ex.Message)
            }
            $ex = $ex.InnerException
          }
          $entryError = $messages -join ' | '
        }
      }

      if (-not $entryError) {
        try {
          $endTranCount = Get-TransactionCount $connection
          if ($endTranCount -ne ($startTranCount + 1)) {
            $remainingTranCount = Reset-SessionTransaction $connection
            $entryError = "Script left the shared SQL session with @@TRANCOUNT=$endTranCount after '$($entry.key)'. Rolled back leaked transactions and reset session state to @@TRANCOUNT=$remainingTranCount."
          } else {
            $commitCommand = $connection.CreateCommand()
            try { $commitCommand.CommandText = 'COMMIT TRANSACTION;'; [void]$commitCommand.ExecuteNonQuery() }
            finally { $commitCommand.Dispose() }
          }
        } catch {
          $entryError = "Failed to validate shared SQL session state after '$($entry.key)': $($_.Exception.Message)"
        }
      }

      if ($entryError) {
        try {
          [void](Reset-SessionTransaction $connection)
        } catch {
          $entryError = "$entryError | Transaction cleanup failed: $($_.Exception.Message)"
        }
      }

      if ($entryError) {
        [pscustomobject]@{ key = [string]$entry.key; ok = $false; error = $entryError } | ConvertTo-Json -Compress
        if (-not [bool]$payload.continueOnError) {
          break
        }
      } else {
        [pscustomobject]@{ key = [string]$entry.key; ok = $true; error = $null } | ConvertTo-Json -Compress
      }
    }

    exit 0
  } catch {
    $messages = New-Object System.Collections.Generic.List[string]
    $ex = $_.Exception
    while ($null -ne $ex) {
      if (![string]::IsNullOrWhiteSpace($ex.Message)) {
        $messages.Add($ex.Message)
      }
      $ex = $ex.InnerException
    }
    $lastError = "Server '$candidate' failed: $($messages -join ' | ')"
    if ($connected) { throw $lastError }
  } finally {
    if ($null -ne $connection) {
      $connection.Close()
      $connection.Dispose()
    }
  }
}

if ($lastError) {
  throw $lastError
}

throw 'SQL script execution failed for unknown reason.'
  `;

  try {
    const results = [];
    await runPowerShellLines(psScript, (line) => {
      let result;
      try {
        result = JSON.parse(line);
        const expected = entries[results.length];
        if (!result || !expected || result.key !== expected.key || typeof result.ok !== "boolean" ||
            (result.ok ? result.error != null : typeof result.error !== "string" || !result.error.trim()) ||
            (!options.continueOnError && results.at(-1)?.ok === false)) {
          throw new Error("Unexpected execution result");
        }
      } catch (_error) {
        throw new Error(
          "Invalid PowerShell execution output. Deployment status is uncertain; check the target database before retrying."
        );
      }
      results.push(result);
      if (typeof options.onResult === "function") {
        options.onResult(result);
      }
    }, 1024 * 1024 * 20, sessionTimeoutMs, profile.password);
    if (results.length !== entries.length && (options.continueOnError || results.at(-1)?.ok !== false)) {
      throw new Error("Incomplete PowerShell execution output. Deployment status is uncertain; check the target database before retrying.");
    }
    return results;
  } catch (error) {
    const text = error.cleanedMessage || cleanPowerShellError(error.message);
    if (/timeout/i.test(text)) {
      throw new Error(
        `SQL execution timed out for ${profile.serverName}/${profile.databaseName}. Deployment status is uncertain; inspect the target before retrying.`
      );
    }
    if (/login failed/i.test(text)) {
      throw new Error(
        "Login failed. Verify server/database, authentication type, username, and password. If password was recently changed, edit and save the profile again."
      );
    }
    throw new Error(text || "SQL script execution failed.");
  }
}

async function getTableCreateScript(profile, schemaName, tableName) {
  const query = `
DECLARE @schemaName sysname = @schema;
DECLARE @tableName sysname = @table;
DECLARE @objId int = OBJECT_ID(QUOTENAME(@schemaName) + '.' + QUOTENAME(@tableName), 'U');

IF @objId IS NULL
BEGIN
  SELECT CAST(NULL AS nvarchar(max)) AS script;
  RETURN;
END;

WITH cols AS (
  SELECT
    c.column_id,
    c.name AS col_name,
    ty.name AS type_name,
    c.max_length,
    c.precision,
    c.scale,
    c.is_nullable,
    c.is_identity
  FROM sys.columns c
  INNER JOIN sys.types ty ON ty.user_type_id = c.user_type_id
  WHERE c.object_id = @objId
)
SELECT
  'CREATE TABLE ' + QUOTENAME(@schemaName) + '.' + QUOTENAME(@tableName) + CHAR(13) + CHAR(10) +
  '(' + CHAR(13) + CHAR(10) +
  STUFF((
    SELECT ',' + CHAR(13) + CHAR(10) +
    '  ' + QUOTENAME(col_name) + ' ' +
    CASE
      WHEN type_name IN ('varchar','char','varbinary','binary')
        THEN type_name + '(' + CASE WHEN max_length = -1 THEN 'MAX' ELSE CAST(max_length AS varchar(10)) END + ')'
      WHEN type_name IN ('nvarchar','nchar')
        THEN type_name + '(' + CASE WHEN max_length = -1 THEN 'MAX' ELSE CAST(max_length / 2 AS varchar(10)) END + ')'
      WHEN type_name IN ('decimal','numeric')
        THEN type_name + '(' + CAST(precision AS varchar(10)) + ',' + CAST(scale AS varchar(10)) + ')'
      WHEN type_name IN ('datetime2','datetimeoffset','time')
        THEN type_name + '(' + CAST(scale AS varchar(10)) + ')'
      ELSE type_name
    END +
    CASE WHEN is_identity = 1 THEN ' IDENTITY(1,1)' ELSE '' END +
    CASE WHEN is_nullable = 1 THEN ' NULL' ELSE ' NOT NULL' END
    FROM cols
    ORDER BY column_id
    FOR XML PATH(''), TYPE
  ).value('.', 'nvarchar(max)'), 1, 3, '') +
  CHAR(13) + CHAR(10) + ');' AS script
`;

  const authType = normalizeAuthenticationType(profile.authenticationType);
  if (authType === "Windows" || authType === "Sql") {
    const wrapped = `
DECLARE @schema nvarchar(256) = ${escapeSqlLiteral(schemaName)};
DECLARE @table nvarchar(256) = ${escapeSqlLiteral(tableName)};
${query}
`;
    const rows = await runSmoQuery(profile, wrapped);
    return rows[0]?.script || null;
  }

  throw new Error("Unsupported authentication type.");
}

function buildResolveObjectTypesQuery(objects = []) {
  if (!objects.length) return "";

  const inputInserts = buildValuesInserts("#PebloyResolveInputs", ["inputRow", "schemaName", "objectName"],
    objects.map((o, index) => `(${index + 1}, ${escapeSqlLiteral(String(o.schemaName || ""))}, ${escapeSqlLiteral(String(o.objectName || ""))})`));
  const hasUnqualified = objects.some((o) => !String(o.schemaName || "").trim());

  return `
SET NOCOUNT ON;

IF OBJECT_ID('tempdb..#PebloyResolveInputs') IS NOT NULL DROP TABLE #PebloyResolveInputs;
IF OBJECT_ID('tempdb..#PebloyResolveMatches') IS NOT NULL DROP TABLE #PebloyResolveMatches;

CREATE TABLE #PebloyResolveInputs (inputRow int NOT NULL, schemaName nvarchar(128) NULL, objectName nvarchar(128) NOT NULL);
${inputInserts}

CREATE TABLE #PebloyResolveMatches (
  inputRow int NOT NULL,
  dbSchema nvarchar(128) NOT NULL,
  dbObject nvarchar(128) NOT NULL,
  objectType nvarchar(30) NOT NULL,
  createdDate datetime NULL,
  modifiedDate datetime NULL
);

-- Schema-qualified input resolves by id, so the full object catalog is never built.
INSERT INTO #PebloyResolveMatches (inputRow, dbSchema, dbObject, objectType, createdDate, modifiedDate)
SELECT io.inputRow, s.name, o.name,
  CASE o.type WHEN 'U' THEN N'TABLE'
              WHEN 'V' THEN N'VIEW'
              WHEN 'P' THEN N'PROCEDURE'
              WHEN 'FN' THEN N'FUNCTION'
              WHEN 'TF' THEN N'FUNCTION'
              WHEN 'IF' THEN N'FUNCTION'
              WHEN 'TR' THEN N'TRIGGER'
              WHEN 'SN' THEN N'SYNONYM'
              WHEN 'SO' THEN N'SEQUENCE' END,
  o.create_date, o.modify_date
FROM #PebloyResolveInputs io
CROSS APPLY (SELECT OBJECT_ID(QUOTENAME(io.schemaName) + N'.' + QUOTENAME(io.objectName)) AS resolvedId) resolved
INNER JOIN sys.objects o
  ON o.object_id = resolved.resolvedId
 AND o.type IN ('U','V','P','FN','TF','IF','TR','SN','SO')
INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE NULLIF(LTRIM(RTRIM(io.schemaName)), '') IS NOT NULL;

INSERT INTO #PebloyResolveMatches (inputRow, dbSchema, dbObject, objectType, createdDate, modifiedDate)
SELECT io.inputRow, s.name, ty.name, N'USER_DEFINED_TYPE', NULL, NULL
FROM #PebloyResolveInputs io
CROSS APPLY (SELECT TYPE_ID(QUOTENAME(io.schemaName) + N'.' + QUOTENAME(io.objectName)) AS resolvedId) resolved
INNER JOIN sys.types ty
  ON ty.user_type_id = resolved.resolvedId
 AND ty.is_user_defined = 1
INNER JOIN sys.schemas s ON s.schema_id = ty.schema_id
WHERE NULLIF(LTRIM(RTRIM(io.schemaName)), '') IS NOT NULL;
${hasUnqualified ? `
-- Only input without a schema needs the whole catalog searched by name.
WITH ObjectCatalog AS (
  SELECT N'TABLE' AS objectType, s.name AS schemaName, t.name AS objectName, t.create_date AS createdDate, t.modify_date AS modifiedDate
  FROM sys.tables t
  INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
  UNION ALL
  SELECT CASE o.type WHEN 'V' THEN N'VIEW'
                     WHEN 'P' THEN N'PROCEDURE'
                     WHEN 'FN' THEN N'FUNCTION'
                     WHEN 'TF' THEN N'FUNCTION'
                     WHEN 'IF' THEN N'FUNCTION'
                     WHEN 'TR' THEN N'TRIGGER' END,
         s.name,
         o.name,
         o.create_date,
         o.modify_date
  FROM sys.objects o
  INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
  WHERE o.type IN ('V','P','FN','TF','IF','TR')
  UNION ALL
  SELECT N'SYNONYM', s.name, sn.name, sn.create_date, sn.modify_date
  FROM sys.synonyms sn
  INNER JOIN sys.schemas s ON s.schema_id = sn.schema_id
  UNION ALL
  SELECT N'SEQUENCE', s.name, sq.name, sq.create_date, sq.modify_date
  FROM sys.sequences sq
  INNER JOIN sys.schemas s ON s.schema_id = sq.schema_id
  UNION ALL
  SELECT N'USER_DEFINED_TYPE', s.name, ty.name, NULL, NULL
  FROM sys.types ty
  INNER JOIN sys.schemas s ON s.schema_id = ty.schema_id
  WHERE ty.is_user_defined = 1
)
INSERT INTO #PebloyResolveMatches (inputRow, dbSchema, dbObject, objectType, createdDate, modifiedDate)
SELECT io.inputRow, oc.schemaName, oc.objectName, oc.objectType, oc.createdDate, oc.modifiedDate
FROM #PebloyResolveInputs io
INNER JOIN ObjectCatalog oc
  ON LOWER(oc.objectName) = LOWER(io.objectName)
WHERE NULLIF(LTRIM(RTRIM(io.schemaName)), '') IS NULL;
` : ""}
SELECT
  io.schemaName                        AS inputSchemaName,
  io.objectName                        AS inputObjectName,
  CASE WHEN COALESCE(ms.matchCount, 0) = 1 THEN rm.dbSchema ELSE io.schemaName END AS schemaName,
  CASE WHEN COALESCE(ms.matchCount, 0) = 1 THEN rm.dbObject ELSE io.objectName END AS objectName,
  CASE WHEN COALESCE(ms.matchCount, 0) = 1 THEN rm.objectType END                  AS objectType,
  CASE WHEN COALESCE(ms.matchCount, 0) = 1 THEN rm.createdDate END                 AS createdDate,
  CASE WHEN COALESCE(ms.matchCount, 0) = 1 THEN rm.modifiedDate END                AS modifiedDate,
  CASE
    WHEN COALESCE(ms.matchCount, 0) = 0 THEN N'NotFound'
    WHEN ms.matchCount = 1 THEN N'Resolved'
    ELSE N'Ambiguous'
  END AS matchStatus
FROM #PebloyResolveInputs io
LEFT JOIN (
  SELECT inputRow, COUNT(*) AS matchCount
  FROM #PebloyResolveMatches
  GROUP BY inputRow
) ms ON ms.inputRow = io.inputRow
LEFT JOIN (
  SELECT m.inputRow, m.dbSchema, m.dbObject, m.objectType, m.createdDate, m.modifiedDate,
         ROW_NUMBER() OVER (
           PARTITION BY m.inputRow
           ORDER BY CASE WHEN LOWER(m.dbSchema) = LOWER(i.schemaName) THEN 0 ELSE 1 END, m.dbSchema, m.dbObject, m.objectType
         ) AS matchRank
  FROM #PebloyResolveMatches m
  INNER JOIN #PebloyResolveInputs i ON i.inputRow = m.inputRow
) rm ON rm.inputRow = io.inputRow AND rm.matchRank = 1
ORDER BY io.inputRow;

DROP TABLE #PebloyResolveMatches;
DROP TABLE #PebloyResolveInputs;
`;
}

async function resolveObjectTypes(profile, objects = []) {
  const query = buildResolveObjectTypesQuery(objects);
  if (!query) return [];

  const authType = normalizeAuthenticationType(profile.authenticationType);
  if (authType !== "Windows" && authType !== "Sql") {
    throw new Error("Unsupported authentication type.");
  }

  return await runSmoQuery(profile, query);
}

function normalizeSqlDateWindow(dateWindow) {
  if (!dateWindow || typeof dateWindow !== "object") return null;
  const start = new Date(dateWindow.start);
  const end = new Date(dateWindow.end);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
  return { start: start.toISOString(), end: end.toISOString() };
}

// SQL Server caps a VALUES row constructor at 1000 rows per INSERT.
function buildValuesInserts(tableName, columns, valueRows) {
  const inserts = [];
  for (let index = 0; index < valueRows.length; index += 1000) {
    inserts.push(`INSERT INTO ${tableName} (${columns.join(", ")}) VALUES\n  ${valueRows.slice(index, index + 1000).join(",\n  ")};`);
  }
  return inserts.join("\n");
}

function buildObjectDependenciesQuery(objects = [], options = {}) {
  const candidates = (Array.isArray(objects) ? objects : [])
    .map((item) => ({
      schemaName: String(item.schemaName || "").trim(),
      objectName: String(item.objectName || "").trim(),
    }))
    .filter((item) => item.objectName);

  if (!candidates.length) return "";

  const inputInserts = buildValuesInserts("#PebloyInputs", ["schemaName", "objectName"],
    candidates.map((item) => `(${escapeSqlLiteral(item.schemaName)}, ${escapeSqlLiteral(item.objectName)})`));
  const hasUnqualified = candidates.some((item) => !item.schemaName);

  const dateWindow = normalizeSqlDateWindow(options.dateWindow);
  const sqlDateWindow = dateWindow
    ? { start: dateWindow.start.replace(/Z$/i, ""), end: dateWindow.end.replace(/Z$/i, "") }
    : null;
  const dependencyDateFilter = sqlDateWindow
    ? `\n    AND dep.modifiedDate IS NOT NULL\n    AND dep.modifiedDate >= CONVERT(datetime2, ${escapeSqlLiteral(sqlDateWindow.start)}, 126)\n    AND dep.modifiedDate <= CONVERT(datetime2, ${escapeSqlLiteral(sqlDateWindow.end)}, 126)`
    : "";

  return `
SET NOCOUNT ON;

IF OBJECT_ID('tempdb..#PebloyInputs') IS NOT NULL DROP TABLE #PebloyInputs;
IF OBJECT_ID('tempdb..#PebloyRoots') IS NOT NULL DROP TABLE #PebloyRoots;
IF OBJECT_ID('tempdb..#PebloyEdges') IS NOT NULL DROP TABLE #PebloyEdges;

CREATE TABLE #PebloyInputs (schemaName nvarchar(128) NULL, objectName nvarchar(128) NOT NULL);
${inputInserts}

CREATE TABLE #PebloyRoots (
  objectType nvarchar(30) NOT NULL,
  schemaName nvarchar(128) NOT NULL,
  objectName nvarchar(128) NOT NULL,
  catalogKey nvarchar(40) NOT NULL,
  objectId int NULL,
  typeId int NULL
);

-- Schema-qualified input resolves by id, so SQL Server seeks the catalog instead
-- of scanning every row in sys.objects once per reference.
INSERT INTO #PebloyRoots (objectType, schemaName, objectName, catalogKey, objectId, typeId)
SELECT DISTINCT
  CASE o.type WHEN 'U' THEN N'TABLE'
              WHEN 'V' THEN N'VIEW'
              WHEN 'P' THEN N'PROCEDURE'
              WHEN 'FN' THEN N'FUNCTION'
              WHEN 'TF' THEN N'FUNCTION'
              WHEN 'IF' THEN N'FUNCTION'
              WHEN 'TR' THEN N'TRIGGER'
              WHEN 'SN' THEN N'SYNONYM'
              WHEN 'SO' THEN N'SEQUENCE' END,
  s.name, o.name, N'OBJECT:' + CONVERT(nvarchar(30), o.object_id), o.object_id, NULL
FROM #PebloyInputs io
CROSS APPLY (SELECT OBJECT_ID(QUOTENAME(io.schemaName) + N'.' + QUOTENAME(io.objectName)) AS resolvedId) resolved
INNER JOIN sys.objects o
  ON o.object_id = resolved.resolvedId
 AND o.type IN ('U','V','P','FN','TF','IF','TR','SN','SO')
INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE NULLIF(LTRIM(RTRIM(io.schemaName)), N'') IS NOT NULL;

INSERT INTO #PebloyRoots (objectType, schemaName, objectName, catalogKey, objectId, typeId)
SELECT DISTINCT
  N'USER_DEFINED_TYPE', s.name, ty.name,
  N'TYPE:' + CONVERT(nvarchar(30), ty.user_type_id), NULL, ty.user_type_id
FROM #PebloyInputs io
CROSS APPLY (SELECT TYPE_ID(QUOTENAME(io.schemaName) + N'.' + QUOTENAME(io.objectName)) AS resolvedId) resolved
INNER JOIN sys.types ty
  ON ty.user_type_id = resolved.resolvedId
 AND ty.is_user_defined = 1
INNER JOIN sys.schemas s ON s.schema_id = ty.schema_id
WHERE NULLIF(LTRIM(RTRIM(io.schemaName)), N'') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM #PebloyRoots existing
                  WHERE existing.catalogKey = N'TYPE:' + CONVERT(nvarchar(30), ty.user_type_id));
${hasUnqualified ? `
-- Unqualified input has no schema to resolve against, so it still matches by name.
INSERT INTO #PebloyRoots (objectType, schemaName, objectName, catalogKey, objectId, typeId)
SELECT DISTINCT
  CASE o.type WHEN 'U' THEN N'TABLE'
              WHEN 'V' THEN N'VIEW'
              WHEN 'P' THEN N'PROCEDURE'
              WHEN 'FN' THEN N'FUNCTION'
              WHEN 'TF' THEN N'FUNCTION'
              WHEN 'IF' THEN N'FUNCTION'
              WHEN 'TR' THEN N'TRIGGER'
              WHEN 'SN' THEN N'SYNONYM'
              WHEN 'SO' THEN N'SEQUENCE' END,
  s.name, o.name, N'OBJECT:' + CONVERT(nvarchar(30), o.object_id), o.object_id, NULL
FROM #PebloyInputs io
INNER JOIN sys.objects o
  ON LOWER(o.name) = LOWER(io.objectName)
 AND o.type IN ('U','V','P','FN','TF','IF','TR','SN','SO')
INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE NULLIF(LTRIM(RTRIM(io.schemaName)), N'') IS NULL
  AND NOT EXISTS (SELECT 1 FROM #PebloyRoots existing
                  WHERE existing.catalogKey = N'OBJECT:' + CONVERT(nvarchar(30), o.object_id));

INSERT INTO #PebloyRoots (objectType, schemaName, objectName, catalogKey, objectId, typeId)
SELECT DISTINCT
  N'USER_DEFINED_TYPE', s.name, ty.name,
  N'TYPE:' + CONVERT(nvarchar(30), ty.user_type_id), NULL, ty.user_type_id
FROM #PebloyInputs io
INNER JOIN sys.types ty
  ON LOWER(ty.name) = LOWER(io.objectName)
 AND ty.is_user_defined = 1
INNER JOIN sys.schemas s ON s.schema_id = ty.schema_id
WHERE NULLIF(LTRIM(RTRIM(io.schemaName)), N'') IS NULL
  AND NOT EXISTS (SELECT 1 FROM #PebloyRoots existing
                  WHERE existing.catalogKey = N'TYPE:' + CONVERT(nvarchar(30), ty.user_type_id));
` : ""}
CREATE CLUSTERED INDEX IX_PebloyRoots ON #PebloyRoots (catalogKey);

CREATE TABLE #PebloyEdges (
  sourceKey nvarchar(40) NOT NULL,
  dependencyClass nvarchar(10) NOT NULL,
  dependencyObjectId int NULL,
  dependencyTypeId int NULL,
  dependencyKey nvarchar(40) NOT NULL
);

INSERT INTO #PebloyEdges (sourceKey, dependencyClass, dependencyObjectId, dependencyTypeId, dependencyKey)
  SELECT
    root.catalogKey AS sourceKey,
    CASE WHEN sed.referenced_class = 6 THEN N'TYPE' ELSE N'OBJECT' END AS dependencyClass,
    CASE WHEN sed.referenced_class = 6 THEN NULL ELSE sed.referenced_id END AS dependencyObjectId,
    CASE WHEN sed.referenced_class = 6 THEN sed.referenced_id ELSE NULL END AS dependencyTypeId,
    CASE WHEN sed.referenced_class = 6
         THEN N'TYPE:' + CONVERT(nvarchar(30), sed.referenced_id)
         ELSE N'OBJECT:' + CONVERT(nvarchar(30), sed.referenced_id)
    END AS dependencyKey
  FROM #PebloyRoots root
  INNER JOIN sys.sql_expression_dependencies sed ON sed.referencing_id = root.objectId
  WHERE root.objectId IS NOT NULL
    AND sed.referenced_id IS NOT NULL
    AND sed.referenced_class IN (1, 6)
  UNION
  SELECT root.catalogKey, N'OBJECT', fk.referenced_object_id, NULL, N'OBJECT:' + CONVERT(nvarchar(30), fk.referenced_object_id)
  FROM #PebloyRoots root
  INNER JOIN sys.foreign_keys fk ON fk.parent_object_id = root.objectId
  WHERE root.objectId IS NOT NULL
  UNION
  SELECT root.catalogKey, N'TYPE', NULL, c.user_type_id, N'TYPE:' + CONVERT(nvarchar(30), c.user_type_id)
  FROM #PebloyRoots root
  INNER JOIN sys.columns c ON c.object_id = root.objectId
  INNER JOIN sys.types ty ON ty.user_type_id = c.user_type_id
  WHERE root.objectId IS NOT NULL
    AND ty.is_user_defined = 1
  UNION
  SELECT root.catalogKey, N'OBJECT', OBJECT_ID(sn.base_object_name), NULL, N'OBJECT:' + CONVERT(nvarchar(30), OBJECT_ID(sn.base_object_name))
  FROM #PebloyRoots root
  INNER JOIN sys.synonyms sn ON sn.object_id = root.objectId
  WHERE root.objectId IS NOT NULL
    AND OBJECT_ID(sn.base_object_name) IS NOT NULL;

CREATE CLUSTERED INDEX IX_PebloyEdges ON #PebloyEdges (sourceKey, dependencyKey);

WITH DependencyObjects AS (
  SELECT DISTINCT
    CASE o.type WHEN 'U' THEN N'TABLE'
                WHEN 'V' THEN N'VIEW'
                WHEN 'P' THEN N'PROCEDURE'
                WHEN 'FN' THEN N'FUNCTION'
                WHEN 'TF' THEN N'FUNCTION'
                WHEN 'IF' THEN N'FUNCTION'
                WHEN 'TR' THEN N'TRIGGER'
                WHEN 'SN' THEN N'SYNONYM'
                WHEN 'SO' THEN N'SEQUENCE' END AS objectType,
    s.name AS schemaName,
    o.name AS objectName,
    N'OBJECT:' + CONVERT(nvarchar(30), o.object_id) AS catalogKey,
    o.create_date AS createdDate,
    o.modify_date AS modifiedDate
  FROM (SELECT DISTINCT dependencyObjectId FROM #PebloyEdges WHERE dependencyObjectId IS NOT NULL) target
  INNER JOIN sys.objects o
    ON o.object_id = target.dependencyObjectId
   AND o.type IN ('U','V','P','FN','TF','IF','TR','SN','SO')
  INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
  UNION ALL
  SELECT DISTINCT
    N'USER_DEFINED_TYPE',
    s.name,
    ty.name,
    N'TYPE:' + CONVERT(nvarchar(30), ty.user_type_id),
    NULL,
    NULL
  FROM (SELECT DISTINCT dependencyTypeId FROM #PebloyEdges WHERE dependencyTypeId IS NOT NULL) target
  INNER JOIN sys.types ty
    ON ty.user_type_id = target.dependencyTypeId
   AND ty.is_user_defined = 1
  INNER JOIN sys.schemas s ON s.schema_id = ty.schema_id
)
SELECT objectType, schemaName, objectName, createdDate, modifiedDate, parentObjectType, parentSchemaName, parentObjectName
FROM (
  SELECT DISTINCT
    dep.objectType,
    dep.schemaName,
    dep.objectName,
    dep.createdDate,
    dep.modifiedDate,
    root.objectType AS parentObjectType,
    root.schemaName AS parentSchemaName,
    root.objectName AS parentObjectName,
    CASE dep.objectType
      WHEN 'USER_DEFINED_TYPE' THEN 1
      WHEN 'SEQUENCE' THEN 2
      WHEN 'TABLE' THEN 3
      WHEN 'VIEW' THEN 4
      WHEN 'FUNCTION' THEN 5
      WHEN 'PROCEDURE' THEN 6
      WHEN 'SYNONYM' THEN 7
      WHEN 'TRIGGER' THEN 8
      ELSE 9
    END AS sortOrder
  FROM #PebloyRoots root
  INNER JOIN #PebloyEdges edge ON edge.sourceKey = root.catalogKey
  INNER JOIN DependencyObjects dep ON dep.catalogKey = edge.dependencyKey
  WHERE NOT EXISTS (
    SELECT 1
    FROM #PebloyRoots existingRoot
    WHERE existingRoot.catalogKey = dep.catalogKey
  )${dependencyDateFilter}
) DependencyResults
ORDER BY sortOrder, schemaName, objectName;

DROP TABLE #PebloyEdges;
DROP TABLE #PebloyRoots;
DROP TABLE #PebloyInputs;
`;
}

async function fetchObjectDependencies(profile, objects = [], options = {}) {
  const query = buildObjectDependenciesQuery(objects, options);
  if (!query) return [];

  const authType = normalizeAuthenticationType(profile.authenticationType);
  if (authType !== "Windows" && authType !== "Sql") {
    throw new Error("Unsupported authentication type.");
  }

  return await runSmoQuery(profile, query);
}

async function fetchObjectDependencyEdges(profile, objects = []) {
  const candidates = (Array.isArray(objects) ? objects : [])
    .map((item) => ({
      schemaName: String(item.schemaName || "").trim(),
      objectName: String(item.objectName || "").trim(),
    }))
    .filter((item) => item.objectName);

  if (!candidates.length) return [];

  const inputInserts = buildValuesInserts("#PebloySelectedInputs", ["schemaName", "objectName"],
    candidates.map((item) => `(${escapeSqlLiteral(item.schemaName)}, ${escapeSqlLiteral(item.objectName)})`));
  const hasUnqualified = candidates.some((item) => !item.schemaName);

  const query = `
SET NOCOUNT ON;
IF ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'VIEW DEFINITION'), 0) <> 1
  THROW 51000, 'Deployment planning requires VIEW DEFINITION on the source database.', 1;

IF OBJECT_ID('tempdb..#PebloySelectedInputs') IS NOT NULL DROP TABLE #PebloySelectedInputs;
IF OBJECT_ID('tempdb..#PebloySelected') IS NOT NULL DROP TABLE #PebloySelected;

CREATE TABLE #PebloySelectedInputs (schemaName nvarchar(128) NULL, objectName nvarchar(128) NOT NULL);
${inputInserts}

CREATE TABLE #PebloySelected (
  catalogKey nvarchar(40) NOT NULL,
  objectType nvarchar(30) NOT NULL,
  schemaName nvarchar(128) NOT NULL,
  objectName nvarchar(128) NOT NULL,
  objectId int NULL
);

-- Schema-qualified input resolves by id, so the full object catalog is never built.
INSERT INTO #PebloySelected (catalogKey, objectType, schemaName, objectName, objectId)
SELECT DISTINCT
  N'OBJECT:' + CONVERT(nvarchar(30), o.object_id),
  CASE o.type WHEN 'U' THEN N'TABLE'
              WHEN 'V' THEN N'VIEW'
              WHEN 'P' THEN N'PROCEDURE'
              WHEN 'FN' THEN N'FUNCTION'
              WHEN 'TF' THEN N'FUNCTION'
              WHEN 'IF' THEN N'FUNCTION'
              WHEN 'TR' THEN N'TRIGGER'
              WHEN 'SN' THEN N'SYNONYM'
              WHEN 'SO' THEN N'SEQUENCE' END,
  s.name, o.name, o.object_id
FROM #PebloySelectedInputs io
CROSS APPLY (SELECT OBJECT_ID(QUOTENAME(io.schemaName) + N'.' + QUOTENAME(io.objectName)) AS resolvedId) resolved
INNER JOIN sys.objects o
  ON o.object_id = resolved.resolvedId
 AND o.type IN ('U','V','P','FN','TF','IF','TR','SN','SO')
INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE NULLIF(LTRIM(RTRIM(io.schemaName)), '') IS NOT NULL;

INSERT INTO #PebloySelected (catalogKey, objectType, schemaName, objectName, objectId)
SELECT DISTINCT
  N'TYPE:' + CONVERT(nvarchar(30), ty.user_type_id), N'USER_DEFINED_TYPE', s.name, ty.name, NULL
FROM #PebloySelectedInputs io
CROSS APPLY (SELECT TYPE_ID(QUOTENAME(io.schemaName) + N'.' + QUOTENAME(io.objectName)) AS resolvedId) resolved
INNER JOIN sys.types ty
  ON ty.user_type_id = resolved.resolvedId
 AND ty.is_user_defined = 1
INNER JOIN sys.schemas s ON s.schema_id = ty.schema_id
WHERE NULLIF(LTRIM(RTRIM(io.schemaName)), '') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM #PebloySelected existing
                  WHERE existing.catalogKey = N'TYPE:' + CONVERT(nvarchar(30), ty.user_type_id));
${hasUnqualified ? `
-- Only input without a schema needs a name search.
INSERT INTO #PebloySelected (catalogKey, objectType, schemaName, objectName, objectId)
SELECT DISTINCT
  N'OBJECT:' + CONVERT(nvarchar(30), o.object_id),
  CASE o.type WHEN 'U' THEN N'TABLE'
              WHEN 'V' THEN N'VIEW'
              WHEN 'P' THEN N'PROCEDURE'
              WHEN 'FN' THEN N'FUNCTION'
              WHEN 'TF' THEN N'FUNCTION'
              WHEN 'IF' THEN N'FUNCTION'
              WHEN 'TR' THEN N'TRIGGER'
              WHEN 'SN' THEN N'SYNONYM'
              WHEN 'SO' THEN N'SEQUENCE' END,
  s.name, o.name, o.object_id
FROM #PebloySelectedInputs io
INNER JOIN sys.objects o
  ON LOWER(o.name) = LOWER(io.objectName)
 AND o.type IN ('U','V','P','FN','TF','IF','TR','SN','SO')
INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE NULLIF(LTRIM(RTRIM(io.schemaName)), '') IS NULL
  AND NOT EXISTS (SELECT 1 FROM #PebloySelected existing
                  WHERE existing.catalogKey = N'OBJECT:' + CONVERT(nvarchar(30), o.object_id));

INSERT INTO #PebloySelected (catalogKey, objectType, schemaName, objectName, objectId)
SELECT DISTINCT
  N'TYPE:' + CONVERT(nvarchar(30), ty.user_type_id), N'USER_DEFINED_TYPE', s.name, ty.name, NULL
FROM #PebloySelectedInputs io
INNER JOIN sys.types ty
  ON LOWER(ty.name) = LOWER(io.objectName)
 AND ty.is_user_defined = 1
INNER JOIN sys.schemas s ON s.schema_id = ty.schema_id
WHERE NULLIF(LTRIM(RTRIM(io.schemaName)), '') IS NULL
  AND NOT EXISTS (SELECT 1 FROM #PebloySelected existing
                  WHERE existing.catalogKey = N'TYPE:' + CONVERT(nvarchar(30), ty.user_type_id));
` : ""}
CREATE CLUSTERED INDEX IX_PebloySelected ON #PebloySelected (catalogKey);
UPDATE selected SET objectId = tableType.type_table_object_id
FROM #PebloySelected selected
INNER JOIN sys.table_types tableType
  ON selected.catalogKey = N'TYPE:' + CONVERT(nvarchar(30), tableType.user_type_id);

-- Edges are restricted to the selected objects, so the database-wide dependency,
-- foreign key, and column lists are never enumerated.
SELECT DISTINCT
  src.objectType AS objectType,
  src.schemaName AS schemaName,
  src.objectName AS objectName,
  dep.objectType AS dependencyObjectType,
  dep.schemaName AS dependencySchemaName,
  dep.objectName AS dependencyObjectName
FROM #PebloySelected src
INNER JOIN (
  SELECT
    s.catalogKey AS sourceKey,
    CASE WHEN sed.referenced_class = 6
         THEN N'TYPE:' + CONVERT(nvarchar(30), sed.referenced_id)
         ELSE N'OBJECT:' + CONVERT(nvarchar(30), sed.referenced_id)
    END AS dependencyKey
  FROM sys.sql_expression_dependencies sed
  INNER JOIN #PebloySelected s ON s.objectId = sed.referencing_id
  WHERE sed.referenced_id IS NOT NULL
    AND sed.referenced_class IN (1, 6)
  UNION
  SELECT N'OBJECT:' + CONVERT(nvarchar(30), fk.parent_object_id), N'OBJECT:' + CONVERT(nvarchar(30), fk.referenced_object_id)
  FROM sys.foreign_keys fk
  INNER JOIN #PebloySelected s ON s.objectId = fk.parent_object_id
  UNION
  SELECT s.catalogKey, N'TYPE:' + CONVERT(nvarchar(30), c.user_type_id)
  FROM sys.columns c
  INNER JOIN #PebloySelected s ON s.objectId = c.object_id
  INNER JOIN sys.types ty ON ty.user_type_id = c.user_type_id
  WHERE ty.is_user_defined = 1
  UNION
  SELECT s.catalogKey, N'TYPE:' + CONVERT(nvarchar(30), parameter.user_type_id)
  FROM #PebloySelected s
  INNER JOIN sys.parameters parameter ON parameter.object_id = s.objectId
  INNER JOIN sys.types ty ON ty.user_type_id = parameter.user_type_id
  WHERE ty.is_user_defined = 1
  UNION
  SELECT s.catalogKey,
    CASE WHEN dependency.referenced_class = 6 THEN N'TYPE:' ELSE N'OBJECT:' END + CONVERT(nvarchar(30), dependency.referenced_id)
  FROM #PebloySelected s
  INNER JOIN sys.objects childObject ON childObject.parent_object_id = s.objectId AND childObject.type IN ('D', 'C')
  INNER JOIN sys.sql_expression_dependencies dependency ON dependency.referencing_id = childObject.object_id
  WHERE dependency.referenced_class IN (1, 6) AND dependency.referenced_id IS NOT NULL
  UNION
  SELECT s.catalogKey, N'OBJECT:' + CONVERT(nvarchar(30), triggerObject.parent_id)
  FROM #PebloySelected s
  INNER JOIN sys.triggers triggerObject ON triggerObject.object_id = s.objectId AND triggerObject.parent_class = 1
  UNION
  SELECT N'OBJECT:' + CONVERT(nvarchar(30), sn.object_id), N'OBJECT:' + CONVERT(nvarchar(30), OBJECT_ID(sn.base_object_name))
  FROM sys.synonyms sn
  INNER JOIN #PebloySelected s ON s.objectId = sn.object_id
  WHERE OBJECT_ID(sn.base_object_name) IS NOT NULL
    AND PARSENAME(sn.base_object_name, 4) IS NULL
    AND (PARSENAME(sn.base_object_name, 3) IS NULL OR PARSENAME(sn.base_object_name, 3) = DB_NAME())
) edge ON edge.sourceKey = src.catalogKey
INNER JOIN #PebloySelected dep ON dep.catalogKey = edge.dependencyKey
WHERE src.catalogKey <> dep.catalogKey
ORDER BY src.schemaName, src.objectName, dep.schemaName, dep.objectName;

DROP TABLE #PebloySelected;
DROP TABLE #PebloySelectedInputs;
`;

  const authType = normalizeAuthenticationType(profile.authenticationType);
  if (authType !== "Windows" && authType !== "Sql") {
    throw new Error("Unsupported authentication type.");
  }

  return await runSmoQuery(profile, query);
}

// Read-only lookup of the metadata that makes DROP/CREATE unsafe, so an operator
// can author a migration that preserves it.
async function fetchObjectProtectionMetadata(profile, selectedObjects = []) {
  const targets = (selectedObjects || [])
    .map((item) => ({
      objectType: String(item.objectType || "").toUpperCase().trim(),
      schemaName: String(item.schemaName || "").trim(),
      objectName: String(item.objectName || "").trim(),
    }))
    .filter((item) => item.schemaName && item.objectName);

  if (!targets.length) throw new Error("No objects supplied for migration metadata lookup.");

  const names = targets
    .map((item) => `(${escapeSqlLiteral(item.schemaName)}, ${escapeSqlLiteral(item.objectName)}, ${escapeSqlLiteral(item.objectType)})`)
    .join(",\n    ");

  const query = `
WITH Targets(schemaName, objectName, objectType) AS (
  SELECT * FROM (VALUES
    ${names}
  ) AS v(schemaName, objectName, objectType)
)
SELECT 'Permission' AS kind, t.schemaName, t.objectName,
       dp.permission_name AS detail1, dp.state_desc AS detail2, USER_NAME(dp.grantee_principal_id) AS detail3
FROM Targets t
JOIN sys.objects o ON o.name = t.objectName AND SCHEMA_NAME(o.schema_id) = t.schemaName
JOIN sys.database_permissions dp ON dp.class = 1 AND dp.major_id = o.object_id
UNION ALL
SELECT 'Owner', t.schemaName, t.objectName, USER_NAME(o.principal_id), NULL, NULL
FROM Targets t
JOIN sys.objects o ON o.name = t.objectName AND SCHEMA_NAME(o.schema_id) = t.schemaName
WHERE o.principal_id IS NOT NULL
UNION ALL
SELECT 'Signature', t.schemaName, t.objectName, cp.thumbprint_hex, cp.crypt_type_desc, NULL
FROM Targets t
JOIN sys.objects o ON o.name = t.objectName AND SCHEMA_NAME(o.schema_id) = t.schemaName
CROSS APPLY (SELECT CONVERT(varchar(128), c.thumbprint, 2) AS thumbprint_hex, c.crypt_type_desc
             FROM sys.crypt_properties c WHERE c.class = 1 AND c.major_id = o.object_id) cp
UNION ALL
SELECT 'SequenceState', t.schemaName, t.objectName,
       CONVERT(varchar(64), s.current_value), CONVERT(varchar(64), s.increment), CONVERT(varchar(64), s.start_value)
FROM Targets t
JOIN sys.sequences s ON s.name = t.objectName AND SCHEMA_NAME(s.schema_id) = t.schemaName
UNION ALL
SELECT 'Dependent', t.schemaName, t.objectName,
       SCHEMA_NAME(ref.schema_id), ref.name, ref.type_desc
FROM Targets t
JOIN sys.objects o ON o.name = t.objectName AND SCHEMA_NAME(o.schema_id) = t.schemaName
JOIN sys.sql_expression_dependencies sed ON sed.referenced_id = o.object_id
JOIN sys.objects ref ON ref.object_id = sed.referencing_id
UNION ALL
SELECT 'TypeDependent', t.schemaName, t.objectName,
       SCHEMA_NAME(ref.schema_id), ref.name, ref.type_desc
FROM Targets t
JOIN sys.types ty ON ty.name = t.objectName AND SCHEMA_NAME(ty.schema_id) = t.schemaName
JOIN sys.sql_expression_dependencies sed ON sed.referenced_class = 6 AND sed.referenced_id = ty.user_type_id
JOIN sys.objects ref ON ref.object_id = sed.referencing_id
ORDER BY schemaName, objectName, kind;
`;

  const authType = normalizeAuthenticationType(profile.authenticationType);
  if (authType !== "Windows" && authType !== "Sql") {
    throw new Error("Unsupported authentication type.");
  }

  return await runSmoQuery(profile, query);
}

// Read-only shape of user-defined types. sys.types holds no definition text, so a
// type is compared through its base type, columns, and constraints instead.
async function fetchTypeSignatureMap(profile, selectedObjects = []) {
  const targets = (selectedObjects || [])
    .filter((item) => String(item.objectType || "").toUpperCase() === "USER_DEFINED_TYPE")
    .map((item) => ({ schemaName: String(item.schemaName || "").trim(), objectName: String(item.objectName || "").trim() }))
    .filter((item) => item.schemaName && item.objectName);

  if (!targets.length) return new Map();

  const values = targets
    .map((item) => `(${escapeSqlLiteral(item.schemaName)}, ${escapeSqlLiteral(item.objectName)})`)
    .join(",\n    ");

  const query = `
IF ISNULL(HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'VIEW DEFINITION'), 0) <> 1
  THROW 51000, 'User-defined type comparison requires VIEW DEFINITION on both databases.', 1;

WITH Targets(schemaName, objectName) AS (
  SELECT * FROM (VALUES
    ${values}
  ) AS v(schemaName, objectName)
)
SELECT N'TYPE' AS part, s.name AS schemaName, ty.name AS objectName, 0 AS ordinal,
  CONVERT(nvarchar(max), CONCAT(ISNULL(bt.name, N'?') COLLATE DATABASE_DEFAULT, N':', ty.max_length, N':', ty.precision, N':', ty.scale,
    N':', ISNULL(ty.collation_name, N'') COLLATE DATABASE_DEFAULT, N':', ty.is_nullable, N':', ty.is_table_type)) COLLATE DATABASE_DEFAULT AS detail
FROM Targets t
INNER JOIN sys.types ty ON ty.name = t.objectName AND SCHEMA_NAME(ty.schema_id) = t.schemaName AND ty.is_user_defined = 1
INNER JOIN sys.schemas s ON s.schema_id = ty.schema_id
LEFT JOIN sys.types bt ON bt.user_type_id = ty.system_type_id AND bt.is_user_defined = 0
UNION ALL
SELECT N'COLUMN', s.name, ty.name, c.column_id,
  CONVERT(nvarchar(max), CONCAT(c.name COLLATE DATABASE_DEFAULT, N':', ISNULL(bt.name, N'?') COLLATE DATABASE_DEFAULT, N':', c.max_length, N':', c.precision, N':', c.scale,
    N':', ISNULL(c.collation_name, N'') COLLATE DATABASE_DEFAULT, N':', c.is_nullable, N':', c.is_identity, N':', ISNULL(cc.definition, N'') COLLATE DATABASE_DEFAULT,
    N':', ISNULL(dc.definition, N'') COLLATE DATABASE_DEFAULT)) COLLATE DATABASE_DEFAULT AS detail
FROM Targets t
INNER JOIN sys.table_types tt ON tt.name = t.objectName AND SCHEMA_NAME(tt.schema_id) = t.schemaName
INNER JOIN sys.types ty ON ty.user_type_id = tt.user_type_id
INNER JOIN sys.schemas s ON s.schema_id = tt.schema_id
INNER JOIN sys.columns c ON c.object_id = tt.type_table_object_id
LEFT JOIN sys.types bt ON bt.user_type_id = c.user_type_id
LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
UNION ALL
SELECT N'CHECK', s.name, ty.name, 0,
  CONVERT(nvarchar(max), CONCAT(ch.name COLLATE DATABASE_DEFAULT, N':', ch.definition COLLATE DATABASE_DEFAULT)) COLLATE DATABASE_DEFAULT AS detail
FROM Targets t
INNER JOIN sys.table_types tt ON tt.name = t.objectName AND SCHEMA_NAME(tt.schema_id) = t.schemaName
INNER JOIN sys.types ty ON ty.user_type_id = tt.user_type_id
INNER JOIN sys.schemas s ON s.schema_id = tt.schema_id
INNER JOIN sys.check_constraints ch ON ch.parent_object_id = tt.type_table_object_id
UNION ALL
SELECT N'INDEX', s.name, ty.name, i.index_id,
  CONVERT(nvarchar(max), CONCAT(i.type_desc COLLATE DATABASE_DEFAULT, N':', i.is_unique, N':', i.is_primary_key, N':',
    STUFF((SELECT N',' + col.name + CASE WHEN ic.is_descending_key = 1 THEN N' DESC' ELSE N' ASC' END
           FROM sys.index_columns ic
           INNER JOIN sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
           WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id
           ORDER BY ic.key_ordinal
           FOR XML PATH(N'')), 1, 1, N'') COLLATE DATABASE_DEFAULT)) COLLATE DATABASE_DEFAULT AS detail
FROM Targets t
INNER JOIN sys.table_types tt ON tt.name = t.objectName AND SCHEMA_NAME(tt.schema_id) = t.schemaName
INNER JOIN sys.types ty ON ty.user_type_id = tt.user_type_id
INNER JOIN sys.schemas s ON s.schema_id = tt.schema_id
INNER JOIN sys.indexes i ON i.object_id = tt.type_table_object_id
ORDER BY schemaName, objectName, part, ordinal;
`;

  const authType = normalizeAuthenticationType(profile.authenticationType);
  if (authType !== "Windows" && authType !== "Sql") {
    throw new Error("Unsupported authentication type.");
  }

  const rows = await runSmoQuery(profile, query);
  const signatures = new Map();
  for (const row of rows || []) {
    // Lower-cased to match the object keys deployment compares against.
    const key = `USER_DEFINED_TYPE|${String(row.schemaName).toLowerCase()}|${String(row.objectName).toLowerCase()}`;
    if (!signatures.has(key)) signatures.set(key, []);
    signatures.get(key).push(`${row.part}#${row.ordinal}#${row.detail}`);
  }
  return new Map([...signatures].map(([key, parts]) => [key, parts.sort().join("\n")]));
}

module.exports = {
  testConnection,
  runConnectionDiagnostics,
  discoverObjects,
  fetchObjectDefinitionMap,
  fetchTypeSignatureMap,
  fetchObjectProtectionMetadata,
  executeSql,
  executeSqlScript,
  executeSqlScriptsIndividually,
  getTableCreateScript,
  normalizeBitFlag,
  resolveObjectTypes,
  buildResolveObjectTypesQuery,
  fetchObjectDependencies,
  buildObjectDependenciesQuery,
  fetchObjectDependencyEdges,
};
