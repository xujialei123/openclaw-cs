/**
 * 把知识库 ID 写回边端 config/cs-runtime.json 的 knowledge.rag.kbIds，
 * 这样上传/编译后 cs-watch 不用手填就能检索。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function resolveRuntimePath(): string | null {
  const fromEnv =
    process.env.CS_RUNTIME_CONFIG ||
    (process.env.OPENCLAW_PROJECT_ROOT
      ? join(process.env.OPENCLAW_PROJECT_ROOT, "config", "cs-runtime.json")
      : "");
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  // dist/services → ../../../.. = openclawProject
  const here = dirname(fileURLToPath(import.meta.url));
  const guess = resolve(here, "../../../../config/cs-runtime.json");
  if (existsSync(guess)) return guess;
  return null;
}

export function bindKbToEdgeRuntime(kbId: string): { ok: boolean; path?: string; kbIds?: string[]; reason?: string } {
  const id = String(kbId || "").trim();
  if (!id) return { ok: false, reason: "empty kbId" };
  const cfgPath = resolveRuntimePath();
  if (!cfgPath) return { ok: false, reason: "cs-runtime.json not found (set OPENCLAW_PROJECT_ROOT)" };
  try {
    const raw = JSON.parse(readFileSync(cfgPath, "utf8"));
    raw.knowledge = raw.knowledge || {};
    raw.knowledge.rag = raw.knowledge.rag || {};
    const ids = Array.isArray(raw.knowledge.rag.kbIds) ? raw.knowledge.rag.kbIds.map(String) : [];
    if (!ids.includes(id)) ids.push(id);
    raw.knowledge.rag.kbIds = ids;
    writeFileSync(cfgPath, JSON.stringify(raw, null, 4) + "\n", "utf8");
    console.log(`[RAG] bound kbId=${id} → ${cfgPath}`);
    return { ok: true, path: cfgPath, kbIds: ids };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[RAG] bind kbId failed: ${msg}`);
    return { ok: false, reason: msg };
  }
}
