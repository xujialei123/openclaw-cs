const fs = require("fs");
const path = require("path");

/** When Next runs, cwd is apps/console; __dirname is unreliable after bundle. */
function resolveRepoRoot() {
  if (process.env.OPENCLAW_PROJECT_ROOT) {
    return path.resolve(process.env.OPENCLAW_PROJECT_ROOT);
  }
  const cwd = process.cwd();
  // typical: started with WorkingDirectory=apps/console
  if (fs.existsSync(path.join(cwd, "package.json")) && fs.existsSync(path.join(cwd, "..", "..", "config", "cs-runtime.json"))) {
    return path.resolve(cwd, "../..");
  }
  // fallback: this file at apps/console/lib (dev / unbundled)
  const fromLib = path.resolve(__dirname, "../..");
  if (fs.existsSync(path.join(fromLib, "config", "cs-runtime.json"))) return fromLib;
  return path.resolve(cwd, "../..");
}

const REPO_ROOT = resolveRepoRoot();

function runtimePath(custom) {
  return custom || path.join(REPO_ROOT, "config", "cs-runtime.json");
}

function loadRuntime(custom) {
  const p = runtimePath(custom);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function saveRuntime(obj, custom) {
  const p = runtimePath(custom);
  fs.writeFileSync(p, JSON.stringify(obj, null, 4) + "\n", "utf8");
}

module.exports = { REPO_ROOT, runtimePath, loadRuntime, saveRuntime, resolveRepoRoot };
