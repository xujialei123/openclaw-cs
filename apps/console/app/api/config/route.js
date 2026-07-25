import { createRequire } from "module";
import { NextResponse } from "next/server";

const require = createRequire(import.meta.url);
const { loadRuntime, saveRuntime } = require("../../../lib/runtime");
const { validateRuntimeConfig } = require("@openclaw/runtime-config");

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rt = loadRuntime();
    return NextResponse.json({
      ok: true,
      knowledge: rt.knowledge,
      whitelist: rt.whitelist,
      whitelistOnly: rt.whitelistOnly === true,
      onlyActionable: rt.onlyActionable !== false,
      autoSend: rt.autoSend !== false,
      platforms: rt.platforms,
      systems: rt.systems,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e.message || e) }, { status: 500 });
  }
}

export async function PUT(request) {
  try {
    const body = await request.json();
    const rt = loadRuntime();
    if (body.knowledge) {
      rt.knowledge = { ...(rt.knowledge || {}), ...body.knowledge };
      if (body.knowledge.rag) {
        rt.knowledge.rag = { ...(rt.knowledge.rag || {}), ...body.knowledge.rag };
      }
    }
    if (body.whitelist) rt.whitelist = { ...(rt.whitelist || {}), ...body.whitelist };
    if (Object.prototype.hasOwnProperty.call(body, "whitelistOnly")) {
      rt.whitelistOnly = body.whitelistOnly === true;
      rt.platforms = rt.platforms || {};
      for (const name of ["meituan", "douyin"]) {
        rt.platforms[name] = rt.platforms[name] || {};
        rt.platforms[name].whitelistOnly = rt.whitelistOnly;
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, "onlyActionable")) {
      rt.onlyActionable = body.onlyActionable !== false;
    }
    if (Object.prototype.hasOwnProperty.call(body, "autoSend")) {
      rt.autoSend = body.autoSend !== false;
    }
    if (body.platforms) {
      rt.platforms = rt.platforms || {};
      for (const name of ["meituan", "douyin"]) {
        if (!body.platforms[name]) continue;
        rt.platforms[name] = { ...(rt.platforms[name] || {}), ...body.platforms[name] };
      }
    }
    if (body.systems?.order) {
      rt.systems = rt.systems || {};
      const prev = rt.systems.order || {};
      rt.systems.order = {
        ...prev,
        ...body.systems.order,
        intentAi: {
          ...(prev.intentAi || {}),
          ...(body.systems.order.intentAi || {}),
        },
      };
    }
    const checked = validateRuntimeConfig(rt);
    if (!checked.ok) {
      return NextResponse.json({ ok: false, errors: checked.errors }, { status: 400 });
    }
    saveRuntime(checked.value);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e.message || e) }, { status: 500 });
  }
}
