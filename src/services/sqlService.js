const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { execFile } = require("child_process");
const { normalizeDdlKeywords } = require("./scriptAutomationService");

const SQL_QUERY_TIMEOUT_MS = 120000;
const POWERSHELL_TIMEOUT_MS = 180000;

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

function cleanPowerShellError(raw) {
  const text = String(raw || "");
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

function runPowerShell(scriptText, maxBuffer = 1024 * 1024 * 20) {
  const tempFile = path.join(os.tmpdir(), `pebloy_${randomUUID()}.ps1`);
  fs.writeFileSync(tempFile, scriptText, "utf8");

  return new Promise((resolve, reject) => {
    execFile(
      "pwsh",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tempFile],
      {
        encoding: "utf8",
        maxBuffer,
        timeout: POWERSHELL_TIMEOUT_MS,
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
  });
}

function runPowerShellLines(
  scriptText,
  onLine,
  maxBuffer = 1024 * 1024 * 20,
  timeoutMs = POWERSHELL_TIMEOUT_MS
) {
  const tempFile = path.join(os.tmpdir(), `pebloy_${randomUUID()}.ps1`);
  fs.writeFileSync(tempFile, scriptText, "utf8");

  return new Promise((resolve, reject) => {
    let pending = "";
    const child = execFile(
      "pwsh",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tempFile],
      {
        encoding: "utf8",
        maxBuffer,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        try {
          fs.unlinkSync(tempFile);
        } catch (_e) {
          // Ignore cleanup errors for temp files.
        }

        if (pending.trim()) {
          onLine(pending.trim());
          pending = "";
        }
        if (error) {
          error.cleanedMessage = cleanPowerShellError(stderr || stdout || error.message);
          reject(error);
          return;
        }
        resolve();
      }
    );

    child.stdout.on("data", (chunk) => {
      pending += String(chunk || "");
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) {
          onLine(line.trim());
        }
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
  const password = escapeSingleQuotes(profile.password);
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
      $builder['Password'] = '${password}'
      $builder['Integrated Security'] = $false
    }
    $connectionString = $builder.ConnectionString

    $connection = New-Object System.Data.SqlClient.SqlConnection($connectionString)
    $connection.Open()
    $command = $connection.CreateCommand()
    $command.CommandText = $query
    $command.CommandTimeout = ${Math.floor(SQL_QUERY_TIMEOUT_MS / 1000)}

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
    output = await runPowerShell(psScript);
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

function composeModuleDefinition(definition, usesAnsiNulls, usesQuotedIdentifier) {
  const body = normalizeDefinition(definition);
  if (!body) {
    return "";
  }

  const parts = [];
  const ansiFlag = normalizeBitFlag(usesAnsiNulls);
  const quotedFlag = normalizeBitFlag(usesQuotedIdentifier);
  const hasAnsiHeader = /^\s*SET\s+ANSI_NULLS\s+(?:ON|OFF)\s*;?$/im.test(body);
  const hasQuotedHeader = /^\s*SET\s+QUOTED_IDENTIFIER\s+(?:ON|OFF)\s*;?$/im.test(body);

  if (ansiFlag !== null && !hasAnsiHeader) {
    parts.push(`SET ANSI_NULLS ${ansiFlag ? "ON" : "OFF"}`, "GO");
  }
  if (quotedFlag !== null && !hasQuotedHeader) {
    parts.push(`SET QUOTED_IDENTIFIER ${quotedFlag ? "ON" : "OFF"}`, "GO");
  }

  parts.push(body);
  return parts.join("\n").trim();
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

async function executeSqlScript(profile, sqlText) {
  const authType = normalizeAuthenticationType(profile.authenticationType);
  if (authType !== "Windows" && authType !== "Sql") {
    throw new Error("Unsupported authentication type.");
  }

  const batches = String(sqlText || "")
    .split(/^\s*GO\s*$/gim)
    .map((batch) => batch.trim())
    .filter(Boolean);

  if (!batches.length) {
    return;
  }

  const { host, suffix } = splitSqlServerName(profile.serverName);
  const server = escapeSingleQuotes(profile.serverName);
  const serverHost = escapeSingleQuotes(host);
  const serverSuffix = escapeSingleQuotes(suffix);
  const database = escapeSingleQuotes(profile.databaseName);
  const username = escapeSingleQuotes(profile.username);
  const password = escapeSingleQuotes(profile.password);
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
      $builder['Password'] = '${password}'
      $builder['Integrated Security'] = $false
    }

    $connection = New-Object System.Data.SqlClient.SqlConnection($builder.ConnectionString)
    $connection.Open()

    foreach ($batch in @($batches)) {
      $text = [string]$batch
      if ([string]::IsNullOrWhiteSpace($text)) { continue }
      $command = $connection.CreateCommand()
      $command.CommandText = $text
      $command.CommandTimeout = ${Math.floor(SQL_QUERY_TIMEOUT_MS / 1000)}
      [void]$command.ExecuteNonQuery()
      $command.Dispose()
    }

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

throw 'SQL script failed for unknown reason.'
`;

  try {
    await runPowerShell(psScript, 1024 * 1024 * 20);
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
    batches: String(entry.sqlText || "")
      .split(/^\s*GO\s*$/gim)
      .map((batch) => batch.trim())
      .filter(Boolean),
  }));
  if (!entries.length) {
    return [];
  }

  const { host, suffix } = splitSqlServerName(profile.serverName);
  const server = escapeSingleQuotes(profile.serverName);
  const serverHost = escapeSingleQuotes(host);
  const serverSuffix = escapeSingleQuotes(suffix);
  const database = escapeSingleQuotes(profile.databaseName);
  const username = escapeSingleQuotes(profile.username);
  const password = escapeSingleQuotes(profile.password);
  const payloadBase64 = Buffer.from(
    JSON.stringify({ entries, continueOnError: Boolean(options.continueOnError) }),
    "utf8"
  ).toString("base64");
  const batchCount = entries.reduce((count, entry) => count + entry.batches.length, 0);
  const sessionTimeoutMs = POWERSHELL_TIMEOUT_MS + (batchCount * SQL_QUERY_TIMEOUT_MS);

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
    $command.CommandTimeout = ${Math.floor(SQL_QUERY_TIMEOUT_MS / 1000)}
    return [int]$command.ExecuteScalar()
  } finally {
    $command.Dispose()
  }
}

function Reset-SessionTransaction($connection) {
  $command = $connection.CreateCommand()
  try {
    $command.CommandText = 'IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION; SELECT @@TRANCOUNT;'
    $command.CommandTimeout = ${Math.floor(SQL_QUERY_TIMEOUT_MS / 1000)}
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
      $builder['Password'] = '${password}'
      $builder['Integrated Security'] = $false
    }

    $connection = New-Object System.Data.SqlClient.SqlConnection($builder.ConnectionString)
    $connection.Open()
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
          foreach ($batch in @($entry.batches)) {
            $text = [string]$batch
            if ([string]::IsNullOrWhiteSpace($text)) { continue }
            $command = $connection.CreateCommand()
            try {
              $command.CommandText = $text
              $command.CommandTimeout = ${Math.floor(SQL_QUERY_TIMEOUT_MS / 1000)}
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
          if ($endTranCount -ne $startTranCount) {
            $remainingTranCount = Reset-SessionTransaction $connection
            $entryError = "Script left the shared SQL session with @@TRANCOUNT=$endTranCount after '$($entry.key)'. Rolled back leaked transactions and reset session state to @@TRANCOUNT=$remainingTranCount."
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
      const result = JSON.parse(line);
      results.push(result);
      if (typeof options.onResult === "function") {
        options.onResult(result);
      }
    }, 1024 * 1024 * 20, sessionTimeoutMs);
    return results;
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

async function resolveObjectTypes(profile, objects = []) {
  if (!objects.length) return [];

  const inputCte = objects
    .map(
      (o, index) =>
        `SELECT ${index + 1} AS inputRow, ${escapeSqlLiteral(String(o.schemaName || ""))} AS schemaName, ${escapeSqlLiteral(String(o.objectName || ""))} AS objectName`
    )
    .join("\nUNION ALL\n");

  const query = `
WITH InputObjects AS (
${inputCte}
),
ObjectCatalog AS (
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
),
Matches AS (
  SELECT io.inputRow,
         io.schemaName AS inputSchema,
         io.objectName AS inputObject,
         oc.schemaName AS dbSchema,
         oc.objectName AS dbObject,
         oc.objectType,
         oc.createdDate,
         oc.modifiedDate
  FROM InputObjects io
  INNER JOIN ObjectCatalog oc
    ON LOWER(oc.objectName) = LOWER(io.objectName)
   AND (
      NULLIF(LTRIM(RTRIM(io.schemaName)), '') IS NULL
      OR LOWER(oc.schemaName) = LOWER(io.schemaName)
   )
),
MatchSummary AS (
  SELECT inputRow, COUNT(*) AS matchCount
  FROM Matches
  GROUP BY inputRow
),
RankedMatches AS (
  SELECT m.*, ROW_NUMBER() OVER (
    PARTITION BY m.inputRow
    ORDER BY CASE WHEN LOWER(m.dbSchema) = LOWER(m.inputSchema) THEN 0 ELSE 1 END, m.dbSchema, m.dbObject, m.objectType
  ) AS matchRank
  FROM Matches m
)
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
FROM InputObjects io
LEFT JOIN MatchSummary ms ON ms.inputRow = io.inputRow
LEFT JOIN RankedMatches rm ON rm.inputRow = io.inputRow AND rm.matchRank = 1
ORDER BY io.inputRow;
`;

  const authType = normalizeAuthenticationType(profile.authenticationType);
  if (authType !== "Windows" && authType !== "Sql") {
    throw new Error("Unsupported authentication type.");
  }

  return await runSmoQuery(profile, query);
}

module.exports = {
  testConnection,
  runConnectionDiagnostics,
  discoverObjects,
  fetchObjectDefinitionMap,
  executeSql,
  executeSqlScript,
  executeSqlScriptsIndividually,
  getTableCreateScript,
  resolveObjectTypes,
};
