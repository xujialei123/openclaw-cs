/**
 * @file scripts/kb-admin-server.js
 * @module 边端配置页薄网关（转发骨架 rag-service，不存生产向量）
 * @description
 *   - 白名单 / knowledge.mode / rag.* 写本地 cs-runtime.json
 *   - GET/PUT /api/env 读写根目录 .env 与 brain/.env（白名单键；密钥不回传明文）
 *   - 上传 / 编译 / KB 列表 / 试检索 → 8787
 *   - local 降级时仍可触发本机 kb-wiki / kb-index
 *
 * @usage
 *   node scripts/kb-admin-server.js
 *   node scripts/kb-admin-server.js --port 18790
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const ROOT = path.join(__dirname, "..");
const DEFAULT_CONFIG = path.join(ROOT, "config", "cs-runtime.json");
const ADMIN_HTML = path.join(ROOT, "admin", "index.html");
const ADMIN_DIR = path.join(ROOT, "admin");
const DOCS_DIR = path.join(ROOT, "docs");
const EDGE_ENV = path.join(ROOT, ".env");
const BRAIN_ENV = path.join(ROOT, "brain", ".env");

const EDGE_ENV_KEYS = [
  "DEPLOY_ROLE",
  "OPENCLAW_PORTABLE_ROOT",
  "BRAIN_ROOT",
  "ADMIN_PORT",
  "OPENCLAW_GATEWAY_URL",
  "OPENCLAW_CDP_URL",
  "RAG_BASE_URL",
  "RAG_API_KEY",
];
const BRAIN_ENV_KEYS = [
  "DATABASE_URL",
  "REDIS_URL",
  "RAG_SERVICE_PORT",
  "RAG_API_KEY",
  "VECTOR_STORE",
  "VECTOR_DIM",
  "EMBEDDING_PROVIDER",
  "EMBEDDING_BASE_URL",
  "EMBEDDING_API_KEY",
  "EMBEDDING_MODEL",
  "EMBEDDING_DIM",
];
const SECRET_ENV_KEYS = new Set([
  "RAG_API_KEY",
  "EMBEDDING_API_KEY",
  "DATABASE_URL",
  "ADMIN_PASSWORD",
  "LLM_API_KEY",
  "AGNES_API_KEY",
]);

function parseDotEnv(text) {
  const map = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    let v = line.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    map[line.slice(0, eq).trim()] = v;
  }
  return map;
}

function upsertDotEnv(filePath, patch, allowKeys) {
  const prev = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const lines = prev ? prev.split(/\r?\n/) : [];
  const seen = new Set();
  const next = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) {
      next.push(line);
      continue;
    }
    const eq = t.indexOf("=");
    const key = t.slice(0, eq).trim();
    if (allowKeys.includes(key) && Object.prototype.hasOwnProperty.call(patch, key)) {
      const val = patch[key];
      if (val === "" || val == null) {
        // empty = keep existing
        next.push(line);
      } else {
        next.push(`${key}=${val}`);
      }
      seen.add(key);
    } else {
      next.push(line);
    }
  }
  for (const key of allowKeys) {
    if (seen.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const val = patch[key];
    if (val === "" || val == null) continue;
    next.push(`${key}=${val}`);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let out = next.join("\n");
  if (!out.endsWith("\n")) out += "\n";
  fs.writeFileSync(filePath, out, "utf8");
}

function maskEnvValue(key, value) {
  if (value == null || value === "") return "";
  if (!SECRET_ENV_KEYS.has(key)) return value;
  if (String(value).length <= 4) return "***";
  return "***SET***";
}

function publicEnvView(filePath, allowKeys) {
  const map = fs.existsSync(filePath) ? parseDotEnv(fs.readFileSync(filePath, "utf8")) : {};
  const out = {};
  for (const k of allowKeys) {
    out[k] = {
      value: SECRET_ENV_KEYS.has(k) ? "" : map[k] || "",
      set: Boolean(map[k]),
      masked: maskEnvValue(k, map[k] || ""),
    };
  }
  return out;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function sendFile(res, filePath, contentType) {
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": contentType || "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function safeJoin(root, rel) {
  const full = path.normalize(path.join(root, rel));
  if (!full.startsWith(path.normalize(root + path.sep)) && full !== path.normalize(root)) {
    return null;
  }
  return full;
}

const { retrieve, retrieveLocal, pingRag, httpJson, buildIndex } = require("../apps/edge-worker/kb-retrieve");
const { buildWiki } = require("../apps/edge-worker/kb-wiki");
const { validateRuntimeConfig } = require("../packages/runtime-config");

function loadJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 4) + "\n", "utf8");
}

function parseArgs(argv) {
  const out = { port: 18790, config: DEFAULT_CONFIG, host: "127.0.0.1" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") out.port = Number(argv[++i] || 18790);
    else if (argv[i] === "--config") out.config = String(argv[++i] || DEFAULT_CONFIG);
    else if (argv[i] === "--host") out.host = String(argv[++i] || "127.0.0.1");
  }
  return out;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function deepMerge(target, patch) {
  if (!patch || typeof patch !== "object") return target;
  for (const [k, v] of Object.entries(patch)) {
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof target[k] === "object" &&
      target[k] &&
      !Array.isArray(target[k])
    ) {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

function ragCfg(runtime) {
  return runtime.knowledge?.rag || {};
}

function ragBase(runtime) {
  return String(ragCfg(runtime).baseUrl || "http://127.0.0.1:8787").replace(/\/$/, "");
}

function ragHeaders(runtime, extra = {}) {
  return {
    "x-api-key": ragCfg(runtime).apiKey || "local-dev-key",
    ...extra,
  };
}

async function ragFetch(runtime, pathName, opts = {}) {
  const url = `${ragBase(runtime)}${pathName}`;
  return httpJson(url, {
    method: opts.method || "GET",
    headers: ragHeaders(runtime, opts.headers || {}),
    body: opts.body,
    timeoutMs: Number(ragCfg(runtime).timeoutMs) || 20000,
  });
}

/** multipart 上传到骨架（boundary 透传） */
async function ragUploadFile(runtime, kbId, filename, contentBuf, ingest = true) {
  const boundary = "----OpenClawBoundary" + Date.now();
  const name = path.basename(filename || "upload.md");
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${name}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(head, "utf8"), contentBuf, Buffer.from(tail, "utf8")]);
  const endpoint = ingest
    ? `/api/kb/${encodeURIComponent(kbId)}/upload-and-ingest`
    : `/api/kb/${encodeURIComponent(kbId)}/upload`;

  const u = new URL(`${ragBase(runtime)}${endpoint}`);
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname,
        method: "POST",
        headers: {
          "x-api-key": ragCfg(runtime).apiKey || "local-dev-key",
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {
            /* ignore */
          }
          resolve({ status: res.statusCode || 0, json, raw });
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function createServer(ctx) {
  return http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
      const method = req.method || "GET";
      const runtime = () => loadJson(ctx.configPath, {});

      if (method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(fs.readFileSync(ADMIN_HTML, "utf8"));
        return;
      }

      if (method === "GET" && (u.pathname === "/deploy" || u.pathname === "/deploy.html")) {
        sendFile(res, path.join(ADMIN_DIR, "deploy.html"), MIME[".html"]);
        return;
      }
      if (method === "GET" && (u.pathname === "/project-map" || u.pathname === "/project-map.html")) {
        sendFile(res, path.join(ADMIN_DIR, "project-map.html"), MIME[".html"]);
        return;
      }
      if (method === "GET" && (u.pathname === "/guide" || u.pathname === "/guide.html")) {
        sendFile(res, path.join(ADMIN_DIR, "guide.html"), MIME[".html"]);
        return;
      }
      if (method === "GET" && (u.pathname === "/dev-flow" || u.pathname === "/dev-flow.html")) {
        sendFile(res, path.join(ADMIN_DIR, "dev-flow.html"), MIME[".html"]);
        return;
      }
      if (method === "GET" && (u.pathname === "/docs.css" || u.pathname === "/docs-render.js")) {
        const name = u.pathname.slice(1);
        const fp = path.join(ADMIN_DIR, name);
        if (!fs.existsSync(fp)) {
          sendJson(res, 404, { ok: false, error: "not found" });
          return;
        }
        sendFile(res, fp, MIME[path.extname(fp)] || "application/octet-stream");
        return;
      }
      if (method === "GET" && u.pathname.startsWith("/api/docs/")) {
        const name = path.basename(u.pathname);
        if (!/^[a-zA-Z0-9._-]+\.md$/.test(name)) {
          sendJson(res, 400, { ok: false, error: "bad doc name" });
          return;
        }
        const fp = safeJoin(DOCS_DIR, name);
        if (!fp || !fs.existsSync(fp)) {
          sendJson(res, 404, { ok: false, error: "doc not found" });
          return;
        }
        sendFile(res, fp, MIME[".md"]);
        return;
      }

      if (method === "GET" && u.pathname === "/api/status") {
        const rt = runtime();
        const kb = rt.knowledge || {};
        const ragOnline = await pingRag(kb.rag || {});
        let knowledgeBases = [];
        let ragError = null;
        if (ragOnline) {
          const list = await ragFetch(rt, "/api/kb/list");
          if (list.status >= 200 && list.status < 300) {
            knowledgeBases = list.json?.knowledgeBases || [];
          } else {
            ragError = `kb/list HTTP ${list.status}`;
          }
        }
        sendJson(res, 200, {
          ok: true,
          mode: kb.mode || "local",
          fallbackLocal: kb.fallbackLocal !== false,
          ragOnline,
          ragBaseUrl: ragBase(rt),
          ragError,
          knowledgeBases,
          config: {
            knowledge: kb,
            whitelist: rt.whitelist,
            whitelistOnly: rt.whitelistOnly === true,
            onlyActionable: rt.onlyActionable !== false,
            autoSend: rt.autoSend !== false,
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
                channel: rt.systems?.order?.channel || "browser",
                timeoutMs: rt.systems?.order?.timeoutMs ?? 28000,
                settleMs: rt.systems?.order?.settleMs ?? 1800,
                intentAi: {
                  provider: rt.systems?.order?.intentAi?.provider || "auto",
                  model: rt.systems?.order?.intentAi?.model || "",
                  timeoutMs: rt.systems?.order?.intentAi?.timeoutMs ?? 8000,
                },
              },
            },
          },
        });
        return;
      }

      if (method === "GET" && u.pathname === "/api/config") {
        const rt = runtime();
        sendJson(res, 200, {
          ok: true,
          knowledge: rt.knowledge,
          whitelist: rt.whitelist,
          whitelistOnly: rt.whitelistOnly === true,
          onlyActionable: rt.onlyActionable !== false,
          autoSend: rt.autoSend !== false,
          platforms: rt.platforms,
          systems: rt.systems,
        });
        return;
      }

      if (method === "PUT" && u.pathname === "/api/config") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        const rt = runtime();
        if (body.knowledge) deepMerge(rt.knowledge || (rt.knowledge = {}), body.knowledge);
        if (body.whitelist) rt.whitelist = { ...(rt.whitelist || {}), ...body.whitelist };
        if (Object.prototype.hasOwnProperty.call(body, "whitelistOnly")) {
          rt.whitelistOnly = body.whitelistOnly === true;
          // 平台层跟随全局，避免旧 true 卡住
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
        if (body.platforms && typeof body.platforms === "object") {
          rt.platforms = rt.platforms || {};
          for (const name of ["meituan", "douyin"]) {
            if (!body.platforms[name] || typeof body.platforms[name] !== "object") continue;
            rt.platforms[name] = rt.platforms[name] || {};
            const patch = body.platforms[name];
            if (Object.prototype.hasOwnProperty.call(patch, "enabled")) {
              rt.platforms[name].enabled = patch.enabled !== false;
            }
            if (Object.prototype.hasOwnProperty.call(patch, "autoSend")) {
              rt.platforms[name].autoSend = patch.autoSend !== false;
            }
          }
          // 全局 autoSend：任一平台开着发送则为 true（兼容旧日志/脚本）
          const touchedMt = body.platforms.meituan && Object.prototype.hasOwnProperty.call(body.platforms.meituan, "autoSend");
          const touchedDy = body.platforms.douyin && Object.prototype.hasOwnProperty.call(body.platforms.douyin, "autoSend");
          if (touchedMt || touchedDy) {
            const mt = rt.platforms.meituan?.autoSend !== false;
            const dy = rt.platforms.douyin?.autoSend !== false;
            rt.autoSend = mt || dy;
          }
        }
        if (body.systems && typeof body.systems === "object") {
          rt.systems = rt.systems || {};
          if (body.systems.order && typeof body.systems.order === "object") {
            const prev = rt.systems.order || {};
            const patch = body.systems.order;
            const next = { ...prev };
            if (Object.prototype.hasOwnProperty.call(patch, "enabled")) next.enabled = patch.enabled === true;
            if (Object.prototype.hasOwnProperty.call(patch, "baseUrl") && String(patch.baseUrl || "").trim()) {
              next.baseUrl = String(patch.baseUrl).trim();
            }
            if (Object.prototype.hasOwnProperty.call(patch, "urlIncludes")) next.urlIncludes = String(patch.urlIncludes || "").trim();
            if (Object.prototype.hasOwnProperty.call(patch, "pathIncludes")) next.pathIncludes = String(patch.pathIncludes || "").trim();
            if (Object.prototype.hasOwnProperty.call(patch, "intentMode")) {
              const m = String(patch.intentMode || "ai+rules").toLowerCase();
              next.intentMode = ["ai", "rules", "ai+rules"].includes(m) ? m : "ai+rules";
            }
            if (Object.prototype.hasOwnProperty.call(patch, "maxResults")) {
              const n = Number(patch.maxResults);
              if (Number.isFinite(n) && n >= 1 && n <= 20) next.maxResults = Math.floor(n);
            }
            if (Object.prototype.hasOwnProperty.call(patch, "freeTextKeyword")) next.freeTextKeyword = patch.freeTextKeyword !== false;
            if (Object.prototype.hasOwnProperty.call(patch, "channel")) {
              next.channel = String(patch.channel || "browser") === "api" ? "api" : "browser";
            }
            if (Object.prototype.hasOwnProperty.call(patch, "timeoutMs")) {
              const n = Number(patch.timeoutMs);
              if (Number.isFinite(n) && n >= 5000) next.timeoutMs = Math.floor(n);
            }
            if (Object.prototype.hasOwnProperty.call(patch, "settleMs")) {
              const n = Number(patch.settleMs);
              if (Number.isFinite(n) && n >= 0) next.settleMs = Math.floor(n);
            }
            if (patch.intentAi && typeof patch.intentAi === "object") {
              next.intentAi = { ...(prev.intentAi || {}) };
              if (Object.prototype.hasOwnProperty.call(patch.intentAi, "provider")) {
                const p = String(patch.intentAi.provider || "auto").toLowerCase();
                next.intentAi.provider = ["auto", "gateway", "openai-compatible"].includes(p) ? p : "auto";
              }
              if (Object.prototype.hasOwnProperty.call(patch.intentAi, "model")) {
                next.intentAi.model = String(patch.intentAi.model || "").trim();
              }
              if (Object.prototype.hasOwnProperty.call(patch.intentAi, "timeoutMs")) {
                const n = Number(patch.intentAi.timeoutMs);
                if (Number.isFinite(n) && n >= 2000) next.intentAi.timeoutMs = Math.floor(n);
              }
            }
            rt.systems.order = next;
          }
        }
        const checked = validateRuntimeConfig(rt);
        if (!checked.ok) {
          sendJson(res, 400, { ok: false, errors: checked.errors });
          return;
        }
        saveJson(ctx.configPath, checked.value);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "GET" && u.pathname === "/api/env") {
        sendJson(res, 200, {
          ok: true,
          edgePath: EDGE_ENV,
          brainPath: BRAIN_ENV,
          edge: publicEnvView(EDGE_ENV, EDGE_ENV_KEYS),
          brain: publicEnvView(BRAIN_ENV, BRAIN_ENV_KEYS),
          note: "密钥字段 GET 不回传明文；保存时留空表示不修改。改完需重启 Start-All / rag-service 才完全生效。",
        });
        return;
      }

      if (method === "PUT" && u.pathname === "/api/env") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        const edgePatch = {};
        const brainPatch = {};
        for (const k of EDGE_ENV_KEYS) {
          if (body.edge && Object.prototype.hasOwnProperty.call(body.edge, k)) edgePatch[k] = body.edge[k];
        }
        for (const k of BRAIN_ENV_KEYS) {
          if (body.brain && Object.prototype.hasOwnProperty.call(body.brain, k)) brainPatch[k] = body.brain[k];
        }
        if (Object.keys(edgePatch).length) upsertDotEnv(EDGE_ENV, edgePatch, EDGE_ENV_KEYS);
        if (Object.keys(brainPatch).length) upsertDotEnv(BRAIN_ENV, brainPatch, BRAIN_ENV_KEYS);

        // sync common keys into cs-runtime.json so UI/config stay aligned
        const rt = runtime();
        rt.knowledge = rt.knowledge || {};
        rt.knowledge.rag = rt.knowledge.rag || {};
        if (edgePatch.RAG_BASE_URL) rt.knowledge.rag.baseUrl = String(edgePatch.RAG_BASE_URL).replace(/\/$/, "");
        if (edgePatch.RAG_API_KEY) rt.knowledge.rag.apiKey = edgePatch.RAG_API_KEY;
        if (brainPatch.RAG_API_KEY && !edgePatch.RAG_API_KEY) rt.knowledge.rag.apiKey = brainPatch.RAG_API_KEY;
        saveJson(ctx.configPath, rt);

        sendJson(res, 200, {
          ok: true,
          restartedHint: "Restart Start-All (or Stop-All then Start-All) to reload env into running processes.",
        });
        return;
      }

      if (method === "POST" && u.pathname === "/api/kb/create") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        const rt = runtime();
        const r = await ragFetch(rt, "/api/kb/create", {
          method: "POST",
          body: {
            name: body.name || "OpenClaw 门店知识库",
            description: body.description || "由 OpenClaw 边端配置页创建",
          },
        });
        if (r.status < 200 || r.status >= 300) {
          sendJson(res, r.status || 502, { error: r.raw || "create kb failed", detail: r.json });
          return;
        }
        const kbId = r.json?.kbId;
        if (kbId) {
          rt.knowledge = rt.knowledge || {};
          rt.knowledge.rag = rt.knowledge.rag || {};
          const ids = Array.isArray(rt.knowledge.rag.kbIds) ? rt.knowledge.rag.kbIds : [];
          if (!ids.includes(kbId)) ids.push(kbId);
          rt.knowledge.rag.kbIds = ids;
          saveJson(ctx.configPath, rt);
        }
        sendJson(res, 200, { ok: true, kbId, raw: r.json });
        return;
      }

      if (method === "POST" && u.pathname === "/api/upload") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        const rt = runtime();
        const kb = rt.knowledge || {};
        const filename = path.basename(String(body.filename || "upload.md"));
        const content = String(body.content || "");
        if (!content.trim()) {
          sendJson(res, 400, { error: "content empty" });
          return;
        }

        // 始终落一份到 local raw，便于 fallbackLocal
        const rawDir = path.join(kb.root || path.join(ROOT, "knowledge"), "raw");
        fs.mkdirSync(rawDir, { recursive: true });
        fs.writeFileSync(path.join(rawDir, filename), content, "utf8");

        const mode = String(kb.mode || "remote").toLowerCase();
        if (mode !== "remote") {
          sendJson(res, 200, { ok: true, mode: "local", filename, note: "saved to knowledge/raw" });
          return;
        }

        let kbId = body.kbId || (kb.rag?.kbIds || [])[0];
        if (!kbId) {
          const created = await ragFetch(rt, "/api/kb/create", {
            method: "POST",
            body: { name: "OpenClaw 默认知识库", description: "自动创建" },
          });
          kbId = created.json?.kbId;
          if (!kbId) {
            sendJson(res, 502, { error: "无法创建知识库，请确认 8787 已启动", detail: created.raw });
            return;
          }
        }

        // 无论新建还是已有 kb：上传/编译后都写回 kbIds，cs-watch 热读即可用
        kb.rag = kb.rag || {};
        const ids = Array.isArray(kb.rag.kbIds) ? kb.rag.kbIds.map(String) : [];
        if (kbId && !ids.includes(kbId)) ids.push(kbId);
        kb.rag.kbIds = ids;
        rt.knowledge = kb;
        saveJson(ctx.configPath, rt);

        const up = await ragUploadFile(rt, kbId, filename, Buffer.from(content, "utf8"), true);
        if (up.status < 200 || up.status >= 300) {
          sendJson(res, up.status || 502, { error: up.raw || "upload failed", filename, kbId });
          return;
        }

        const fileId = up.json?.fileId;
        let compile = null;
        if (fileId && body.compile !== false) {
          const c = await ragFetch(rt, `/api/kb/${encodeURIComponent(kbId)}/files/${encodeURIComponent(fileId)}/compile-brain`, {
            method: "POST",
            body: {
              platform: body.platform || kb.rag?.platform || "all",
              shopId: body.shopId || kb.rag?.shopId || undefined,
            },
          });
          compile = { status: c.status, body: c.json, raw: c.raw };
        }

        sendJson(res, 200, {
          ok: true,
          mode: "remote",
          filename,
          kbId,
          fileId,
          ingest: up.json,
          compile,
          boundKbIds: ids,
        });
        return;
      }

      if (method === "POST" && u.pathname === "/api/compile") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        const rt = runtime();
        const kbId = body.kbId || (rt.knowledge?.rag?.kbIds || [])[0];
        const fileId = body.fileId;
        if (!kbId || !fileId) {
          sendJson(res, 400, { error: "kbId and fileId required" });
          return;
        }
        const c = await ragFetch(
          rt,
          `/api/kb/${encodeURIComponent(kbId)}/files/${encodeURIComponent(fileId)}/compile-brain`,
          {
            method: "POST",
            body: {
              platform: body.platform || rt.knowledge?.rag?.platform || "all",
              shopId: body.shopId || rt.knowledge?.rag?.shopId || undefined,
            },
          }
        );
        sendJson(res, c.status >= 200 && c.status < 300 ? 200 : c.status || 502, {
          ok: c.status >= 200 && c.status < 300,
          ...c.json,
          error: c.status >= 300 ? c.raw : undefined,
        });
        return;
      }

      if (method === "GET" && u.pathname === "/api/files") {
        const rt = runtime();
        const kbId = u.searchParams.get("kbId") || (rt.knowledge?.rag?.kbIds || [])[0];
        if (!kbId) {
          sendJson(res, 200, { ok: true, files: [] });
          return;
        }
        const r = await ragFetch(rt, `/api/kb/${encodeURIComponent(kbId)}/files`);
        sendJson(res, r.status >= 200 && r.status < 300 ? 200 : r.status || 502, {
          ok: r.status >= 200 && r.status < 300,
          kbId,
          files: r.json?.files || [],
          error: r.status >= 300 ? r.raw : undefined,
        });
        return;
      }

      if (method === "GET" && u.pathname === "/api/search") {
        const rt = runtime();
        const kb = rt.knowledge || {};
        const q = u.searchParams.get("q") || "";
        const result = await retrieve(q, {
          mode: kb.mode || "remote",
          rag: kb.rag,
          fallbackLocal: kb.fallbackLocal !== false,
          root: kb.root,
          limit: kb.limit || 3,
          embedding: kb.embedding,
          weights: kb.weights,
          wiki: kb.wiki,
          gateway: rt.gateway,
          platform: kb.rag?.platform,
          shopId: kb.rag?.shopId,
          minScore: 0,
        });
        sendJson(res, 200, result);
        return;
      }

      // local 降级维护
      if (method === "POST" && u.pathname === "/api/local/parse") {
        const rt = runtime();
        const kbRoot = rt.knowledge?.root || path.join(ROOT, "knowledge");
        const wiki = await buildWiki({
          root: kbRoot,
          wiki: rt.knowledge?.wiki || {},
          gateway: rt.gateway,
        });
        sendJson(res, 200, { ok: true, pageCount: wiki.pageCount, generatedCardCount: wiki.generatedCardCount });
        return;
      }

      if (method === "POST" && u.pathname === "/api/local/reindex") {
        const rt = runtime();
        const kbRoot = rt.knowledge?.root || path.join(ROOT, "knowledge");
        const index = await buildIndex(kbRoot, rt.knowledge?.embedding || {}, {
          wiki: rt.knowledge?.wiki || {},
          gateway: rt.gateway,
          skipWiki: false,
        });
        sendJson(res, 200, { ok: true, cardCount: index.cards.length, provider: index.provider });
        return;
      }

      if (method === "POST" && u.pathname === "/api/local/search") {
        const rt = runtime();
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
        const result = await retrieveLocal(body.query || "", {
          root: rt.knowledge?.root,
          limit: rt.knowledge?.limit || 3,
          embedding: rt.knowledge?.embedding,
          weights: rt.knowledge?.weights,
          wiki: rt.knowledge?.wiki,
          gateway: rt.gateway,
          minScore: 0,
        });
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (e) {
      console.error("[kb-admin]", e);
      sendJson(res, 500, { error: e.message || String(e) });
    }
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtime = loadJson(args.config, {});
  const port = Number(runtime.knowledge?.adminPort || args.port || 18790);
  const host = args.host;
  const ctx = { configPath: args.config };
  const server = createServer(ctx);
  server.listen(port, host, () => {
    console.log(`[kb-admin] http://${host}:${port}`);
    console.log(`[kb-admin] guide=http://${host}:${port}/guide`);
    console.log(`[kb-admin] dev-flow=http://${host}:${port}/dev-flow`);
    console.log(`[kb-admin] deploy=http://${host}:${port}/deploy`);
    console.log(`[kb-admin] project-map=http://${host}:${port}/project-map`);
    console.log(`[kb-admin] config=${args.config}`);
    console.log(`[kb-admin] mode=${runtime.knowledge?.mode || "local"} rag=${ragBase(runtime)}`);
    console.log(`[kb-admin] enterprise brain = skeleton rag-service (pgvector); this page is a thin gateway`);
  });
}

if (require.main === module) {
  main();
}

module.exports = { createServer, ragUploadFile };
