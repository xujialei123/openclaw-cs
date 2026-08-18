import { createRequire } from "module";
import path from "path";
import { NextResponse } from "next/server";

const require = createRequire(import.meta.url);
const { REPO_ROOT, loadRuntime } = require("../../../lib/runtime");
const { readChatTraces, defaultTracePath } = require(path.join(REPO_ROOT, "apps", "edge-worker", "chat-trace"));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const rt = loadRuntime();
    const file = rt.chatTraceFile || defaultTracePath(REPO_ROOT);
    const limit = Number(url.searchParams.get("limit") || 80);
    const platform = url.searchParams.get("platform") || "";
    const q = url.searchParams.get("q") || "";
    return NextResponse.json(readChatTraces(file, { limit, platform, q }));
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e.message || e) }, { status: 500 });
  }
}
