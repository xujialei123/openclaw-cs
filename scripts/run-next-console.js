/**
 * Run Next console with portable Node (avoids npm workspace PATH issues on Windows).
 * Usage: node scripts/run-next-console.js [dev|build|start]
 */
const path = require("path");
const { spawnSync } = require("child_process");

const mode = process.argv[2] || "dev";
const root = path.join(__dirname, "..");
const consoleDir = path.join(root, "apps", "console");
const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");

const args =
  mode === "build"
    ? [nextBin, "build"]
    : mode === "start"
      ? [nextBin, "start", "-p", "18790", "-H", "127.0.0.1"]
      : [nextBin, "dev", "-p", "18790", "-H", "127.0.0.1"];

const r = spawnSync(process.execPath, args, {
  cwd: consoleDir,
  stdio: "inherit",
  env: {
    ...process.env,
    OPENCLAW_PROJECT_ROOT: root,
    NODE_ENV: mode === "build" || mode === "start" ? "production" : "development",
  },
});
process.exit(r.status == null ? 1 : r.status);
