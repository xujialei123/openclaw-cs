"use strict";
/** Fix electron path.txt (PowerShell Set-Content often writes UTF-8 BOM → spawn ENOENT). */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "node_modules", "electron");
const pathFile = path.join(root, "path.txt");
const exe = path.join(root, "dist", "electron.exe");
const versionFile = path.join(root, "dist", "version");

if (!fs.existsSync(exe)) {
  console.error("Electron binary missing:", exe);
  console.error("Reinstall with: $env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; npm install --prefix apps/desktop");
  process.exit(1);
}

fs.writeFileSync(pathFile, "electron.exe", { encoding: "ascii" });
if (!fs.existsSync(versionFile)) {
  try {
    const ver = require(path.join(root, "package.json")).version;
    fs.writeFileSync(versionFile, ver, { encoding: "ascii" });
  } catch {
    /* ignore */
  }
}
