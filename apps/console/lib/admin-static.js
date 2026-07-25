import { createRequire } from "module";
import fs from "fs";
import path from "path";

const require = createRequire(import.meta.url);
const { REPO_ROOT } = require("./runtime");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILES = {
  guide: { file: "guide.html", type: "text/html; charset=utf-8" },
  "dev-flow": { file: "dev-flow.html", type: "text/html; charset=utf-8" },
  "project-map": { file: "project-map.html", type: "text/html; charset=utf-8" },
  deploy: { file: "deploy.html", type: "text/html; charset=utf-8" },
  "docs.css": { file: "docs.css", type: "text/css; charset=utf-8" },
  "docs-render.js": { file: "docs-render.js", type: "application/javascript; charset=utf-8" },
};

export function serveAdminFile(key) {
  const meta = FILES[key];
  if (!meta) return new Response("not found", { status: 404 });
  const fp = path.join(REPO_ROOT, "admin", meta.file);
  if (!fs.existsSync(fp)) return new Response("not found", { status: 404 });
  return new Response(fs.readFileSync(fp), {
    headers: { "Content-Type": meta.type },
  });
}
