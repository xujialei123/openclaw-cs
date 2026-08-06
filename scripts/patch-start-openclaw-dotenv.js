"use strict";
/**
 * Patch Start-OpenClaw.ps1 to load data\.openclaw\.env before gateway start.
 * Usage: node scripts/patch-start-openclaw-dotenv.js <path-to-Start-OpenClaw.ps1>
 */
const fs = require("fs");
const path = require("path");

const target = process.argv[2];
if (!target || !fs.existsSync(target)) {
  console.error("Usage: node patch-start-openclaw-dotenv.js <Start-OpenClaw.ps1>");
  process.exit(1);
}

let raw = fs.readFileSync(target, "utf8");
if (raw.includes("Import-OpenClawDotEnv")) {
  console.log("already patched:", target);
  process.exit(0);
}

const fn = `
function Import-OpenClawDotEnv([string]$EnvFile) {
  if (-not (Test-Path -LiteralPath $EnvFile)) { return }
  Get-Content -LiteralPath $EnvFile -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $eq = $line.IndexOf("=")
    if ($eq -lt 1) { return }
    $k = $line.Substring(0, $eq).Trim()
    $v = $line.Substring($eq + 1).Trim().Trim('"').Trim("'")
    if ($k) { [Environment]::SetEnvironmentVariable($k, $v, "Process") }
  }
}

`;

raw = raw.replace(/(\$ErrorActionPreference\s*=\s*"Stop"\s*\r?\n)/, `$1${fn}`);

const loadCalls =
  "Import-OpenClawDotEnv (Join-Path $StateDir '.env')\r\n" +
  "Import-OpenClawDotEnv (Join-Path $Root '.env')\r\n";

if (!/\$env:OPENCLAW_HOME\s*=\s*\$DataDir/.test(raw)) {
  console.error("anchor OPENCLAW_HOME not found");
  process.exit(1);
}
raw = raw.replace(/(\$env:OPENCLAW_HOME\s*=\s*\$DataDir\s*\r?\n)/, `$1${loadCalls}`);

fs.writeFileSync(target, raw, "utf8");
console.log("patched:", target);
