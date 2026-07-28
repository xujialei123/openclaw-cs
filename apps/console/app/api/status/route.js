import { createRequire } from "module";
import { NextResponse } from "next/server";

const require = createRequire(import.meta.url);
const { loadRuntime } = require("../../../lib/runtime");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function ping(url, timeoutMs = 2500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export async function GET() {
  try {
    const rt = loadRuntime();
    const kb = rt.knowledge || {};
    const ragBase = String(kb.rag?.baseUrl || "http://127.0.0.1:8787").replace(/\/$/, "");
    const ragOnline = await ping(`${ragBase}/health`);
    const completed = rt.setup?.wizardCompleted === true;
    const portableHint = Boolean(process.env.OPENCLAW_PORTABLE_ROOT);
    const ragOk = Boolean(String(kb.rag?.baseUrl || process.env.RAG_BASE_URL || "").trim());
    const needsSetup = !completed && (!portableHint || !ragOk);
    return NextResponse.json({
      ok: true,
      mode: kb.mode || "local",
      ragOnline,
      ragBaseUrl: ragBase,
      needsSetup,
      setup: { wizardCompleted: completed, needsSetup },
      config: {
        knowledge: kb,
        whitelist: rt.whitelist,
        whitelistOnly: rt.whitelistOnly === true,
        onlyActionable: rt.onlyActionable !== false,
        autoSend: rt.autoSend !== false,
        setup: rt.setup || { wizardCompleted: false },
        platforms: {
          meituan: {
            enabled: rt.platforms?.meituan?.enabled !== false,
            autoSend: rt.platforms?.meituan?.autoSend !== false && rt.autoSend !== false,
          },
          douyin: {
            enabled: rt.platforms?.douyin?.enabled !== false,
            autoSend: rt.platforms?.douyin?.autoSend !== false && rt.autoSend !== false,
          },
        },
        systems: {
          order: {
            enabled: rt.systems?.order?.enabled === true,
            baseUrl: rt.systems?.order?.baseUrl || "",
            urlIncludes: rt.systems?.order?.urlIncludes || "",
            pathIncludes: rt.systems?.order?.pathIncludes || "",
            intentMode: rt.systems?.order?.intentMode || "ai+rules",
            maxResults: rt.systems?.order?.maxResults ?? 5,
            freeTextKeyword: rt.systems?.order?.freeTextKeyword !== false,
            timeoutMs: rt.systems?.order?.timeoutMs ?? 28000,
            intentAi: rt.systems?.order?.intentAi || { provider: "auto" },
          },
        },
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e.message || e) }, { status: 500 });
  }
}
