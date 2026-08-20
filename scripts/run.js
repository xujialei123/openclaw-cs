#!/usr/bin/env node
/**
 * Cross-platform launcher for OpenClaw CS scripts
 * Auto-detects OS and runs the appropriate script
 */

const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const SCRIPTS = path.resolve(__dirname)

// Get all CLI args (skip node and this script)
const args = process.argv.slice(2)
if (args.length === 0) {
    console.error('Usage: node scripts/run.js <script-name> [args...]')
    console.error('')
    console.error('Available scripts:')
    console.error('  start    - Start all services')
    console.error('  start:mid- Start mid-platform only')
    console.error('  stop     - Stop all services')
    console.error('  edge     - Start cs-watch (edge worker)')
    console.error('  wecom    - Start WeCom bridge')
    process.exit(1)
}

const scriptName = args[0]
const scriptArgs = args.slice(1)

// Map script names to actual files
const scriptMap = {
    start: 'Start-All',
    'start:all': 'Start-All',
    'start:mid': 'start-mid',
    stop: 'Stop-All',
    'stop:all': 'Stop-All',
    'stop:mid': 'stop-mid',
    edge: 'cs-watch',
    wecom: 'index',
}

const baseName = scriptMap[scriptName] || scriptName

// Detect OS
const isWindows = process.platform === 'win32'
const isLinux = process.platform === 'linux'

let scriptPath
let cmd
let cmdArgs

if (isWindows) {
    // Windows: use PowerShell
    scriptPath = path.join(SCRIPTS, `${baseName}.ps1`)
    cmd = 'powershell'
    cmdArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...scriptArgs]
} else if (isLinux) {
    // Linux: use bash
    scriptPath = path.join(SCRIPTS, `${baseName}.sh`)
    cmd = 'bash'
    cmdArgs = [scriptPath, ...scriptArgs]
} else {
    console.error(`Unsupported platform: ${process.platform}`)
    process.exit(1)
}

// Check if script exists
if (!fs.existsSync(scriptPath)) {
    console.error(`Script not found: ${scriptPath}`)
    process.exit(1)
}

// Execute
console.log(
    `[${isWindows ? 'Windows' : isLinux ? 'Linux' : 'Other'}] Running: ${cmd} ${scriptPath}`,
)
const child = spawn(cmd, cmdArgs, {
    cwd: ROOT,
    stdio: 'inherit',
})

child.on('close', (code) => {
    process.exit(code || 0)
})
