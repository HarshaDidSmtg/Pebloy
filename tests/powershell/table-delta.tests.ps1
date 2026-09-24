$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot '../../scripts/powershell/CompareTablesGenerateDelta.ps1'
$tokens = $null
$parseErrors = $null
$syntax = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $scriptPath), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$functions = $syntax.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)
foreach ($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }

function Assert-Equal($Actual, $Expected) {
    if ($Actual -cne $Expected) { throw "Expected '$Expected', received '$Actual'." }
}

Assert-Equal (Get-ObjectKey 'Finance' 'PaymentHistory') 'Finance.PaymentHistory'
Assert-Equal (Get-QualifiedName 'Finance' 'PaymentHistory') '[Finance].[PaymentHistory]'
$database = [pscustomobject]@{}
$database | Add-Member ScriptMethod ExecuteWithResults {
    param($query)
    if (!$query.Contains("s.name = N'finance'") -or !$query.Contains("t.name = N'paymenthistory'") -or $query.Contains('LOWER(')) {
        throw 'Selected-object lookup must use native identifier collation without rewriting names.'
    }
    return [pscustomobject]@{ Tables = @([pscustomobject]@{ Rows = @([pscustomobject]@{ SchemaName = 'Finance'; TableName = 'PaymentHistory' }) }) }
}
$resolved = @(Resolve-SelectedTableKeysFromDatabase -Database $database -SelectedTableKeys @('finance.paymenthistory'))
Assert-Equal $resolved.Count 1
Assert-Equal $resolved[0] 'Finance.PaymentHistory'

$caseDatabase = [pscustomobject]@{ ComparisonStyle = 1 }
$caseDatabase | Add-Member ScriptMethod ExecuteWithResults {
    param($query)
    if (!$query.Contains("SQL_VARIANT_PROPERTY(name, 'Collation')")) { throw 'Use metadata identifier collation.' }
    return [pscustomobject]@{ Tables = @([pscustomobject]@{ Rows = @([pscustomobject]@{ ComparisonStyle = $this.ComparisonStyle }) }) }
}
$nameComparer = Get-IdentifierComparer -Database $caseDatabase
Assert-Equal ($nameComparer.Equals('PaymentHistory', 'paymenthistory')) $true
$caseDatabase.ComparisonStyle = 0
$nameComparer = Get-IdentifierComparer -Database $caseDatabase
Assert-Equal ($nameComparer.Equals('PaymentHistory', 'paymenthistory')) $false

$caseRows = [pscustomobject]@{}
$caseRows | Add-Member ScriptMethod ExecuteWithResults {
    param($query)
    return [pscustomobject]@{ Tables = @([pscustomobject]@{ Rows = @(
        [pscustomobject]@{ SchemaName = 'Finance'; TableName = 'PaymentHistory' },
        [pscustomobject]@{ SchemaName = 'Finance'; TableName = 'paymenthistory' }
    ) }) }
}
$caseKeys = @(Resolve-SelectedTableKeysFromDatabase -Database $caseRows -SelectedTableKeys @('Finance.PaymentHistory', 'Finance.paymenthistory') -NameComparer $nameComparer)
Assert-Equal $caseKeys.Count 2
if ($caseKeys -cnotcontains 'Finance.PaymentHistory' -or $caseKeys -cnotcontains 'Finance.paymenthistory') {
    throw 'Case-distinct metadata names must both survive resolution.'
}

$targetNameComparer = [System.StringComparer]::OrdinalIgnoreCase
$selectedTableKeys = $caseKeys
$collisionStatements = $syntax.EndBlock.Statements | Where-Object {
    $_.Extent.Text.StartsWith('$targetSelectionKeys =') -or
    ($_.Extent.Text.StartsWith('foreach ($tableKey in $selectedTableKeys)') -and $_.Extent.Text.Contains('$targetSelectionKeys.Add'))
}
$collisionBlocked = $false
try { foreach ($statement in $collisionStatements) { . ([scriptblock]::Create($statement.Extent.Text)) } }
catch {
    if (!$_.Exception.Message.Contains('collide under target identifier case sensitivity')) { throw }
    $collisionBlocked = $true
}
Assert-Equal $collisionBlocked $true

$sourceDb = [pscustomobject]@{ Name = 'SourceDatabase' }
$targetDb = [pscustomobject]@{ Name = 'TargetDatabase' }
$TargetDatabase = 'targetdatabase'
$batches = [System.Collections.Generic.List[string]]::new()
$useStatement = $syntax.EndBlock.Statements | Where-Object { $_.Extent.Text.StartsWith('Add-Batch $batches "USE ') }
. ([scriptblock]::Create($useStatement.Extent.Text))
Assert-Equal $batches[0] 'USE [TargetDatabase];'

$selectionFile = [System.IO.Path]::GetTempFileName()
try {
    [System.IO.File]::WriteAllLines($selectionFile, @('Finance.PaymentHistory', 'Finance.paymenthistory'))
    $selection = @(Read-ObjectList -Path $selectionFile)
    Assert-Equal $selection.Count 2
} finally { [System.IO.File]::Delete($selectionFile) }

$sourceColumn = [pscustomobject]@{
    SchemaName = 'Finance'; TableName = 'PaymentHistory'; ColumnName = 'PaymentStatus'; ColumnId = 1
    DataType = 'nvarchar'; max_length = 40; precision = 0; scale = 0; IsNullable = $false
    CollationName = 'Latin1_General_CS_AS'; IsIdentity = $false; IsComputed = $false
    DefaultDefinition = "(N'Open')"; DefaultConstraintName = 'DF_PaymentStatus'
}
$targetColumn = $sourceColumn.PSObject.Copy()
$targetColumn.DefaultDefinition = "(N'OPEN')"
$sourceTableKey = 'Finance.PaymentHistory'
$sourceTable = [pscustomobject]@{ Schema = 'Finance'; Name = 'PaymentHistory' }
$sourceTables = @{ $sourceTableKey = $sourceTable }
$targetTables = @{ $sourceTableKey = $sourceTable }
$sourceColumnMap = @{ $sourceTableKey = @($sourceColumn) }
$targetColumnMap = @{ 'Finance.PaymentHistory|paymentstatus' = $targetColumn }
$batches = [System.Collections.Generic.List[string]]::new()
$tableLoop = $syntax.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.ForEachStatementAst] -and $_.Variable.VariablePath.UserPath -eq 'sourceTableKey' }
if (@($tableLoop).Count -ne 1) { throw 'Expected exactly one table delta generation loop.' }
. ([scriptblock]::Create($tableLoop.Extent.Text))
if ($batches.Count -ne 1 -or !$batches[0].Contains('Manual review required: default constraint differs')) {
    throw 'Case-only default changes must require review instead of disappearing.'
}
if (!$batches[0].Contains('[Finance].[PaymentHistory].[PaymentStatus]')) { throw 'Delta lost metadata casing.' }
if (!$batches[0].Contains("Source: (N'Open') Target: (N'OPEN')")) { throw 'Delta changed string-literal casing.' }

$targetColumnMap.Clear()
$batches.Clear()
. ([scriptblock]::Create($tableLoop.Extent.Text))
if ($batches.Count -ne 1 -or !$batches[0].Contains('ALTER TABLE [Finance].[PaymentHistory] ADD [PaymentStatus]')) {
    throw 'Added column SQL must preserve metadata casing.'
}
if (!$batches[0].Contains("DEFAULT (N'Open')")) { throw 'Added column SQL changed its literal.' }

$sourceColumnMap[$sourceTableKey] = @($sourceColumn)
$lowercaseColumn = $sourceColumn.PSObject.Copy()
$lowercaseColumn.ColumnName = 'paymentstatus'
$targetColumnMap = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
$targetColumnMap['Finance.PaymentHistory|paymentstatus'] = $lowercaseColumn
$batches.Clear()
. ([scriptblock]::Create($tableLoop.Extent.Text))
if ($batches.Count -ne 1 -or !$batches[0].Contains('ADD [PaymentStatus]')) { throw 'Case-sensitive column names were conflated.' }
$targetColumnMap = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::OrdinalIgnoreCase)
$targetColumnMap['Finance.PaymentHistory|paymentstatus'] = $lowercaseColumn
$batches.Clear()
. ([scriptblock]::Create($tableLoop.Extent.Text))
Assert-Equal $batches.Count 0

$sourceColumn.IsComputed = $true
$sourceColumn | Add-Member NoteProperty ComputedDefinition "CASE WHEN [PaymentStatus] = N'Open' THEN 1 ELSE 0 END"
$sourceColumn | Add-Member NoteProperty IsPersisted $false
$computedTarget = $sourceColumn.PSObject.Copy()
$computedTarget.ComputedDefinition = "CASE WHEN [PaymentStatus] = N'OPEN' THEN 1 ELSE 0 END"
$targetColumnMap['Finance.PaymentHistory|PaymentStatus'] = $computedTarget
$batches.Clear()
. ([scriptblock]::Create($tableLoop.Extent.Text))
if ($batches.Count -ne 1 -or !$batches[0].Contains('Manual review required: computed/identity column differs')) {
    throw 'Case-only computed expressions must require review.'
}

$aliasColumn = [pscustomobject]@{
    SchemaName = 'Finance'; TableName = 'PaymentHistory'; ColumnName = 'PaymentCode'
    IsComputed = $false; IsUserDefined = $true; DataTypeSchema = 'Types'; DataType = 'PaymentCodeType'
    IsNullable = $false; max_length = 40; precision = 0; scale = 0
}
Assert-Equal (Get-SqlTypeDefinition $aliasColumn) '[Types].[PaymentCodeType]'
$aliasGuard = New-IfColumnDifferentSql -Column $aliasColumn -Sql 'ALTER TABLE [Finance].[PaymentHistory] ALTER COLUMN [PaymentCode] [Types].[PaymentCodeType] NOT NULL;'
if (!$aliasGuard.Contains("ty.name <> N'PaymentCodeType'") -or !$aliasGuard.Contains("SCHEMA_NAME(ty.schema_id) <> N'Types'")) {
    throw 'Type guards must preserve actual type and schema names.'
}

$index = [pscustomobject]@{
    Parent = $sourceTable; Name = 'IX_PaymentStatus'; IsHypothetical = $false
    IndexKeyType = 'None'; IndexType = 'NonClusteredIndex'; IsUnique = $false; IsClustered = $false
    HasFilter = $true; FilterDefinition = "([PaymentStatus]=N'Open')"
    IndexedColumns = @([pscustomobject]@{ Name = 'PaymentStatus'; Descending = $false; IsIncluded = $false })
}
$targetIndex = $index.PSObject.Copy()
$targetIndex.FilterDefinition = "([PaymentStatus]=N'OPEN')"
Assert-Equal (Get-IndexKey $index) 'Finance.PaymentHistory.IX_PaymentStatus'
$sourceTable | Add-Member NoteProperty Indexes @($index)
$targetIndexMap = @{ 'Finance.PaymentHistory.IX_PaymentStatus' = $targetIndex }
$indexLoop = $syntax.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.ForEachStatementAst] -and $_.Extent.Text.Contains('$indexSignatureKey =') }
if (@($indexLoop).Count -ne 1) { throw 'Expected one index comparison loop.' }
$batches.Clear()
. ([scriptblock]::Create($indexLoop.Extent.Text))
if ($batches.Count -ne 1 -or !$batches[0].Contains('Manual review required: index/key differs')) {
    throw 'Case-only filtered index predicates must require review.'
}

$sameIndex = $index.PSObject.Copy()
$sameIndex.Parent = [pscustomobject]@{ Schema = 'finance'; Name = 'paymenthistory' }
$sameIndex.Name = 'AnotherIndexName'
$sameIndex.IndexedColumns = @([pscustomobject]@{ Name = 'paymentstatus'; Descending = $false; IsIncluded = $false })
Assert-Equal (Get-IndexSignatureKey -Index $index -NameComparer ([System.StringComparer]::OrdinalIgnoreCase)) (Get-IndexSignatureKey -Index $sameIndex -NameComparer ([System.StringComparer]::OrdinalIgnoreCase))
if ((Get-IndexSignatureKey -Index $index -NameComparer ([System.StringComparer]::Ordinal)) -ceq (Get-IndexSignatureKey -Index $sameIndex -NameComparer ([System.StringComparer]::Ordinal))) {
    throw 'Case-sensitive index signatures must distinguish identifier casing.'
}
$sameIndex.FilterDefinition = "([PaymentStatus]=N'OPEN')"
if ((Get-IndexSignatureKey -Index $index -NameComparer ([System.StringComparer]::OrdinalIgnoreCase)) -ceq (Get-IndexSignatureKey -Index $sameIndex -NameComparer ([System.StringComparer]::OrdinalIgnoreCase))) {
    throw 'Case-insensitive index identifiers must not hide case-sensitive filter text differences.'
}
Write-Output 'Table delta casing and case-only definition checks passed without SQL access.'