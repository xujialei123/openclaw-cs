/**
 * @file apps/edge-worker/chat-trace.js
 * @description 客服对话排查日志：顾客消息 → 查单/知识库/LLM → 回复/是否发出
 * 落盘：memory/chat-trace.jsonl（一行一条 JSON）
 */
"use strict";

const fs = require("fs");
const path = require("path");

const MAX_FILE_BYTES = 8 * 1024 * 1024; // ~8MB 后轮转
const DEFAULT_LIMIT = 80;

function defaultTracePath(projectRoot) {
  return path.join(projectRoot || process.cwd(), "memory", "chat-trace.jsonl");
}

function beginTrace({ platform, customer, inbound, sessionKey }) {
  return {
    id: `ct_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    platform: String(platform || ""),
    customer: String(customer || "").slice(0, 80),
    sessionKey: String(sessionKey || "").slice(0, 120),
    inbound: String(inbound || "").slice(0, 800),
    path: "",
    kb: null,
    order: null,
    llm: null,
    scenario: null,
    reply: "",
    escalate: false,
    sent: null,
    holdReason: "",
    error: "",
  };
}

/**
 * 把 generateReply 的原始返回统一成带 _chatTrace 的对象（便于下游落盘）。
 */
function seal(trace, result, patch) {
  if (patch && typeof patch === "object") Object.assign(trace, patch);
  let escalate = false;
  let reply = "";
  if (result && typeof result === "object") {
    escalate = !!result.escalate;
    reply = String(result.reply || "");
  } else {
    reply = String(result || "");
  }
  if (!trace.path) {
    if (escalate) trace.path = "escalate";
    else if (trace.order) trace.path = "order";
    else if (trace.scenario) trace.path = "scenario";
    else if (trace.kb && trace.kb.hit) trace.path = "kb";
    else if (trace.llm && trace.llm.used) trace.path = "llm";
    else trace.path = "fallback";
  }
  trace.escalate = escalate;
  trace.reply = reply.slice(0, 800);
  return {
    escalate,
    reply,
    _chatTrace: trace,
  };
}

function resolveTraceFile(cfg) {
  if (cfg?.chatTraceFile) return cfg.chatTraceFile;
  if (cfg?.logFile) return path.join(path.dirname(cfg.logFile), "chat-trace.jsonl");
  return defaultTracePath();
}

function rotateIfNeeded(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const st = fs.statSync(filePath);
    if (st.size < MAX_FILE_BYTES) return;
    const bak = filePath.replace(/\.jsonl$/i, "") + `.${Date.now()}.bak.jsonl`;
    fs.renameSync(filePath, bak);
  } catch {
    /* ignore */
  }
}

function appendChatTrace(cfg, entry) {
  if (!entry || typeof entry !== "object") return;
  const filePath = resolveTraceFile(cfg);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    rotateIfNeeded(filePath);
    const line = JSON.stringify({
      ...entry,
      at: entry.at || new Date().toISOString(),
      inbound: String(entry.inbound || "").slice(0, 800),
      reply: String(entry.reply || "").slice(0, 800),
    });
    fs.appendFileSync(filePath, line + "\n", "utf8");
  } catch {
    /* ignore disk errors */
  }
}

/** 回复已决定后落盘（含是否发出） */
function commitChatTrace(cfg, norm, extra = {}) {
  const base =
    (norm && norm._chatTrace) ||
    beginTrace({
      platform: extra.platform,
      customer: extra.customer,
      inbound: extra.inbound,
      sessionKey: extra.sessionKey,
    });
  appendChatTrace(cfg, {
    ...base,
    reply: String(norm?.reply || base.reply || "").slice(0, 800),
    escalate: !!(norm && norm.escalate),
    sent: extra.sent == null ? null : !!extra.sent,
    holdReason: String(extra.holdReason || "").slice(0, 120),
    sessionKey: extra.sessionKey || base.sessionKey || "",
    customer: extra.customer || base.customer || "",
    platform: extra.platform || base.platform || "",
    error: String(extra.error || base.error || "").slice(0, 200),
  });
}

function readChatTraces(filePath, { limit = DEFAULT_LIMIT, platform = "", q = "" } = {}) {
  const abs = filePath || defaultTracePath();
  if (!fs.existsSync(abs)) {
    return { ok: true, file: abs, items: [], total: 0 };
  }
  const raw = fs.readFileSync(abs, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const plat = String(platform || "").toLowerCase();
  const query = String(q || "").trim().toLowerCase();
  const items = [];
  for (let i = lines.length - 1; i >= 0 && items.length < Math.max(1, Math.min(500, limit)); i--) {
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (plat && String(row.platform || "").toLowerCase() !== plat) continue;
    if (query) {
      const blob = `${row.inbound || ""} ${row.reply || ""} ${row.customer || ""} ${row.path || ""}`.toLowerCase();
      if (!blob.includes(query)) continue;
    }
    items.push(row);
  }
  return { ok: true, file: abs, items, total: lines.length };
}

module.exports = {
  beginTrace,
  seal,
  appendChatTrace,
  commitChatTrace,
  readChatTraces,
  defaultTracePath,
  resolveTraceFile,
};
