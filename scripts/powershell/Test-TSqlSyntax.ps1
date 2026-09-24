param([Parameter(Mandatory = $true)][string]$SqlPath)

$dll = Join-Path $PSScriptRoot "..\..\build\dacfx-worker\win-x64\Microsoft.SqlServer.TransactSql.ScriptDom.dll"
if (-not (Test-Path $dll)) { throw "ScriptDom not found. Run npm run prepare:resources first." }
Add-Type -Path (Resolve-Path $dll)

$parser = New-Object Microsoft.SqlServer.TransactSql.ScriptDom.TSql160Parser($true)
$errors = $null
$reader = New-Object System.IO.StringReader((Get-Content -Raw -LiteralPath $SqlPath))
[void]$parser.Parse($reader, [ref]$errors)

if ($errors.Count -gt 0) {
    $errors | ForEach-Object { Write-Output ("Line {0}: {1}" -f $_.Line, $_.Message) }
    exit 1
}
Write-Output "T-SQL parsed clean: $SqlPath"
