/**
 * @file apps/edge-worker/order-lookup.js
 * @module 自有业务系统查单（浏览器通道）
 * @description
 *   Adapter：order.lookup({ orderId, phone }) → 结构化结果 + 客服话术。
 *   当前通道：OpenClaw CDP 打开 systems.order.baseUrl（洗艺行业 SaaS 全部订单页），
 *   填「关键字」→ 点「查询」→ 读表格行。不编造订单事实。
 *
 * @usage
 *   node apps/edge-worker/order-lookup.js --once yl_20260721hvNh14
 *   require("./order-lookup").lookup(cfg, { orderId })
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { spawnSync } = require("child_process");

const DEFAULT_ORDER_CFG = {
  enabled: false,
  channel: "browser",
  baseUrl: "https://yl-saas.xiyihangye.com/biz/cxorderlaundry",
  urlIncludes: "yl-saas.xiyihangye.com",
  pathIncludes: "/biz/cxorderlaundry",
  timeoutMs: 28000,
  settleMs: 1800,
  maxResults: 5,
  freeTextKeyword: false,
  /** ai | rules | ai+rules —— AI 主判；ai+rules 仅在 AI 失败时规则兜底（AI 判否不被覆盖） */
  intentMode: "ai+rules",
  intentAi: {
    /** gateway = OpenClaw；openai-compatible = 千问等；auto = 先 gateway 再兼容接口 */
    provider: "auto",
    model: "",
    baseUrl: "",
    apiKey: "",
    timeoutMs: 8000,
  },
};

let _busy = Promise.resolve();

function getJson(url) {
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith("https") ? https : http;
    lib
      .get(url, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(d || "null"));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

function cdpSession(wsUrl, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error("cdp connect timeout"));
    }, timeoutMs);
    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const mid = ++id;
        const t = setTimeout(() => {
          pending.delete(mid);
          rej(new Error(`cdp timeout ${method}`));
        }, timeoutMs);
        pending.set(mid, {
          res: (v) => {
            clearTimeout(t);
            res(v);
          },
          rej: (e) => {
            clearTimeout(t);
            rej(e);
          },
        });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve({ send, close: () => ws.close() });
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
    ws.addEventListener("error", (e) => {
      clearTimeout(timer);
      reject(e.error || e);
    });
  });
}

async function evaluate(send, expression) {
  const r = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result && r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function orderCfgOf(cfg) {
  return { ...DEFAULT_ORDER_CFG, ...(cfg?.systems?.order || {}) };
}

function cdpBase(cfg) {
  const o = orderCfgOf(cfg);
  return String(o.cdpUrl || cfg?.cdpUrl || "http://127.0.0.1:18800").replace(/\/$/, "");
}

function requestJson(url, { method = "GET", headers = {}, body, timeoutMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: {
          "content-type": "application/json",
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: d ? JSON.parse(d) : null, raw: d });
          } catch {
            resolve({ status: res.statusCode, json: null, raw: d });
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("request timeout"));
    });
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

function readGatewayToken(cfg) {
  const tokenFile = cfg?.gateway?.tokenFile;
  if (!tokenFile) return process.env.OPENCLAW_GATEWAY_TOKEN || "";
  try {
    return fs.readFileSync(tokenFile, "utf8").trim();
  } catch {
    return process.env.OPENCLAW_GATEWAY_TOKEN || "";
  }
}

function resolveIntentLlm(cfg) {
  const o = orderCfgOf(cfg);
  const ai = o.intentAi || {};
  const gatewayBase = String(cfg?.gateway?.baseUrl || process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789").replace(
    /\/$/,
    ""
  );
  const compatBase = String(
    ai.baseUrl ||
      process.env.ORDER_INTENT_BASE_URL ||
      process.env.LLM_BASE_URL ||
      process.env.EMBEDDING_BASE_URL ||
      ""
  ).replace(/\/$/, "");
  const compatKey =
    ai.apiKey ||
    process.env.ORDER_INTENT_API_KEY ||
    process.env.LLM_API_KEY ||
    process.env.EMBEDDING_API_KEY ||
    "";
  const model =
    ai.model ||
    process.env.ORDER_INTENT_MODEL ||
    process.env.LLM_MODEL ||
    cfg?.gateway?.model ||
    "qwen-turbo";

  return {
    provider: String(ai.provider || "auto").toLowerCase(),
    gatewayBase,
    gatewayToken: readGatewayToken(cfg),
    gatewayModel: cfg?.gateway?.model || model,
    compatBase,
    compatKey,
    model,
    timeoutMs: Number(ai.timeoutMs || 8000),
  };
}

function parseIntentJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const fence = raw.match(/\{[\s\S]*\}/);
  const slice = fence ? fence[0] : raw;
  try {
    const obj = JSON.parse(slice);
    return {
      lookup: obj.lookup === true || obj.lookup === "true" || obj.intent === "order_lookup",
      needId: obj.needId === true || obj.need_id === true,
      keyword: String(obj.keyword || obj.orderId || obj.phone || "").trim().slice(0, 60),
      reason: String(obj.reason || "").slice(0, 80),
    };
  } catch {
    return null;
  }
}

/**
 * AI 判断是否查单意图，并抽出可搜关键字。
 * @returns {Promise<{lookup:boolean, needId:boolean, keyword:string, reason:string, via:string}|null>}
 */
async function classifyIntentAi(cfg, message) {
  const msg = String(message || "").trim();
  if (!msg) return null;
  const llm = resolveIntentLlm(cfg);
  const system = [
    "你是洗护商家客服的意图分类器。只输出一行 JSON，不要其它文字。",
    '格式：{"lookup":true|false,"needId":true|false,"keyword":"","reason":""}',
    "lookup=true：仅当顾客在查「自己某一单」的进度/状态/催单/核销，或明确发了订单号/手机号要求查询。",
    "lookup=false：政策/流程/能不能做 的问法——例如能不能到店送衣服、自己送洗、上门取件、营业时间、套餐价格、周末能否用、闲聊等。这些不是查单。",
    "关键反例：「可以自己到店里送衣服吗」「支持上门吗」「怎么预约取件」→ lookup 必须 false，keyword 留空。",
    "keyword：仅 lookup=true 时填可搜字段（订单号、11 位手机、短订单名）；禁止把整句问话当 keyword。",
    "needId=true：确定要查单但缺少可搜信息，需要向顾客要订单号/手机号。",
    "不得编造不存在的订单号。",
  ].join("\n");
  const user = `顾客消息：${msg}`;

  const tryChat = async (baseUrl, apiKey, model, via) => {
    if (!baseUrl) return null;
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await requestJson(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      timeoutMs: llm.timeoutMs,
      body: {
        model: model || "qwen-turbo",
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      },
    });
    const content = res.json?.choices?.[0]?.message?.content;
    if (res.status >= 200 && res.status < 300 && content) {
      const parsed = parseIntentJson(content);
      if (parsed) return { ...parsed, via };
    }
    return null;
  };

  const order = [];
  if (llm.provider === "gateway" || llm.provider === "auto") {
    order.push(() => tryChat(llm.gatewayBase, llm.gatewayToken, llm.gatewayModel, "gateway"));
  }
  if (llm.provider === "openai-compatible" || llm.provider === "auto") {
    order.push(() => tryChat(llm.compatBase, llm.compatKey, llm.model, "openai-compatible"));
  }

  for (const fn of order) {
    try {
      const r = await fn();
      if (r) return r;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** 硬特征：明显单号/纯手机号，不依赖 AI。 */
function hardLookupSignal(message, orderCfg = {}) {
  const q = extractQuery(message, orderCfg);
  if (q.orderId) return { lookup: true, needId: false, keyword: q.keyword, via: "hard-id", reason: "order-id" };
  if (q.phone && (/^1[3-9]\d{9}$/.test(String(message || "").replace(/[\s\-。.!！？?]/g, "")) || isOrderIntent(message))) {
    return { lookup: true, needId: false, keyword: q.phone, via: "hard-phone", reason: "phone" };
  }
  if (q.keyword && /^[A-Za-z0-9_-]{5,}$/.test(q.keyword)) {
    return { lookup: true, needId: false, keyword: q.keyword, via: "hard-code", reason: "code" };
  }
  return null;
}

/**
 * 综合意图：硬特征 → AI 主判 →（仅 AI 不可用时）规则兜底。
 * 注意：AI 已明确 lookup=false 时，禁止再用关键词规则盖过去。
 * @returns {Promise<{lookup:boolean, needId:boolean, keyword:string, reason:string, via:string}|null>}
 */
async function resolveOrderIntent(cfg, message) {
  const o = orderCfgOf(cfg);
  if (!o.enabled) return null;
  const msg = String(message || "").trim();
  if (!msg) return null;

  const hard = hardLookupSignal(msg, o);
  if (hard) return hard;

  // 政策/FAQ（如何预约上门、能否到店自送等）绝不能走查单
  if (isLikelyFaqNotOrder(msg)) {
    return { lookup: false, needId: false, keyword: "", reason: "faq", via: "rules-faq" };
  }

  const mode = String(o.intentMode || "ai+rules").toLowerCase();
  const useAi = mode === "ai" || mode === "ai+rules";
  const useRulesFallback = mode === "rules" || mode === "ai+rules";

  let ai = null;
  if (useAi) {
    ai = await classifyIntentAi(cfg, msg);
  }

  // AI 明确不是查单 → 直接结束（不再走关键词规则）
  if (ai && ai.lookup === false) {
    return {
      lookup: false,
      needId: false,
      keyword: "",
      reason: ai.reason || "ai-no",
      via: ai.via || "ai",
    };
  }

  if (ai?.lookup) {
    const hardKw = extractQuery(msg, { ...o, freeTextKeyword: false }).keyword;
    let keyword = String(ai.keyword || hardKw || "").trim();
    if (isFaqishKeyword(keyword, msg)) keyword = "";
    if (!keyword || ai.needId) {
      return {
        lookup: true,
        needId: true,
        keyword: "",
        reason: keyword ? "need-id" : "ai-need-id",
        via: ai.via || "ai",
      };
    }
    return {
      lookup: true,
      needId: false,
      keyword,
      reason: ai.reason || "ai",
      via: ai.via || "ai",
    };
  }

  // 纯 AI 模式且调用失败：不查单，交给 FAQ/知识库
  if (mode === "ai") {
    return null;
  }

  // 规则兜底：仅当 AI 不可用（超时/失败/未开）时
  if (useRulesFallback && !ai) {
    if (isLikelyFaqNotOrder(msg)) {
      return { lookup: false, needId: false, keyword: "", reason: "faq", via: "rules-faq" };
    }
    if (isOrderIntent(msg)) {
      // 规则路径禁止把整句问话当地关键字；只认单号/手机等硬字段
      const q = extractQuery(msg, { ...o, freeTextKeyword: false });
      const keyword = q.keyword && !isFaqishKeyword(q.keyword, msg) ? q.keyword : "";
      return {
        lookup: true,
        needId: !keyword,
        keyword: keyword || "",
        reason: "rules-fallback",
        via: "rules",
      };
    }
  }

  return null;
}

/** @deprecated 同步粗判；正式路径请用 resolveOrderIntent */
function shouldLookup(cfg, message) {
  const o = orderCfgOf(cfg);
  if (!o.enabled) return false;
  const msg = String(message || "").trim();
  if (!msg || isLikelyFaqNotOrder(msg)) return false;
  if (hardLookupSignal(msg, o)) return true;
  return isOrderIntent(msg);
}

/** 问政策/套餐/如何预约/能否自送——不是查某一单。 */
function isLikelyFaqNotOrder(message) {
  const msg = String(message || "").trim();
  if (!msg) return false;
  // 明确在查自己的单 → 不是 FAQ
  if (/yl_[a-zA-Z0-9]{4,}/i.test(msg)) return false;
  if (/订单编号\s*[A-Za-z0-9_-]{8,}/i.test(msg) || /订单编号[\s\S]{0,12}?\d{12,}/.test(msg)) return false;
  if (/1[3-9]\d{9}/.test(msg) && /查|单|进度|催|洗好|到哪/.test(msg)) return false;
  if (/我的单|那一?单|上一单|这一单|单号|订单号|订单编号|催单|催一下|到哪了|洗好了吗|洗好没|好了没|核销码|券码/.test(msg)) {
    return false;
  }
  // 「如何/怎么预约」「能不能到店自送」等政策/流程问法
  if (
    /如何预约|怎么预约|怎样预约|如何上门|怎么上门|怎样上门|预约上门|上门怎么|取件怎么|怎么取件|如何取件|取件如何|取件流程|取送流程|支持预约|可以预约|能预约|上门取件吗|支持上门|能上门吗|可以上门吗|洗衣流程|怎么洗|周末能用|营业时间|多少钱|什么价|套餐|价目|自己送|自送到店|到店里送|到店送|送衣服|送洗|能不能到店|可以到店|能到店吗|自己到店/.test(
      msg
    )
  ) {
    return true;
  }
  // 疑问句且无查单硬线索
  if (/^(如何|怎么|怎样|请问|可以|能不能|能|是否).{0,24}(上门|取件|取送|预约|到店|送洗|送衣服)/.test(msg)) {
    return true;
  }
  if (/[吗麼么呢]\s*[？?]?$/.test(msg) && /(到店|送衣服|送洗|上门|取件|预约|营业|套餐|价格)/.test(msg)) {
    return true;
  }
  return false;
}

/** 抽出来的「关键字」其实是 FAQ 短语/整句问话，不能拿去搜订单。 */
function isFaqishKeyword(keyword, fullMessage = "") {
  const kw = String(keyword || "").trim();
  const msg = String(fullMessage || "").trim();
  if (!kw) return true;
  if (/yl_/i.test(kw) || /^1[3-9]\d{9}$/.test(kw) || /^[A-Za-z]{1,8}\d{3,}/.test(kw)) return false;
  // 整句疑问/过长口语绝不是可搜订单名
  if (/[吗麼么呢]\s*$/.test(kw) || /[？?]/.test(kw) || kw.length > 18) return true;
  if (/(可以|能不能|是否|怎么|怎样|如何)/.test(kw)) return true;
  if (isLikelyFaqNotOrder(msg) || isLikelyFaqNotOrder(kw)) return true;
  if (/预约|上门|取件|取送|套餐|价格|营业|流程|到店|送衣服|送洗/.test(kw) && !/单|进度|洗好|羽绒服|窗帘|鞋/.test(kw)) {
    return true;
  }
  // 「催 取件」这类动作词不能当订单名称搜
  if (/^(催|取件|取衣|查|进度|核销)([\s催取件取衣查进度核销]*)$/.test(kw)) return true;
  return false;
}

/**
 * 规则粗判「像不像查某一单」——仅作 AI 不可用时的兜底。
 * 禁止用「到店」等业务词单独触发（会把「可以到店送衣服吗」误判成查单）。
 */
function isOrderIntent(message) {
  const msg = String(message || "").trim();
  if (!msg) return false;
  if (isLikelyFaqNotOrder(msg)) return false;
  // 强信号：明确查单/催进度
  if (
    /查(一?下|询)?\s*(一下)?\s*(订单|单|进度)|查订单|查单|订单号|订单编号|单号|催单|催一下|我的单|那一?单|上一单|这一单|订单进度|洗好了?吗|洗好没|洗完了吗|到哪了|好了没|好了吗|还没好|核销码|券码|团购券|取件进度|来取衣|来取件/.test(
      msg
    )
  ) {
    return true;
  }
  // 顾客直接甩订单卡（带平台订单编号）也按查单处理
  if (/订单编号\s*[A-Za-z0-9_-]{8,}/i.test(msg) || /订单编号[\s\S]{0,12}?\d{12,}/.test(msg)) return true;
  // 「查一下」+ 不像政策问句
  if (/^(查|帮.*查|麻烦.*查)/.test(msg) && !/(怎么|如何|可以|能不能|吗)/.test(msg)) return true;
  if (/进度|到哪了/.test(msg) && /(单|洗|衣|订单)/.test(msg)) return true;
  return false;
}

/**
 * 从顾客消息提取查单关键字（对齐后台「关键字」：订单号 / 订单名称 / 手机号等）。
 */
function extractQuery(message, orderCfg = {}) {
  const msg = String(message || "").trim();
  const freeText = orderCfg.freeTextKeyword !== false;

  // yl_ 单号（中文紧贴也认）
  const yl = msg.match(/yl_[a-zA-Z0-9]{4,}/i);
  if (yl) return { orderId: yl[0], phone: "", keyword: yl[0] };

  // 抖音/来客订单卡：「订单编号 1111117654900503116」（纯数字平台单号）
  const platformNo =
    msg.match(/订单编号\s*[:：#]?\s*([A-Za-z0-9_-]{8,})/i) ||
    msg.match(/订单编号[\s\n\r:：#]*([0-9]{12,22})/);
  if (platformNo) return { orderId: platformNo[1], phone: "", keyword: platformNo[1] };

  // 「查一下订单ZD12345」「订单 ZD12345」——单号紧贴「订单」也要认
  const glued =
    msg.match(/订单号?\s*[:：#]?\s*([A-Za-z]{1,8}\d{3,}[A-Za-z0-9_-]*)/i) ||
    msg.match(/(?:^|[^订])单号\s*[:：#]?\s*([A-Za-z0-9_-]{5,})/i);
  if (glued) return { orderId: glued[1], phone: "", keyword: glued[1] };

  const labeled =
    msg.match(/订单\s*[:：#]\s*([A-Za-z0-9_-]{5,})/i);
  if (labeled) return { orderId: labeled[1], phone: "", keyword: labeled[1] };

  // 手机号：必须是独立 11 位，禁止从更长订单号里抠出「17654900503」这类片段
  const phoneM = msg.match(/(?<![0-9])(1[3-9]\d{9})(?![0-9])/);
  if (phoneM) {
    const phone = phoneM[1];
    const onlyPhone =
      msg.replace(/[\s\-]/g, "") === phone || /^1[3-9]\d{9}[。.!！？?\s]*$/.test(msg);
    if (onlyPhone || isOrderIntent(msg) || freeText) {
      return { orderId: "", phone, keyword: phone };
    }
  }

  // 码类：字母+数字（ZD12345）、下划线码、长数字；长度≥5
  // 优先取更长数字串（平台订单号常 15–19 位），避免先命中内部伪手机号片段
  const codes = msg.match(/[A-Za-z]{1,8}\d{3,}[A-Za-z0-9_-]*|[A-Za-z][A-Za-z0-9_-]{4,}|\d{8,}/g) || [];
  const code = codes
    .filter((c) => {
      if (/^1[3-9]\d{9}$/.test(c)) return false;
      if (/^(http|https|www)$/i.test(c)) return false;
      return c.length >= 5;
    })
    .sort((a, b) => b.length - a.length)[0];
  if (code) return { orderId: code, phone: "", keyword: code };

  // 自由文本：仅在非 FAQ、且剩余像「订单名称」短词时；禁止整句问话入搜
  if (freeText && !isLikelyFaqNotOrder(msg) && !/[吗麼么呢？?]/.test(msg)) {
    let stripped = msg
      .replace(/https?:\/\/\S+/gi, " ")
      .replace(
        /帮我|麻烦您?|请问|想要?|要帮|帮忙|一下|查下|查一下|查一查|看看|帮查|给查|查下呢|查哈/g,
        " "
      )
      .replace(/查(询|看|一下|下|下呢|哈)?/g, " ")
      .replace(/订单(号|进度|状态|到哪了?)?|单号|进度怎么样|怎么样了|如何|到哪了/g, " ")
      .replace(/洗好了吗|洗好没|好了没|好了吗|取衣了吗|取件了吗|催一下|催单|催下/g, " ")
      .replace(/我那一?单|那一?单|上一单|这一单|我的单/g, " ")
      .replace(/[？?！!。．.，,、；;：:\s]+/g, " ")
      .replace(/亲|您好|你好|在吗/g, " ")
      .trim();
    stripped = stripped
      .split(/\s+/)
      .filter((w) => w && !/^(呢|啊|吧|呀|么|吗|了|的|是|我|下|下呢|看看|帮)$/.test(w))
      .join(" ")
      .trim();
    // 剩余仍是政策词/过长口语则不搜
    if (stripped.length >= 2 && stripped.length <= 16 && !isFaqishKeyword(stripped, msg)) {
      return { orderId: "", phone: "", keyword: stripped.slice(0, 40) };
    }
  }

  return { orderId: "", phone: "", keyword: "" };
}

function askForIdReply() {
  return "亲，我可以帮您查进度。把订单号、下单手机号，或订单名称发我任意一样就行，马上帮您查。";
}

/** 终态：已完成/取消/退款等——简短确认即可，不必再报金额/类型或提加急 */
function isTerminalOrderStatus(status) {
  const s = String(status || "").trim();
  if (!s) return false;
  return /已完成|已取消|已关闭|已退款|退款成功|交易关闭|已签收/.test(s);
}

/** 进行中：突出状态，少堆字段 */
function isInProgressOrderStatus(status) {
  const s = String(status || "").trim();
  if (!s || isTerminalOrderStatus(s)) return false;
  return /待|清洗|洗涤|烘干|质检|发货|取货|打包|进行中|处理中/.test(s);
}

/**
 * 查单结果话术：口语、短、按状态分流。
 * - 已完成/取消/退款：一句确认 + 需要别的再说（不提加急改约）
 * - 进行中：状态为主，名称/门店可选带一句
 * - 多单：只列号+状态+名称，让顾客点选
 */
function formatOrdersReply(orders, keyword) {
  if (!orders?.length) {
    return (
      `亲，用「${keyword}」没查到匹配订单。` +
      "您再核对下订单号，或把订单截图发我，我帮您人工看一下。"
    );
  }

  if (orders.length === 1) {
    const o = orders[0];
    const no = o.orderNo || keyword;
    const status = String(o.status || "").trim();
    const name = String(o.name || "").trim();
    const shop = String(o.shop || "").trim();
    const nameBit = name ? `（${name}）` : "";

    if (isTerminalOrderStatus(status)) {
      if (/已完成|已签收/.test(status)) {
        return `亲，订单 ${no}${nameBit} 已是「${status}」状态啦。还有别的需要帮您吗？`;
      }
      if (/退款|取消|关闭/.test(status)) {
        return `亲，订单 ${no}${nameBit} 当前是「${status}」。如有疑问跟我说，我帮您转人工看一下。`;
      }
      return `亲，订单 ${no}${nameBit} 当前是「${status}」。还有别的需要帮您吗？`;
    }

    if (isInProgressOrderStatus(status) || status) {
      const shopBit = shop ? `，门店：${shop}` : "";
      return (
        `亲，已查到订单 ${no}${nameBit}，当前进度：${status || "处理中"}${shopBit}。` +
        "如需加急或改约，跟我说一声就行。"
      );
    }

    // 状态读不到时少暴露内部字段，避免像后台报表
    return (
      `亲，已查到订单 ${no}${nameBit}` +
      (shop ? `，门店：${shop}` : "") +
      "。具体进度我再帮您核对一下，稍等或发张截图也行。"
    );
  }

  // 多单：优先展示未完成的；全是终态则仍列出，避免顾客以为没查到
  const sorted = [...orders].sort((a, b) => {
    const ta = isTerminalOrderStatus(a.status) ? 1 : 0;
    const tb = isTerminalOrderStatus(b.status) ? 1 : 0;
    return ta - tb;
  });
  const show = sorted.slice(0, 3);
  const lines = show.map((o, i) => {
    const bits = [o.orderNo || "?", o.status || "状态未知"];
    if (o.name) bits.push(o.name);
    return `${i + 1}. ${bits.join(" · ")}`;
  });
  const more = orders.length > 3 ? `\n（还有 ${orders.length - 3} 单未列出）` : "";
  return (
    `亲，查到 ${orders.length} 条相关订单：\n` +
    lines.join("\n") +
    more +
    "\n您回复是第几单，或发完整订单号，我帮您看这一单。"
  );
}

function mapRow(headers, cells) {
  const cleanCells = (cells || [])
    .map((c) => String(c || "").trim())
    .filter((c, i, arr) => {
      // 去掉纯选择框/空操作列
      if (!c) return i < 2; // keep leading empties for align briefly
      return true;
    });
  // 对齐：若 cells 比 headers 多一列（常见勾选列），整体右移对齐
  let aligned = cells.slice();
  if (headers.length && cells.length === headers.length + 1) {
    aligned = cells.slice(1);
  } else if (headers.length && cells.length > headers.length) {
    // 尝试找第一个像订单号的格子作为起点
    const start = cells.findIndex((c) => /yl_[a-zA-Z0-9]+/i.test(c) || /^[A-Za-z0-9_-]{10,}$/.test(c));
    if (start > 0 && start <= 2) aligned = cells.slice(start);
  }

  const map = {};
  headers.forEach((h, i) => {
    if (h) map[h] = aligned[i] || "";
  });
  const pick = (...keys) => {
    for (const k of keys) {
      if (map[k]) return map[k];
      const hit = Object.keys(map).find((x) => x.includes(k));
      if (hit && map[hit]) return map[hit];
    }
    return "";
  };

  const blob = aligned.join(" | ");
  const orderNo =
    pick("订单号") ||
    (blob.match(/yl_[a-zA-Z0-9]{4,}/i) || [])[0] ||
    aligned.find((c) => /^yl_/i.test(c)) ||
    "";
  const statusList =
    /待支付|待清洗|清洗中|待质检|质检中|待发货|已发货|待取货|已完成|已取消|已关闭|已退款|退款成功|待收货|洗涤中|烘干中|打包中|已签收/;
  const status =
    pick("订单状态") ||
    aligned.find((c) => statusList.test(c)) ||
    "";
  const name =
    pick("订单名称") ||
    aligned.find((c) => /洗|衣|鞋|帘|护|套餐/.test(c) && c.length < 40 && !statusList.test(c)) ||
    "";
  const type =
    pick("订单类型") ||
    aligned.find((c) => /门店端|抖音|美团|微信|手动|团购/.test(c)) ||
    "";
  const shop =
    pick("门店") ||
    aligned.find((c) => /加油站|店|门店|中心/.test(c) && c.length < 40) ||
    "";
  const amount =
    pick("订单金额", "支付金额") ||
    aligned.find((c) => /^\d+(\.\d{1,2})?$/.test(c)) ||
    "";

  return {
    orderNo: String(orderNo || ""),
    type: String(type || ""),
    name: String(name || ""),
    amount: String(amount || ""),
    status: String(status || ""),
    shop: String(shop || ""),
    map,
    cells: aligned,
  };
}

function portableRoot(cfg) {
  return (
    process.env.OPENCLAW_PORTABLE_ROOT ||
    cfg?.openclawPortableRoot ||
    "F:\\OpenClaw-USB-Portable"
  );
}

function openClawPaths(cfg) {
  const root = portableRoot(cfg);
  return {
    root,
    node: path.join(root, "app", "runtime", "node-win-x64", "node.exe"),
    mjs: path.join(root, "app", "core", "node_modules", "openclaw", "openclaw.mjs"),
  };
}

/** 用 OpenClaw CLI 打开 URL（托管浏览器支持；CDP /json/new 在此环境会 405）。 */
function openViaOpenClawCli(cfg, url) {
  const { root, node, mjs } = openClawPaths(cfg);
  if (!fs.existsSync(node) || !fs.existsSync(mjs)) {
    return { ok: false, reason: "openclaw-cli-missing" };
  }
  const env = { ...process.env };
  const tokenFile = path.join(root, "data", ".openclaw", "gateway-token.txt");
  try {
    if (!env.OPENCLAW_GATEWAY_TOKEN && fs.existsSync(tokenFile)) {
      env.OPENCLAW_GATEWAY_TOKEN = fs.readFileSync(tokenFile, "utf8").trim();
    }
  } catch {}
  env.OPENCLAW_HOME = env.OPENCLAW_HOME || path.join(root, "data");
  env.OPENCLAW_STATE_DIR = env.OPENCLAW_STATE_DIR || path.join(root, "data", ".openclaw");
  const r = spawnSync(node, [mjs, "browser", "open", url], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 45000,
    windowsHide: true,
  });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  if (r.error) return { ok: false, reason: r.error.message, out };
  if (r.status !== 0 && !/opened:/i.test(out)) {
    return { ok: false, reason: `cli-exit-${r.status}`, out: out.slice(0, 200) };
  }
  return { ok: true, out: out.slice(0, 200) };
}

async function openViaNavigateBlank(cdpUrl, targetUrl, timeoutMs) {
  const tabs = await getJson(`${cdpUrl}/json/list`);
  const list = (Array.isArray(tabs) ? tabs : []).filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const blank =
    list.find((t) => /^(chrome:\/\/newtab\/?|about:blank)$/i.test(String(t.url || "").trim())) ||
    list.find((t) => (t.url || "").startsWith("chrome://newtab")) ||
    null;
  if (!blank) return null;
  const { send, close } = await cdpSession(blank.webSocketDebuggerUrl, timeoutMs || 28000);
  try {
    await send("Page.enable").catch(() => {});
    await send("Page.navigate", { url: targetUrl });
    await sleep(2500);
  } finally {
    close();
  }
  const again = await getJson(`${cdpUrl}/json/list`);
  return (Array.isArray(again) ? again : []).find((t) => t.id === blank.id) || blank;
}

async function openViaTargetCreate(cdpUrl, targetUrl, timeoutMs) {
  const tabs = await getJson(`${cdpUrl}/json/list`);
  const any = (Array.isArray(tabs) ? tabs : []).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!any) return null;
  const { send, close } = await cdpSession(any.webSocketDebuggerUrl, timeoutMs || 28000);
  try {
    await send("Target.createTarget", { url: targetUrl });
    await sleep(2500);
  } catch {
    return null;
  } finally {
    close();
  }
  return null;
}

function findOrderTab(list, orderCfg) {
  const pages = (list || []).filter((t) => t.type === "page" || !t.type);
  return (
    pages.find((t) => (t.url || "").includes(orderCfg.pathIncludes || "/biz/cxorderlaundry")) ||
    pages.find((t) => (t.url || "").includes(orderCfg.urlIncludes || "yl-saas.xiyihangye.com")) ||
    null
  );
}

async function findOrOpenTab(cdpUrl, orderCfg, cfg = {}) {
  const timeoutMs = orderCfg.timeoutMs || 28000;
  let tabs = await getJson(`${cdpUrl}/json/list`);
  let list = Array.isArray(tabs) ? tabs : [];
  let tab = findOrderTab(list, orderCfg);

  if (!tab) {
    // 1) OpenClaw CLI（可靠）
    const cli = openViaOpenClawCli(cfg, orderCfg.baseUrl);
    if (cli.ok) {
      await sleep(2200);
      tabs = await getJson(`${cdpUrl}/json/list`);
      list = Array.isArray(tabs) ? tabs : [];
      tab = findOrderTab(list, orderCfg);
      if (tab) return { tab, opened: true, how: "openclaw-cli" };
    }

    // 2) 复用空白标签导航
    tab = await openViaNavigateBlank(cdpUrl, orderCfg.baseUrl, timeoutMs);
    if (tab && (tab.url || "").includes(orderCfg.urlIncludes || "yl-saas")) {
      return { tab, opened: true, how: "navigate-blank" };
    }
    tabs = await getJson(`${cdpUrl}/json/list`);
    tab = findOrderTab(Array.isArray(tabs) ? tabs : [], orderCfg);
    if (tab) return { tab, opened: true, how: "navigate-blank" };

    // 3) Target.createTarget
    await openViaTargetCreate(cdpUrl, orderCfg.baseUrl, timeoutMs);
    tabs = await getJson(`${cdpUrl}/json/list`);
    tab = findOrderTab(Array.isArray(tabs) ? tabs : [], orderCfg);
    if (tab) return { tab, opened: true, how: "target-create" };
  }

  if (!tab) {
    return { tab: null, opened: false, how: "failed" };
  }

  // 已在同域但路径不对 → 导航到订单页
  if (!(tab.url || "").includes(orderCfg.pathIncludes || "/biz/cxorderlaundry")) {
    const { send, close } = await cdpSession(tab.webSocketDebuggerUrl, timeoutMs);
    try {
      await send("Page.enable").catch(() => {});
      await send("Page.navigate", { url: orderCfg.baseUrl });
      await sleep(2200);
    } finally {
      close();
    }
    const again = await getJson(`${cdpUrl}/json/list`);
    tab =
      findOrderTab(Array.isArray(again) ? again : [], orderCfg) ||
      (Array.isArray(again) ? again : []).find((t) => t.id === tab.id) ||
      tab;
  }
  return { tab, opened: false, how: "reuse" };
}

async function runBrowserLookup(cfg, keyword) {
  const orderCfg = orderCfgOf(cfg);
  const cdpUrl = cdpBase(cfg);
  const opened = await findOrOpenTab(cdpUrl, orderCfg, cfg);
  const tab = opened.tab;
  if (!tab?.webSocketDebuggerUrl) {
    return {
      ok: false,
      reason: "no-cdp-tab",
      orders: [],
      reply:
        "亲，订单后台页面还没打开成功。请确认 OpenClaw 浏览器已启动，我先帮您转人工查，或稍后再试。",
      escalate: true,
      openHow: opened.how,
    };
  }

  const { send, close } = await cdpSession(tab.webSocketDebuggerUrl, orderCfg.timeoutMs || 28000);
  try {
    await send("Runtime.enable").catch(() => {});
    await send("Page.enable").catch(() => {});
    await send("Page.bringToFront").catch(() => {});

    // 若打开后仍不在订单页，再强制导航一次
    const hrefNow = await evaluate(send, `location.href || ""`).catch(() => "");
    if (!String(hrefNow).includes(orderCfg.pathIncludes || "/biz/cxorderlaundry")) {
      await send("Page.navigate", { url: orderCfg.baseUrl });
      await sleep(2500);
    }

    const pageState = await evaluate(
      send,
      `(() => {
        const href = location.href || "";
        const text = (document.body && document.body.innerText || "").slice(0, 800);
        const login =
          /login|signin|登录|验证码|请登录/i.test(href) ||
          (/登录|请先登录|账号密码/.test(text) && !/全部订单|订单管理|关键字/.test(text));
        return { href, login, title: document.title || "" };
      })()`
    );
    if (pageState?.login) {
      return {
        ok: false,
        reason: "login-required",
        orders: [],
        reply:
          "亲，自有订单系统需要先登录后台才能查询。我先帮您转人工查进度，请稍等；您也可以先把订单号留在这里。",
        escalate: true,
      };
    }

    const kw = JSON.stringify(String(keyword));
    const filled = await evaluate(
      send,
      `(() => {
        const keyword = ${kw};
        const inputs = Array.from(document.querySelectorAll('input:not([type=hidden]):not([disabled])'));
        let input =
          inputs.find((i) => /订单号|订单名称|关键字|手机/.test(i.placeholder || "")) ||
          inputs.find((i) => {
            const lab = i.closest('.ant-form-item')?.querySelector('label')?.innerText || "";
            return /关键字|订单/.test(lab);
          }) ||
          inputs[0];
        if (!input) return { ok: false, reason: "no-input" };
        const proto = window.HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(input, keyword);
        else input.value = keyword;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));

        const buttons = Array.from(document.querySelectorAll("button, a.ant-btn, .ant-btn"));
        const btn = buttons.find((b) => /查询|搜索/.test((b.innerText || b.textContent || "").trim()));
        if (btn) {
          btn.click();
          return { ok: true, clicked: true, value: input.value };
        }
        // 无按钮则尝试回车提交
        input.form && input.form.requestSubmit ? input.form.requestSubmit() : null;
        return { ok: true, clicked: false, value: input.value };
      })()`
    );

    if (!filled?.ok) {
      return {
        ok: false,
        reason: filled?.reason || "fill-failed",
        orders: [],
        reply: "亲，订单查询页暂时打不开查询框，我先帮您转人工核实，请稍等。",
        escalate: true,
      };
    }

    await sleep(orderCfg.settleMs || 1800);

    const scraped = await evaluate(
      send,
      `(() => {
        const emptyTip = (document.body.innerText || "").includes("暂无数据") ||
          (document.body.innerText || "").includes("没有数据");
        const headers = Array.from(document.querySelectorAll(".ant-table-thead th, table thead th"))
          .map((th) => (th.innerText || "").trim().replace(/\\s+/g, " "));
        const rows = Array.from(document.querySelectorAll(".ant-table-tbody > tr, table tbody tr"))
          .filter((tr) => !tr.classList.contains("ant-table-measure-row") && !tr.classList.contains("ant-table-placeholder"));
        const data = rows.slice(0, 8).map((tr) => {
          return Array.from(tr.querySelectorAll("td")).map((td) =>
            (td.innerText || "").trim().replace(/\\s+/g, " ")
          );
        }).filter((cells) => cells.some((c) => c && c !== "暂无数据"));
        return { headers, rows: data, emptyTip, href: location.href };
      })()`
    );

    const headers = scraped?.headers || [];
    let orders = (scraped?.rows || []).map((cells) => mapRow(headers, cells));
    // 关键字过滤：优先包含查询串的行
    const kwLower = String(keyword).toLowerCase();
    const matched = orders.filter((o) =>
      [o.orderNo, o.name, ...(o.cells || [])].join(" ").toLowerCase().includes(kwLower)
    );
    if (matched.length) orders = matched;
    orders = orders.slice(0, orderCfg.maxResults || 3);

    if (!orders.length) {
      return {
        ok: true,
        reason: scraped?.emptyTip ? "empty" : "no-match",
        orders: [],
        reply: formatOrdersReply([], keyword),
        escalate: false,
      };
    }

    return {
      ok: true,
      reason: "ok",
      orders,
      reply: formatOrdersReply(orders, keyword),
      escalate: false,
    };
  } finally {
    try {
      close();
    } catch {}
  }
}

/**
 * @param {object} cfg cs-runtime
 * @param {{ orderId?: string, phone?: string, keyword?: string }} query
 */
async function lookup(cfg, query = {}) {
  const orderCfg = orderCfgOf(cfg);
  if (!orderCfg.enabled) {
    return { ok: false, reason: "disabled", orders: [], reply: null };
  }
  if (orderCfg.channel && orderCfg.channel !== "browser") {
    return {
      ok: false,
      reason: "channel-unsupported",
      orders: [],
      reply: "亲，查单通道暂未配置完成，我先帮您转人工核实。",
      escalate: true,
    };
  }

  const keyword = String(query.keyword || query.orderId || query.phone || "").trim();
  if (!keyword) {
    return { ok: false, reason: "need-id", orders: [], reply: askForIdReply(), escalate: false };
  }

  // 串行，避免多会话同时抢同一查单页
  const run = _busy.then(() => runBrowserLookup(cfg, keyword));
  _busy = run.catch(() => {});
  return run;
}

/**
 * 从最近上下文捞可搜单号/手机（顾客先发 yl_ 再发「查订单」）。
 * @param {string[]} recent
 */
function pickKeywordFromRecent(recent, orderCfg = {}) {
  const list = Array.isArray(recent) ? recent : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const t = String(list[i] || "").trim();
    if (!t) continue;
    // 订单卡可稍长；其它预览过长跳过
    if (t.length > 220 && !/订单编号/.test(t)) continue;
    // 跳过明显客服话术
    if (/亲[，,]|已帮您查到|对照门店|转人工/.test(t)) continue;
    const q = extractQuery(t, { ...orderCfg, freeTextKeyword: false });
    if (q.keyword && !isFaqishKeyword(q.keyword, t)) return q.keyword;
  }
  return "";
}

/**
 * 供 cs-watch generateReply 调用：AI 判意图 → 查单 / 要单号 / 不处理。
 * @param {object} cfg
 * @param {string} message 最新顾客句
 * @param {{ recent?: string[] }} [ctx] 同会话最近气泡（含历史顾客句）
 * @returns {Promise<null|{ reply: string, escalate?: boolean, meta: object }>}
 */
async function tryHandle(cfg, message, ctx = {}) {
  const o = orderCfgOf(cfg);
  const recent = Array.isArray(ctx.recent) ? ctx.recent : [];
  const intent = await resolveOrderIntent(cfg, message);
  if (!intent || !intent.lookup) return null;

  let keyword = String(intent.keyword || "").trim();
  // 「查订单啊」本身无单号 → 用前面气泡里的 yl_/手机号
  if ((!keyword || intent.needId) && recent.length) {
    const fromCtx = pickKeywordFromRecent(recent, o);
    if (fromCtx) {
      keyword = fromCtx;
      intent.needId = false;
      intent.reason = `${intent.reason || "intent"}+ctx`;
    }
  }

  if (!keyword || intent.needId) {
    return {
      reply: askForIdReply(),
      escalate: false,
      meta: { reason: "need-id", via: intent.via, intentReason: intent.reason },
    };
  }

  const result = await lookup(cfg, { keyword });
  if (!result.reply) {
    return {
      reply: "亲，自有系统查单暂时失败，我先帮您转人工核实，请稍等。您把订单号留在这里即可。",
      escalate: true,
      meta: { ...result, via: intent.via },
    };
  }
  return {
    reply: result.reply,
    escalate: !!result.escalate,
    meta: { ...result, via: intent.via, intentReason: intent.reason, keyword },
  };
}

module.exports = {
  shouldLookup,
  isOrderIntent,
  extractQuery,
  askForIdReply,
  lookup,
  tryHandle,
  resolveOrderIntent,
  classifyIntentAi,
  pickKeywordFromRecent,
  orderCfgOf,
  mainCli,
};

async function mainCli() {
  const args = process.argv.slice(2);
  const onceIdx = args.indexOf("--once");
  const keyword = onceIdx >= 0 ? args[onceIdx + 1] : args.find((a) => !a.startsWith("-"));
  if (!keyword) {
    console.error("Usage: node apps/edge-worker/order-lookup.js --once <orderId|phone>");
    process.exit(1);
  }
  const fs = require("fs");
  const path = require("path");
  const cfgPath = path.join(__dirname, "..", "..", "config", "cs-runtime.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  cfg.systems = cfg.systems || {};
  cfg.systems.order = { ...orderCfgOf(cfg), enabled: true };
  const r = await lookup(cfg, extractQuery(keyword).keyword ? extractQuery(keyword) : { keyword });
  console.log(JSON.stringify(r, null, 2));
}

if (require.main === module) {
  mainCli().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
