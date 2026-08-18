#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");

const mode = String(process.argv[2] || "").toLowerCase(); // stamp | unlock | shortcut
const file = process.argv[3];
if (!file) {
  console.error("Usage: pack-desktop-profile.js <stamp|unlock|shortcut> <product-profile.json>");
  process.exit(1);
}

const abs = path.resolve(file);
const o = JSON.parse(fs.readFileSync(abs, "utf8"));

if (mode === "stamp") {
  o.roleLocked = true;
  o.packedAt = new Date().toISOString();
  fs.writeFileSync(abs, JSON.stringify(o, null, 2) + "\n", "utf8");
  process.stdout.write(String(o.shortcutName || o.displayName || "OpenClaw-CS"));
  process.exit(0);
}

if (mode === "unlock") {
  o.packageKind = "fullstack";
  o.deployRole = "all";
  o.roleLocked = false;
  delete o.packedAt;
  fs.writeFileSync(abs, JSON.stringify(o, null, 2) + "\n", "utf8");
  process.exit(0);
}

if (mode === "shortcut") {
  process.stdout.write(String(o.shortcutName || o.displayName || "OpenClaw-CS"));
  process.exit(0);
}

console.error("Unknown mode: " + mode);
process.exit(1);
