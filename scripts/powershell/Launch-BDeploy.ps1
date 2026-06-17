$ErrorActionPreference = "Stop"

& (Join-Path $PSScriptRoot "Launch-Pebloy.ps1") @args
exit $LASTEXITCODE
