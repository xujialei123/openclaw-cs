/**
 * @file apps/edge-worker/escalate-notify.js
 * @description 客服「转人工 / escalate」时推送到企微内部群（Webhook）。
 *
 * 唯一配置入口：配置中心 → notify.escalate（写入 cs-runtime.json）
 * 企微群：内部群 → 添加群机器人 → 复制 Webhook 地址
 * 文档：https://developer.work.weixin.qq.com/document/path/91770
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");

/** sessionKey → last notify ts */
const cooldownMap = new Map();
const COOLDOWN_MAX_KEYS = 500;

function escalateNotifyCfg(cfg) {
  const n = (cfg && cfg.notify && cfg.notify.escalate) || {};
  const url = String(n.wecomWebhookUrl || n.webhookUrl || "").trim();
  return {
    enabled: n.enabled === true && !!url,
    channel: String(n.channel || "wecom_webhook"),
    webhookUrl: url,
    cooldownSec: Math.max(0, Number(n.cooldownSec) || 300),
    mentionAll: n.mentionAll === true,
    title: String(n.title || "客服升级人工").trim() || "客服升级人工",
  };
}

function shouldNotifyEscalation(escalate, reply) {
  if (escalate) return true;
  const s = String(reply || "");
  return /转人工|升级人工|帮您转人工|【升级】/.test(s);
}

function cooldownKey(info) {
  const p = info.platform || "?";
  const c = info.customer || info.sessionKey || "?";
  return `${p}::${c}`;
}

function underCooldown(key, cooldownSec) {
  if (cooldownSec <= 0) return false;
  const last = cooldownMap.get(key) || 0;
  return Date.now() - last < cooldownSec * 1000;
}

function markCooldown(key) {
  cooldownMap.set(key, Date.now());
  if (cooldownMap.size > COOLDOWN_MAX_KEYS) {
    const first = cooldownMap.keys().next().value;
    if (first != null) cooldownMap.delete(first);
  }
}

function buildMarkdown(cfgNotify, info) {
  const lines = [
    `## ${cfgNotify.title}`,
    `> 时间：${info.at || new Date().toISOString()}`,
    `> 平台：<font color="warning">${escapeMd(info.platform || "-")}</font>`,
    `> 店铺/会话：${escapeMd(info.shop || info.sessionKey || "-")}`,
    `> 顾客：${escapeMd(info.customer || "-")}`,
    "",
    `**诉求**`,
    escapeMd(clip(info.lastCustomerMsg || info.message || "-", 400)),
    "",
    `**建议话术（未发或已安抚）**`,
    escapeMd(clip(info.reply || "-", 500)),
  ];
  if (info.risk) {
    lines.push("", `**风险点**`, escapeMd(clip(info.risk, 200)));
  }
  if (info.reason) {
    lines.push("", `**原因**`, escapeMd(clip(info.reason, 200)));
  }
  if (cfgNotify.mentionAll) {
    lines.push("", "<@all>");
  }
  lines.push("", "请负责人尽快在客服台接手处理。");
  return lines.join("\n");
}

function escapeMd(s) {
  return String(s || "")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "'");
}

function clip(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function postJson(urlStr, body, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      resolve({ ok: false, error: "bad-webhook-url" });
      return;
    }
    const lib = u.protocol === "https:" ? https : http;
    const data = Buffer.from(JSON.stringify(body), "utf8");
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": data.length,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* ignore */
          }
          const ok = res.statusCode >= 200 && res.statusCode < 300 && (json == null || json.errcode === 0);
          resolve({
            ok,
            status: res.statusCode,
            errcode: json && json.errcode,
            errmsg: (json && json.errmsg) || text.slice(0, 120),
          });
        });
      }
    );
    req.on("error", (e) => resolve({ ok: false, error: String(e.message || e).slice(0, 120) }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    req.write(data);
    req.end();
  });
}

/**
 * 升级时推企微群。失败只打日志，不抛错、不阻断客服主链路。
 * @param {object} cfg runtime
 * @param {object} info { platform, customer, sessionKey, shop, lastCustomerMsg, reply, escalate, risk, reason, at }
 * @param {(line:string)=>void} [logFn]
 */
async function notifyEscalation(cfg, info, logFn) {
  const log = typeof logFn === "function" ? logFn : () => {};
  const ncfg = escalateNotifyCfg(cfg);
  if (!ncfg.enabled) return { ok: false, skipped: "disabled" };
  if (ncfg.channel !== "wecom_webhook") {
    return { ok: false, skipped: "unsupported-channel" };
  }
  if (!shouldNotifyEscalation(info.escalate, info.reply)) {
    return { ok: false, skipped: "not-escalation" };
  }

  const key = cooldownKey(info);
  if (underCooldown(key, ncfg.cooldownSec)) {
    log(`ESCALATE_NOTIFY cooldown skip ${key}`);
    return { ok: false, skipped: "cooldown" };
  }

  const payload = {
    msgtype: "markdown",
    markdown: { content: buildMarkdown(ncfg, { ...info, at: info.at || new Date().toLocaleString("zh-CN", { hour12: false }) }) },
  };

  const res = await postJson(ncfg.webhookUrl, payload);
  if (res.ok) {
    markCooldown(key);
    log(`ESCALATE_NOTIFY ok platform=${info.platform || "?"} customer=${String(info.customer || "").slice(0, 40)}`);
  } else {
    log(
      `ESCALATE_NOTIFY fail ${res.error || res.errmsg || res.status || "unknown"}`.slice(0, 200)
    );
  }
  return res;
}

module.exports = {
  escalateNotifyCfg,
  shouldNotifyEscalation,
  notifyEscalation,
  buildMarkdown,
};
