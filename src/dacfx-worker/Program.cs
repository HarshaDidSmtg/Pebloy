using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Microsoft.SqlServer.Dac;
using Microsoft.SqlServer.Dac.Model;

return await WorkerProgram.RunAsync(args);

internal static class WorkerProgram
{
    private static readonly HashSet<string> BuiltInSchemaNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "sys",
        "INFORMATION_SCHEMA",
    };

    private static readonly IReadOnlyDictionary<string, int> ScriptCompileOrder = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase)
    {
        ["USER_DEFINED_TYPE"] = 1,
        ["SEQUENCE"] = 2,
        ["TABLE"] = 3,
        ["VIEW"] = 4,
        ["FUNCTION"] = 5,
        ["PROCEDURE"] = 6,
        ["SYNONYM"] = 7,
        ["TRIGGER"] = 8,
    };

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false,
    };

    public static async Task<int> RunAsync(string[] args)
    {
        try
        {
            var inputText = await Console.In.ReadToEndAsync();
            if (string.IsNullOrWhiteSpace(inputText))
            {
                throw new InvalidOperationException("DacFx worker expected JSON input on stdin.");
            }

            var envelope = JsonSerializer.Deserialize<WorkerEnvelope>(inputText, JsonOptions)
                ?? throw new InvalidOperationException("DacFx worker could not parse the input payload.");

            object result = (envelope.Command ?? string.Empty).Trim().ToLowerInvariant() switch
            {
                "validate" => HandleValidate(envelope.Payload.Deserialize<ValidateRequest>(JsonOptions)
                    ?? throw new InvalidOperationException("Invalid validate request payload.")),
                "compare" => HandleCompare(envelope.Payload.Deserialize<CompareRequest>(JsonOptions)
                    ?? throw new InvalidOperationException("Invalid compare request payload.")),
                "deploy" => HandleDeploy(envelope.Payload.Deserialize<DeployRequest>(JsonOptions)
                    ?? throw new InvalidOperationException("Invalid deploy request payload.")),
                _ => throw new InvalidOperationException($"Unsupported DacFx worker command '{envelope.Command}'."),
            };

            Console.Out.Write(JsonSerializer.Serialize(new WorkerSuccess(result), JsonOptions));
            return 0;
        }
        catch (Exception error)
        {
            Console.Out.Write(JsonSerializer.Serialize(new WorkerFailure(BuildError(error)), JsonOptions));
            return 1;
        }
    }

    private static ValidationResult HandleValidate(ValidateRequest request)
    {
        using var package = CreatePackage(request.Scripts, request.PackageName);
        return new ValidationResult(
            package.ValidScriptCount,
            package.PackagePath,
            package.Objects,
            package.Warnings
        );
    }

    private static CompareResult HandleCompare(CompareRequest request)
    {
        using var package = CreatePackage(request.Scripts, request.PackageName);
        using var dacPackage = DacPackage.Load(package.PackagePath);
        var deployOptions = CreateDeployOptions(request.Options);
        var services = new DacServices(request.Target.ConnectionString);
        var deployScript = services.GenerateDeployScript(dacPackage, request.Target.DatabaseName, deployOptions) ?? string.Empty;
        var deployReport = services.GenerateDeployReport(dacPackage, request.Target.DatabaseName, deployOptions) ?? string.Empty;
        var changedObjects = ParseDeployReport(deployReport, package.ObjectKeys);
        var alerts = ParseDeployAlerts(deployReport);

        return new CompareResult(
            changedObjects.Count > 0 || HasActionableDeployScript(deployScript),
            changedObjects,
            alerts,
            deployScript,
            package.Warnings
        );
    }

    private static DeployResult HandleDeploy(DeployRequest request)
    {
        using var package = CreatePackage(request.Scripts, request.PackageName);
        using var dacPackage = DacPackage.Load(package.PackagePath);
        var deployOptions = CreateDeployOptions(request.Options);
        var services = new DacServices(request.Target.ConnectionString);
        var deployScript = services.GenerateDeployScript(dacPackage, request.Target.DatabaseName, deployOptions) ?? string.Empty;
        var deployReport = services.GenerateDeployReport(dacPackage, request.Target.DatabaseName, deployOptions) ?? string.Empty;
        var changedObjects = ParseDeployReport(deployReport, package.ObjectKeys);
        var alerts = ParseDeployAlerts(deployReport);
        var shouldApply = string.Equals(request.Mode, "apply", StringComparison.OrdinalIgnoreCase);

        if (shouldApply && (changedObjects.Count > 0 || HasActionableDeployScript(deployScript)))
        {
            services.Deploy(dacPackage, request.Target.DatabaseName, upgradeExisting: true, deployOptions);
        }

        return new DeployResult(
            shouldApply,
            changedObjects,
            alerts,
            deployScript,
            package.Objects,
            package.Warnings
        );
    }

    private static DacDeployOptions CreateDeployOptions(DacFxOptions? options)
    {
        return new DacDeployOptions
        {
            BlockOnPossibleDataLoss = options?.BlockOnPossibleDataLoss ?? true,
            DropObjectsNotInSource = options?.DropObjectsNotInSource ?? false,
            BackupDatabaseBeforeChanges = false,
            CreateNewDatabase = false,
            GenerateSmartDefaults = options?.GenerateSmartDefaults ?? false,
        };
    }

    private static BuildPackageResult CreatePackage(IReadOnlyList<ScriptArtifact>? scripts, string? packageName)
    {
        if (scripts == null || scripts.Count == 0)
        {
            throw new InvalidOperationException("No generated source scripts were provided for DacFx processing.");
        }

        var validScripts = scripts
            .Where(script => !string.IsNullOrWhiteSpace(script.ScriptPath))
            .DistinctBy(script => BuildObjectKey(script.ObjectType, script.SchemaName, script.ObjectName))
            .ToList();

        if (validScripts.Count == 0)
        {
            throw new InvalidOperationException("No generated source scripts were available for DacFx processing.");
        }

        var model = new TSqlModel(SqlServerVersion.Sql160, new TSqlModelOptions());
        var objects = new List<ObjectDescriptor>();
        var warnings = new List<string>();
        var objectKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var loadedScripts = new List<LoadedScriptArtifact>();
        var packagePath = Path.Combine(Path.GetTempPath(), $"pebloy_{Guid.NewGuid():N}.dacpac");

        try
        {
            foreach (var script in validScripts)
            {
                if (!File.Exists(script.ScriptPath))
                {
                    warnings.Add($"Missing generated script file: {script.ScriptPath}");
                    continue;
                }

                var sqlText = File.ReadAllText(script.ScriptPath);
                if (string.IsNullOrWhiteSpace(sqlText))
                {
                    warnings.Add($"Generated script file was empty: {script.ScriptPath}");
                    continue;
                }

                loadedScripts.Add(new LoadedScriptArtifact(script, sqlText));
            }

            if (loadedScripts.Count == 0)
            {
                throw new InvalidOperationException("No generated source scripts could be compiled into a DacFx package.");
            }

            AddReferencedSchemas(model, loadedScripts);

            foreach (var loadedScript in OrderScriptsForCompilation(loadedScripts))
            {
                var script = loadedScript.Script;

                try
                {
                    model.AddOrUpdateObjects(loadedScript.SqlText, script.ScriptPath, new TSqlObjectOptions());
                }
                catch (Exception error)
                {
                    var label = BuildDisplayName(script.ObjectType, script.SchemaName, script.ObjectName);
                    throw new InvalidOperationException($"DacFx failed to compile {label}: {error.Message}", error);
                }

                objects.Add(new ObjectDescriptor(script.ObjectType, script.SchemaName, script.ObjectName));
                objectKeys.Add(BuildObjectKey(script.ObjectType, script.SchemaName, script.ObjectName));
            }

            DacPackageExtensions.BuildPackage(
                packagePath,
                model,
                new PackageMetadata { Name = string.IsNullOrWhiteSpace(packageName) ? "PebloyGeneratedPackage" : packageName.Trim() }
            );

            return new BuildPackageResult(packagePath, objects.Count, objects, warnings, objectKeys);
        }
        catch
        {
            if (File.Exists(packagePath))
            {
                File.Delete(packagePath);
            }

            throw;
        }
    }

    private static void AddReferencedSchemas(TSqlModel model, IReadOnlyList<LoadedScriptArtifact> scripts)
    {
        foreach (var schemaName in GetReferencedSchemaNames(scripts))
        {
            var escapedSchemaName = schemaName.Replace("]", "]]", StringComparison.Ordinal);
            var schemaPath = $"__internal__/schema_{Regex.Replace(schemaName, "[^A-Za-z0-9_]+", "_")}.sql";

            try
            {
                model.AddOrUpdateObjects($"CREATE SCHEMA [{escapedSchemaName}];", schemaPath, new TSqlObjectOptions());
            }
            catch (Exception error)
            {
                throw new InvalidOperationException($"DacFx failed to synthesize schema [{schemaName}]: {error.Message}", error);
            }
        }
    }

    private static IReadOnlyList<LoadedScriptArtifact> OrderScriptsForCompilation(IReadOnlyList<LoadedScriptArtifact> scripts)
    {
        return scripts
            .OrderBy(script => GetScriptCompileOrder(script.Script.ObjectType))
            .ThenBy(script => (script.Script.ObjectType ?? string.Empty).Trim(), StringComparer.OrdinalIgnoreCase)
            .ThenBy(script => (script.Script.SchemaName ?? string.Empty).Trim(), StringComparer.OrdinalIgnoreCase)
            .ThenBy(script => (script.Script.ObjectName ?? string.Empty).Trim(), StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static int GetScriptCompileOrder(string? objectType)
    {
        return ScriptCompileOrder.TryGetValue((objectType ?? string.Empty).Trim(), out var order) ? order : int.MaxValue;
    }

    private static IReadOnlyList<string> GetReferencedSchemaNames(IReadOnlyList<LoadedScriptArtifact> scripts)
    {
        var schemaNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var loadedScript in scripts)
        {
            AddSchemaName(schemaNames, loadedScript.Script.SchemaName);

            foreach (Match match in Regex.Matches(loadedScript.SqlText, @"(?:\[[^\]]+\]\s*\.\s*)?\[(?<schema>[^\]]+)\]\s*\.\s*\[[^\]]+\]"))
            {
                AddSchemaName(schemaNames, match.Groups["schema"].Value);
            }
        }

        return schemaNames
            .Where(schemaName => !string.Equals(schemaName, "dbo", StringComparison.OrdinalIgnoreCase))
            .Where(schemaName => !BuiltInSchemaNames.Contains(schemaName))
            .OrderBy(schemaName => schemaName, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static void AddSchemaName(HashSet<string> schemaNames, string? schemaName)
    {
        var normalized = (schemaName ?? string.Empty).Trim().Trim('[', ']');
        if (!string.IsNullOrWhiteSpace(normalized))
        {
            schemaNames.Add(normalized);
        }
    }

    private static IReadOnlyList<DeployAlert> ParseDeployAlerts(string xmlText)
    {
        if (string.IsNullOrWhiteSpace(xmlText))
        {
            return [];
        }

        var document = XDocument.Parse(xmlText);
        var ns = document.Root?.Name.Namespace ?? XNamespace.None;
        return document
            .Descendants(ns + "Alert")
            .Select(alert => new DeployAlert(
                (string?)alert.Attribute("Name") ?? string.Empty,
                (string?)alert.Attribute("Severity") ?? string.Empty,
                NormalizeWhitespace(alert.Value)
            ))
            .Where(alert => !string.IsNullOrWhiteSpace(alert.Name) || !string.IsNullOrWhiteSpace(alert.Message))
            .ToList();
    }

    private static IReadOnlyList<DeployChange> ParseDeployReport(string xmlText, HashSet<string> selectedKeys)
    {
        if (string.IsNullOrWhiteSpace(xmlText))
        {
            return [];
        }

        var document = XDocument.Parse(xmlText);
        var ns = document.Root?.Name.Namespace ?? XNamespace.None;
        var changes = new Dictionary<string, DeployChange>(StringComparer.OrdinalIgnoreCase);

        foreach (var operation in document.Descendants(ns + "Operation"))
        {
            var operationName = NormalizeOperation((string?)operation.Attribute("Name") ?? string.Empty);
            foreach (var item in operation.Descendants(ns + "Item"))
            {
                var objectType = MapObjectType((string?)item.Attribute("Type") ?? string.Empty);
                if (string.IsNullOrWhiteSpace(objectType))
                {
                    continue;
                }

                if (!TryParseObjectName((string?)item.Attribute("Value") ?? string.Empty, out var schemaName, out var objectName))
                {
                    continue;
                }

                var key = BuildObjectKey(objectType, schemaName, objectName);
                if (!selectedKeys.Contains(key))
                {
                    continue;
                }

                changes[key] = new DeployChange(objectType, schemaName, objectName, operationName);
            }
        }

        return changes.Values.OrderBy(item => item.ObjectType).ThenBy(item => item.SchemaName).ThenBy(item => item.ObjectName).ToList();
    }

    private static string NormalizeOperation(string operationName)
    {
        if (string.IsNullOrWhiteSpace(operationName))
        {
            return "Alter";
        }

        return char.ToUpperInvariant(operationName[0]) + operationName[1..].ToLowerInvariant();
    }

    private static string MapObjectType(string dacType)
    {
        return dacType switch
        {
            "SqlProcedure" => "PROCEDURE",
            "SqlView" => "VIEW",
            "SqlFunction" => "FUNCTION",
            "SqlInlineTableValuedFunction" => "FUNCTION",
            "SqlTableValuedFunction" => "FUNCTION",
            "SqlScalarFunction" => "FUNCTION",
            "SqlTable" => "TABLE",
            "SqlSynonym" => "SYNONYM",
            "SqlSequence" => "SEQUENCE",
            "SqlUserDefinedTableType" => "USER_DEFINED_TYPE",
            "SqlUserDefinedDataType" => "USER_DEFINED_TYPE",
            "SqlDmlTrigger" => "TRIGGER",
            _ => string.Empty,
        };
    }

    private static bool TryParseObjectName(string value, out string schemaName, out string objectName)
    {
        schemaName = string.Empty;
        objectName = string.Empty;

        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        var bracketMatches = Regex.Matches(value, @"\[(?<part>[^\]]+)\]");
        if (bracketMatches.Count >= 2)
        {
            schemaName = bracketMatches[bracketMatches.Count - 2].Groups["part"].Value;
            objectName = bracketMatches[bracketMatches.Count - 1].Groups["part"].Value;
            return !string.IsNullOrWhiteSpace(schemaName) && !string.IsNullOrWhiteSpace(objectName);
        }

        var parts = value.Split('.', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length >= 2)
        {
            schemaName = parts[^2].Trim('[', ']');
            objectName = parts[^1].Trim('[', ']');
            return !string.IsNullOrWhiteSpace(schemaName) && !string.IsNullOrWhiteSpace(objectName);
        }

        return false;
    }

    private static bool HasActionableDeployScript(string deployScript)
    {
        var lines = deployScript
            .Split(new[] { "\r\n", "\n" }, StringSplitOptions.None)
            .Select(line => line.Trim())
            .Where(line => !string.IsNullOrWhiteSpace(line))
            .Where(line => !line.StartsWith("/*", StringComparison.Ordinal))
            .Where(line => !line.StartsWith("--", StringComparison.Ordinal))
            .ToList();

        return lines.Any();
    }

    private static string NormalizeWhitespace(string value)
    {
        return Regex.Replace(value ?? string.Empty, "\\s+", " ").Trim();
    }

    private static WorkerError BuildError(Exception error)
    {
        return new WorkerError(error.Message, error.InnerException?.Message);
    }

    private static string BuildObjectKey(string? objectType, string? schemaName, string? objectName)
    {
        return $"{(objectType ?? string.Empty).Trim().ToUpperInvariant()}|{(schemaName ?? string.Empty).Trim().ToLowerInvariant()}|{(objectName ?? string.Empty).Trim().ToLowerInvariant()}";
    }

    private static string BuildDisplayName(string? objectType, string? schemaName, string? objectName)
    {
        return $"{(objectType ?? "OBJECT").Trim().ToUpperInvariant()} {(schemaName ?? "dbo").Trim()}.{(objectName ?? "<unknown>").Trim()}";
    }

    private sealed record WorkerEnvelope(string Command, JsonElement Payload);
    private sealed record WorkerSuccess(object Result)
    {
        public bool Success { get; } = true;
    }
    private sealed record WorkerFailure(WorkerError Error)
    {
        public bool Success { get; } = false;
    }
    private sealed record WorkerError(string Message, string? Detail);

    private sealed record ScriptArtifact(string ObjectType, string SchemaName, string ObjectName, string ScriptPath);
    private sealed record LoadedScriptArtifact(ScriptArtifact Script, string SqlText);
    private sealed record ConnectionTarget(string ConnectionString, string DatabaseName);
    private sealed record DacFxOptions(bool? BlockOnPossibleDataLoss, bool? DropObjectsNotInSource, bool? GenerateSmartDefaults);
    private sealed record ValidateRequest(IReadOnlyList<ScriptArtifact> Scripts, string? PackageName);
    private sealed record CompareRequest(IReadOnlyList<ScriptArtifact> Scripts, ConnectionTarget Target, DacFxOptions? Options, string? PackageName);
    private sealed record DeployRequest(IReadOnlyList<ScriptArtifact> Scripts, ConnectionTarget Target, DacFxOptions? Options, string? PackageName, string? Mode);

    private sealed record ObjectDescriptor(string ObjectType, string SchemaName, string ObjectName);
    private sealed record DeployChange(string ObjectType, string SchemaName, string ObjectName, string Operation);
    private sealed record DeployAlert(string Name, string Severity, string Message);
    private sealed record ValidationResult(int ObjectCount, string PackagePath, IReadOnlyList<ObjectDescriptor> Objects, IReadOnlyList<string> Warnings);
    private sealed record CompareResult(bool HasChanges, IReadOnlyList<DeployChange> Changes, IReadOnlyList<DeployAlert> Alerts, string DeployScript, IReadOnlyList<string> Warnings);
    private sealed record DeployResult(bool Applied, IReadOnlyList<DeployChange> Changes, IReadOnlyList<DeployAlert> Alerts, string DeployScript, IReadOnlyList<ObjectDescriptor> Objects, IReadOnlyList<string> Warnings);

    private sealed class BuildPackageResult : IDisposable
    {
        public BuildPackageResult(string packagePath, int validScriptCount, IReadOnlyList<ObjectDescriptor> objects, IReadOnlyList<string> warnings, HashSet<string> objectKeys)
        {
            PackagePath = packagePath;
            ValidScriptCount = validScriptCount;
            Objects = objects;
            Warnings = warnings;
            ObjectKeys = objectKeys;
        }

        public string PackagePath { get; }
        public int ValidScriptCount { get; }
        public IReadOnlyList<ObjectDescriptor> Objects { get; }
        public IReadOnlyList<string> Warnings { get; }
        public HashSet<string> ObjectKeys { get; }

        public void Dispose()
        {
            if (File.Exists(PackagePath))
            {
                File.Delete(PackagePath);
            }
        }
    }
}
