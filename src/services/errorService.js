function uniqueSteps(steps = []) {
  return [...new Set((Array.isArray(steps) ? steps : []).filter(Boolean))];
}

function buildClientError(error, fallbackStatus = 400) {
  const message = String(error?.message || error || "Request failed.").trim() || "Request failed.";
  const lower = message.toLowerCase();
  const isTimeout = /timeout|timed out/.test(lower);

  let status = Number.isInteger(error?.status) ? error.status : fallbackStatus;
  let resolutionSteps = [];

  if (/profile not found|task not found|log file path not found|path not found/.test(lower)) {
    status = 404;
  } else if (/cannot .* while a task is running|source and destination are identical/.test(lower)) {
    status = 409;
  } else if (/login failed/.test(lower)) {
    status = 401;
  } else if (/permission denied|access is denied|eacces/.test(lower)) {
    status = 403;
  } else if (isTimeout) {
    status = 504;
  } else if (/sqlserver module install failed|save-module/.test(lower)) {
    status = 500;
  }

  if (isTimeout) {
    resolutionSteps = [
      "Verify the SQL Server host is reachable from this machine.",
      "Check firewall, VPN, instance name, and TCP port settings.",
      "Confirm the selected profile points to the expected server and database.",
    ];
  } else if (/login failed/.test(lower)) {
    resolutionSteps = [
      "Verify authentication type, username, and password in the selected connection profile.",
      "If the password changed recently, edit and save the profile again.",
      "Confirm the login has permission to access the selected database.",
    ];
  } else if (/permission denied|access is denied|eacces/.test(lower)) {
    resolutionSteps = [
      "Check write permissions for the selected output or artifact folder.",
      "If a file is open in another process, close it and retry.",
      "Run Pebloy with an account that can access the target path.",
    ];
  } else if (/sqlserver module install failed|save-module/.test(lower)) {
    resolutionSteps = [
      "Ensure PowerShell can install modules on this machine.",
      "Verify internet access or preinstall the SqlServer module under vendor/ps-modules.",
      "Retry after confirming PowerShell execution policy and PSGallery access.",
    ];
  } else if (/profile not found/.test(lower)) {
    resolutionSteps = [
      "Refresh the connection list and reselect the source or target profile.",
      "If the profile was deleted or renamed, recreate it before retrying.",
    ];
  } else if (/no valid objects supplied|requires at least one selected object|could not be resolved|not found in db/.test(lower)) {
    resolutionSteps = [
      "Verify the selected object list is not empty.",
      "Check schema and object names against the source database metadata.",
      "Use Discover mode if you need to confirm the exact database object names.",
    ];
  } else if (/source and destination are identical/.test(lower)) {
    resolutionSteps = [
      "Choose different source and target profiles, or enable the explicit override if this is intentional.",
    ];
  } else if (/bulk script generation failed|dbobjectsbulkscriptgenerator/i.test(lower)) {
    resolutionSteps = [
      "Confirm the source database is reachable and the selected profile credentials are valid.",
      "Check that the SqlServer PowerShell module is installed under vendor/ps-modules or in the user module path.",
      "Open the task log for the full PowerShell error output to identify which object caused the failure.",
    ];
  } else if (/table delta generation failed|comparetablesgeneratedelta/i.test(lower)) {
    resolutionSteps = [
      "Confirm both source and target databases are reachable with the selected profiles.",
      "Verify the table exists in the source database and has not been renamed or dropped.",
      "Check the task log for the specific table or column that triggered the delta failure.",
    ];
  } else if (/canonical source artifact validation failed/i.test(lower)) {
    resolutionSteps = [
      "Re-run Backup or Code Diff to regenerate clean source artifacts before deploying.",
      "If the error mentions a deploy-only wrapper (CREATE OR ALTER, IF OBJECT_ID), the generated file is not a canonical source — regenerate it.",
      "Ensure the source object exists and is scriptable in the source database.",
    ];
  } else if (/no valid objects supplied|requires at least one object/i.test(lower)) {
    resolutionSteps = [
      "Select at least one object in the Object Selection tab before running this operation.",
      "If the object list was loaded from a file, verify the file format: one schema.name per line, or TYPE,schema,name.",
    ];
  } else if (/cannot connect|network-related|instance-specific/i.test(lower)) {
    resolutionSteps = [
      "Verify the SQL Server hostname and port in the connection profile.",
      "Ensure the SQL Server service is running and accepting TCP connections.",
      "Check firewall rules, VPN access, and named-instance settings (e.g., SERVER\\INSTANCE).",
    ];
  }

  return {
    status,
    error: message,
    resolutionSteps: uniqueSteps(resolutionSteps),
  };
}

module.exports = {
  buildClientError,
};