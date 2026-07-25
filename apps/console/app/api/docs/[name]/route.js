import { createRequire } from "module";
import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const require = createRequire(import.meta.url);
const { REPO_ROOT } = require("../../../../lib/runtime");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req, { params }) {
  const name = String(params.name || "");
  if (!/^[a-zA-Z0-9._-]+\.md$/.test(name)) {
    return NextResponse.json({ ok: false, error: "bad doc name" }, { status: 400 });
  }
  const docsDir = path.join(REPO_ROOT, "docs");
  const fp = path.join(docsDir, name);
  if (!fp.startsWith(docsDir) || !fs.existsSync(fp)) {
    return NextResponse.json({ ok: false, error: "doc not found" }, { status: 404 });
  }
  return new NextResponse(fs.readFileSync(fp), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}
