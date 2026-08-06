/**
 * @file apps/wecom-bridge/index.js
 * @description 企业微信「智能机器人」长连接桥：收私聊 / 群@ → generateReply（含自动查单）→ 回复
 *
 * 配置：config/cs-runtime.json → platforms.wecom
 * 密钥优先环境变量：WECOM_AIBOT_ID / WECOM_AIBOT_SECRET
 *
 * @usage
 *   node apps/wecom-bridge/index.js
 *   npm run wecom -w @openclaw/wecom-bridge
 */

const fs = require("fs");
const path = require("path");
const AiBot = require("@wecom/aibot-node-sdk");
const { generateReqId } = require("@wecom/aibot-node-sdk");

const {
  PROJECT_ROOT,
  loadRuntimeConfig,
  generateReply,
  normalizeReplyResult,
  fireEscalateNotify,
} = require("../edge-worker/cs-watch.js");
const escalateNotify = (() => {
  try {
    return require("../edge-worker/escalate-notify");
  } catch {
    return null;
  }
})();

const args = process.argv.slice(2);
const cfgIdx = args.indexOf("--config");
const configPath =
  (cfgIdx >= 0 && args[cfgIdx + 1]) ||
  process.env.CS_RUNTIME_CONFIG ||
  path.join(PROJECT_ROOT, "config", "cs-runtime.json");

/** chatid → 最近顾客原文（给查单上下文：先发单号再发「查一下」） */
const recentByChat = new Map();
const MAX_RECENT = 8;
/** msgid 去重 */
const seenMsgIds = new Map();
const SEEN_TTL_MS = 10 * 60 * 1000;

function log(...parts) {
  const line = `[${new Date().toISOString()}] WECOM ${parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")}`;
  console.log(line);
  try {
    const cfg = loadRuntimeConfig(configPath);
    const lf = cfg.logFile || path.join(PROJECT_ROOT, "memory", "cs-watch.log");
    fs.mkdirSync(path.dirname(lf), { recursive: true });
    fs.appendFileSync(lf, line + "\n", "utf8");
  } catch {
    /* ignore */
  }
}

function wecomCfgOf(cfg) {
  const w = cfg.platforms?.wecom || {};
  return {
    enabled: w.enabled === true,
    botId: String(process.env.WECOM_AIBOT_ID || w.botId || "").trim(),
    secret: String(process.env.WECOM_AIBOT_SECRET || w.secret || "").trim(),
    onlyWhenMentionedInGroup: w.onlyWhenMentionedInGroup !== false,
    welcomeText:
      w.welcomeText ||
      "在的，我是门店智能客服。查订单、问套餐、门店地址都可以直接说；群里请 @ 我再提问。",
    replyTimeoutMs: Number(w.replyTimeoutMs) || 55000,
  };
}

function rememberRecent(chatKey, text) {
  if (!chatKey || !text) return;
  const list = recentByChat.get(chatKey) || [];
  list.push(String(text).slice(0, 200));
  while (list.length > MAX_RECENT) list.shift();
  recentByChat.set(chatKey, list);
}

function getRecent(chatKey) {
  return recentByChat.get(chatKey) || [];
}

function markSeen(msgid) {
  if (!msgid) return false;
  const now = Date.now();
  for (const [k, t] of seenMsgIds) {
    if (now - t > SEEN_TTL_MS) seenMsgIds.delete(k);
  }
  if (seenMsgIds.has(msgid)) return true;
  seenMsgIds.set(msgid, now);
  return false;
}

/** 去掉群 @ 机器人占位，留下顾客真正问的话 */
function stripMention(text) {
  let s = String(text || "");
  s = s.replace(/@\S+/g, " ");
  s = s.replace(/\u200b/g, "");
  return s.replace(/\s+/g, " ").trim();
}

function extractTextFromBody(body) {
  if (!body || typeof body !== "object") return "";
  if (body.msgtype === "text" && body.text?.content) return String(body.text.content);
  if (body.text?.content) return String(body.text.content);
  if (typeof body.content === "string") return body.content;
  // mixed
  if (Array.isArray(body.mixed?.msg_item)) {
    return body.mixed.msg_item
      .map((it) => (it?.msgtype === "text" ? it.text?.content || "" : ""))
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function frameMeta(frame) {
  const body = frame?.body || frame?.payload || {};
  const headers = frame?.headers || {};
  const msgid = body.msgid || headers.msgid || headers.req_id || "";
  const chattype = String(body.chattype || body.chat_type || "single").toLowerCase();
  const chatid = body.chatid || body.chat_id || body.from?.userid || "";
  const userid = body.from?.userid || body.userid || "";
  const raw = extractTextFromBody(body);
  return { body, headers, msgid, chattype, chatid, userid, raw };
}

async function handleTextFrame(wsClient, cfg, frame) {
  const wcfg = wecomCfgOf(cfg);
  const meta = frameMeta(frame);
  if (markSeen(meta.msgid)) {
    log("skip duplicate", meta.msgid);
    return;
  }

  const isGroup = meta.chattype === "group";
  let text = stripMention(meta.raw);
  if (!text) {
    log("skip empty text", meta.chattype, meta.chatid);
    return;
  }

  const chatKey = meta.chatid || meta.userid || "unknown";
  const recent = getRecent(chatKey).map((t) => `[顾客] ${t}`);
  rememberRecent(chatKey, text);

  log("recv", isGroup ? "group" : "single", String(chatKey).slice(0, 24), text.slice(0, 60));

  const streamId = generateReqId("stream");
  try {
    await wsClient.replyStream(frame, streamId, "正在处理…", false);
  } catch (e) {
    log("stream-start fail", String(e.message || e).slice(0, 80));
  }

  let reply = "在的，稍等我帮您看一下。";
  try {
    const raw = await Promise.race([
      generateReply(cfg, {
        platform: "wecom",
        customer: meta.userid || chatKey,
        lastCustomerMsg: text,
        recent,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("reply-timeout")), wcfg.replyTimeoutMs)),
    ]);
    const norm = normalizeReplyResult(raw);
    reply = norm.reply || reply;
    if (norm.escalate) {
      reply = reply || "这个问题我先帮您转人工核实，请稍等。";
    }
    if (escalateNotify && escalateNotify.shouldNotifyEscalation(norm.escalate, reply)) {
      fireEscalateNotify(cfg, {
        platform: "wecom",
        customer: meta.userid || chatKey,
        sessionKey: chatKey,
        shop: meta.chattype === "group" ? `group:${meta.chatid || ""}` : "dm",
        lastCustomerMsg: text,
        reply,
        escalate: !!norm.escalate,
        reason: norm.escalate ? "escalate" : "reply-mentions-handoff",
      });
    }
  } catch (e) {
    log("generateReply fail", String(e.message || e).slice(0, 120));
    reply = "亲，这边处理超时了，请稍后再试，或把订单号发我我帮您查。";
  }

  // 企微单条流式内容有长度限制，截断保底
  if (reply.length > 3500) reply = reply.slice(0, 3490) + "…";

  try {
    await wsClient.replyStream(frame, streamId, reply, true);
    log("sent", reply.slice(0, 80));
  } catch (e) {
    log("reply fail", String(e.message || e).slice(0, 120));
  }
}

function main() {
  if (!fs.existsSync(configPath)) {
    console.error("config missing:", configPath);
    process.exit(1);
  }

  let cfg = loadRuntimeConfig(configPath);
  let wcfg = wecomCfgOf(cfg);
  if (!wcfg.enabled) {
    console.error("platforms.wecom.enabled is not true — set it in cs-runtime.json");
    process.exit(1);
  }
  if (!wcfg.botId || !wcfg.secret) {
    console.error("Missing WECOM_AIBOT_ID / WECOM_AIBOT_SECRET (or platforms.wecom.botId/secret)");
    process.exit(1);
  }

  const wsClient = new AiBot.WSClient({
    botId: wcfg.botId,
    secret: wcfg.secret,
  });

  wsClient.on("connected", () => log("ws connected"));
  wsClient.on("disconnected", (reason) => log("ws disconnected", reason || ""));
  wsClient.on("error", (err) => log("ws error", String(err?.message || err).slice(0, 160)));

  wsClient.on("message.text", (frame) => {
    cfg = loadRuntimeConfig(configPath);
    handleTextFrame(wsClient, cfg, frame).catch((e) => log("handler", String(e.message || e)));
  });

  wsClient.on("message.mixed", (frame) => {
    cfg = loadRuntimeConfig(configPath);
    handleTextFrame(wsClient, cfg, frame).catch((e) => log("handler", String(e.message || e)));
  });

  wsClient.on("event.enter_chat", (frame) => {
    cfg = loadRuntimeConfig(configPath);
    const welcome = wecomCfgOf(cfg).welcomeText;
    wsClient
      .replyWelcome(frame, { msgtype: "text", text: { content: welcome } })
      .then(() => log("welcome sent"))
      .catch((e) => log("welcome fail", String(e.message || e).slice(0, 80)));
  });

  log("START", "config=", configPath, "botId=", wcfg.botId.slice(0, 12) + "…");
  wsClient.connect();
}

main();
