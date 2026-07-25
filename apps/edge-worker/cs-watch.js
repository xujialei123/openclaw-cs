/**
 * @file apps/edge-worker/cs-watch.js
 *
 * ============================================================================
 * 这一文件干什么？（一句话）
 * ============================================================================
 *   每隔几秒扫一遍浏览器里的「美团经营宝 / 抖音来客」客服页，
 *   只对白名单顾客：找出还没回的话 → 想好怎么回 → 自动发出去。
 *
 * ============================================================================
 * 整条流水线怎么串起来？（从上往下读）
 * ============================================================================
 *
 *   main()                          ← 程序入口；抢锁，防止开两个进程各回一遍
 *     └─ 死循环：读配置 → tick() → 睡 pollIntervalMs
 *
 *   tick()                          ← 一轮巡检
 *     ├─ 合并 memory/cs-watch-state.json（已回过哪些话）
 *     ├─ processMeituan()           ← 先处理美团（有未完成工作就不切抖音）
 *     └─ processDouyin()            ← 再处理抖音
 *
 *   processMeituan / processDouyin  ← 单个平台的一轮（两边套路一样）
 *     1. findTab + cdpSession       找到浏览器标签页，连上 CDP
 *     2. scan*ChatList              扫左侧会话列表
 *     3. pickTargetsFromList        挑出白名单会话
 *     4. open*Conversation          点进某个顾客聊天
 *     5. readMeituanThread / 读抖音气泡
 *     6. listUnreplied*             看「最后一条客服之后」还有哪些顾客话没回
 *     7. 对每条未回话：
 *          claimMessage             抢占（防双发）→ 写入 state
 *          generateReply            想回复（查单/知识库/LLM）
 *          meituanSend / douyinSend 填输入框并点发送
 *          settleAfterSend          等到气泡出现再离开
 *          finalizeClaim            标记这条已处理完
 *
 *   generateReply()                 ← 「想怎么回」（被 process* 调用）
 *     ├─ order-lookup.js            像查单？→ 打开自有 SaaS 查，不编造
 *     ├─ 问门店地址？→ 固定查知识库「门店地址」
 *     ├─ kb-retrieve.js             知识库检索（remote 中台或 local）
 *     └─ OpenClaw LLM               闲聊润色；事实题没库则禁止乱编
 *
 * ============================================================================
 * 几个关键词（后面注释里会反复出现）
 * ============================================================================
 *   CDP        操控 Chrome 的协议（点按钮、读页面）。地址见 cs-runtime.json → cdpUrl
 *   指纹 fp    平台+顾客+消息摘要，用来记「这句回过没有」（state.processed）
 *   claim      发送前先占坑落盘，避免两个 tick 同时回同一句
 *   气泡       聊天区左右消息；是否待回只看气泡，不信列表预览文案
 *   openWork   美团这轮还有没回完的 → tick 先别切抖音
 *
 * ============================================================================
 * 源码分区（编辑器搜索 SECTION 可跳转）
 * ============================================================================
 *   A 读配置、单实例锁、指纹 claim/释放
 *   B 连浏览器（CDP）、在页面里执行 JS
 *   C 生成回复文案
 *   D 美团/抖音：读列表、读聊天、发送
 *   E 选哪些会话、哪些句子算「未回」
 *   F 美团/抖音整轮处理（把上面串起来）
 *   G main / tick 入口
 *
 * 怎么跑：npm run edge | npm run edge:once
 * 配置：config/cs-runtime.json
 * 相关：order-lookup.js | kb-retrieve.js | admin/project-map.html
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

/** @type {typeof import('./kb-retrieve')} */
let kbRetrieve = null;
try {
  // 可选依赖：知识库模块缺失时巡检仍可用 fallback
  kbRetrieve = require("./kb-retrieve");
} catch (e) {
  kbRetrieve = null;
}

/** @type {typeof import('./order-lookup')} */
let orderLookup = null;
try {
  orderLookup = require("./order-lookup");
} catch (e) {
  orderLookup = null;
}

const DEFAULT_CONFIG = path.join(__dirname, "..", "..", "config", "cs-runtime.json");
const PROJECT_ROOT = path.join(__dirname, "..", "..");
const args = process.argv.slice(2);
/** --once：只跑一轮 tick 后退出（排障/联调用） */
const once = args.includes("--once");
const cfgIdx = args.indexOf("--config");
const configPath = cfgIdx >= 0 ? args[cfgIdx + 1] : DEFAULT_CONFIG;

/* ========== SECTION A：配置 / 锁 / 「这句回过没有」 ==========
 * 被谁用：main 读配置、抢锁；process* 里 claim/finalize；tick 合并磁盘 state。
 * 状态文件：memory/cs-watch-state.json → processed[指纹] = 已处理记录
 * ================================================================== */

/** 读 JSON 文件；读失败就返回 fallback（state 第一次还不存在时用）。 */
function loadJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * 把对象写成 JSON 文件（状态、锁旁路数据等）。
 * 谁调用：claim/finalize、quiet 冷却、tick 结束存 state。
 */
function saveJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

/**
 * 把配置里写的「路径字符串」变成电脑上真正能打开的绝对路径。
 *
 * 配置里常见两种写法：
 *   A) "${OPENCLAW_PORTABLE_ROOT}/data/.openclaw/gateway-token.txt"
 *      → 先把 ${...} 换成 .env 里的值，再拼成完整路径
 *   B) "memory/cs-watch-state.json"（相对路径）
 *      → 相对「项目根目录」拼成绝对路径，换盘符也能跑
 *
 * 谁调用：normalizeRuntimeConfig（读 cs-runtime.json 时处理 tokenFile/stateFile 等）
 *
 * 例子：
 *   输入  "${OPENCLAW_PORTABLE_ROOT}/data/x.txt"
 *   环境  OPENCLAW_PORTABLE_ROOT=D:\OpenClaw-USB-Portable
 *   输出  D:\OpenClaw-USB-Portable\data\x.txt
 */
function resolvePathMaybe(p, root) {
  // 空值或不是字符串 → 原样返回，别乱处理
  if (!p || typeof p !== "string") return p;

  // 第一步：替换 ${环境变量名}。例如 ${OPENCLAW_PORTABLE_ROOT} → 实际盘符路径
  // 若环境变量没设，替换成空字符串（后面可能变成空路径）
  const expanded = p.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => {
    const v = process.env[key];
    return v != null && v !== "" ? v : "";
  });

  // 替换后变成空 → 没法用，直接返回空
  if (!expanded) return expanded;

  // 已经是绝对路径（如 D:\xxx 或 /xxx）→ 只做路径规范化（统一斜杠等）
  if (path.isAbsolute(expanded)) return path.normalize(expanded);

  // 相对路径（如 memory/xxx.json）→ 拼到项目根（或传入的 root）后面
  return path.resolve(root || PROJECT_ROOT, expanded);
}

/**
 * 读完 cs-runtime.json 之后「收拾一遍」再给后面用：
 *   1) 所有路径字段走 resolvePathMaybe（支持换机器、换盘符）
 *   2) .env 里的 RAG_BASE_URL / CDP 等覆盖 json 里的同名字段（改环境不用改 json）
 *   3) 没写 stateFile/logFile 就给默认值
 * 谁调用：loadRuntimeConfig。
 */
function normalizeRuntimeConfig(raw, root) {
  // 深拷贝一份，避免改到磁盘读出来的原对象
  const cfg = raw && typeof raw === "object" ? JSON.parse(JSON.stringify(raw)) : {};
  const base = root || PROJECT_ROOT;

  // —— 路径类字段：相对路径 / ${ENV} 都在这里变成绝对路径 ——
  if (cfg.gateway?.tokenFile) {
    cfg.gateway.tokenFile = resolvePathMaybe(cfg.gateway.tokenFile, base);
  }
  if (cfg.knowledge?.root) cfg.knowledge.root = resolvePathMaybe(cfg.knowledge.root, base);
  if (cfg.knowledge?.dbPath) cfg.knowledge.dbPath = resolvePathMaybe(cfg.knowledge.dbPath, base);
  if (cfg.stateFile) cfg.stateFile = resolvePathMaybe(cfg.stateFile, base);
  if (cfg.logFile) cfg.logFile = resolvePathMaybe(cfg.logFile, base);

  // —— 环境变量覆盖：部署时改 .env 即可切中台地址，不必改 json ——
  cfg.knowledge = cfg.knowledge || {};
  cfg.knowledge.rag = cfg.knowledge.rag || {};
  if (process.env.RAG_BASE_URL) cfg.knowledge.rag.baseUrl = String(process.env.RAG_BASE_URL).replace(/\/$/, "");
  if (process.env.RAG_API_KEY) cfg.knowledge.rag.apiKey = process.env.RAG_API_KEY;
  if (process.env.OPENCLAW_CDP_URL || process.env.CDP_URL) {
    cfg.cdpUrl = process.env.OPENCLAW_CDP_URL || process.env.CDP_URL;
  }
  if (process.env.OPENCLAW_GATEWAY_URL) {
    cfg.gateway = cfg.gateway || {};
    cfg.gateway.baseUrl = process.env.OPENCLAW_GATEWAY_URL.replace(/\/$/, "");
  }
  if (process.env.KNOWLEDGE_FALLBACK_LOCAL === "false" || process.env.KNOWLEDGE_FALLBACK_LOCAL === "0") {
    cfg.knowledge.fallbackLocal = false;
  }
  if (process.env.KNOWLEDGE_FALLBACK_LOCAL === "true" || process.env.KNOWLEDGE_FALLBACK_LOCAL === "1") {
    cfg.knowledge.fallbackLocal = true;
  }

  // 仅 knowledge.mode=local 降级时用；正式向量在中台
  cfg.knowledge.embedding = cfg.knowledge.embedding || {};
  if (process.env.EMBEDDING_API_KEY) cfg.knowledge.embedding.apiKey = process.env.EMBEDDING_API_KEY;
  if (process.env.EMBEDDING_BASE_URL) cfg.knowledge.embedding.baseUrl = process.env.EMBEDDING_BASE_URL;
  if (process.env.EMBEDDING_MODEL) cfg.knowledge.embedding.model = process.env.EMBEDDING_MODEL;
  if (process.env.EMBEDDING_DIM) cfg.knowledge.embedding.dimensions = Number(process.env.EMBEDDING_DIM) || cfg.knowledge.embedding.dimensions;

  // 默认落盘位置（边端小账本，不是业务数据库）
  if (!cfg.stateFile) cfg.stateFile = path.join(base, "memory", "cs-watch-state.json");
  if (!cfg.logFile) cfg.logFile = path.join(base, "memory", "cs-watch.log");
  return cfg;
}

/**
 * 加载客服配置（白名单、autoSend、知识库地址等）。
 * 谁调用：main 启动时一次；之后每个 tick 前再读一次（改 JSON 不用重启进程）。
 */
function loadRuntimeConfig(filePath) {
  return normalizeRuntimeConfig(loadJson(filePath, {}), PROJECT_ROOT);
}

/**
 * 单实例锁：只允许一个 cs-watch 在跑。
 * 谁调用：main 一进来就调。锁文件：memory/cs-watch.lock
 * 若已有别的进程占着锁 → 直接退出，避免同一句被回两次。
 */
function acquireWatchLock(cfg) {
  const lockPath = path.join(path.dirname(cfg.stateFile || path.join(PROJECT_ROOT, "memory", "cs-watch-state.json")), "cs-watch.lock");
  const mine = { pid: process.pid, at: new Date().toISOString() };
  try {
    if (fs.existsSync(lockPath)) {
      const old = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      const oldPid = Number(old?.pid);
      if (oldPid && oldPid !== process.pid) {
        try {
          // kill(pid, 0) 不杀进程，只探测「这个 pid 还活着吗」
          process.kill(oldPid, 0);
          console.error(`[LOCK] another cs-watch is running pid=${oldPid}. Exit.`);
          process.exit(2);
        } catch {
          // 旧 pid 已死 → 锁文件是脏的，下面会覆盖写入
        }
      }
    }
  } catch {
    /* ignore corrupt lock */
  }
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify(mine, null, 2), "utf8");
  // 进程退出时删掉自己的锁，别挡住下次启动
  const release = () => {
    try {
      if (fs.existsSync(lockPath)) {
        const cur = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        if (cur?.pid === process.pid) fs.unlinkSync(lockPath);
      }
    } catch {}
  };
  process.on("exit", release);
  process.on("SIGINT", () => {
    release();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    release();
    process.exit(0);
  });
  return { lockPath, release };
}

/**
 * 聊天记录里有没有已经出现「我们发出去的那句回复」（按前缀模糊匹配）。
 * 谁调用：reconcileStuckPending —— 列表还挂着待回复，但其实气泡里已经回过了。
 */
function threadHasAgentReply(thread, reply) {
  const needle = String(reply || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 28);
  if (!needle) return false;
  const pools = [];
  if (Array.isArray(thread?.right)) pools.push(...thread.right);
  if (Array.isArray(thread?.recent)) pools.push(...thread.recent);
  if (Array.isArray(thread?.all)) pools.push(...thread.all);
  return pools.some((t) => String(t || "").replace(/\s+/g, " ").includes(needle));
}

/**
 * 处理「平台还显示待回复，本地却标成已处理」的卡住情况。
 * - 气泡里根本没有我们的回复 → 清指纹，允许重发
 * - 气泡里已有回复 → 返回 quiet，别每轮空点进会话
 * 谁调用：processMeituan 发现挑不出未回话时。
 */
function reconcileStuckPending(cfg, state, fpPrefix, candidates, thread, { pending, unread }) {
  if (!(pending || unread > 0)) return { msg: "", quiet: false };
  const list = Array.isArray(candidates) ? candidates : [];
  for (const msg of list) {
    const s = String(msg || "").trim();
    if (!s) continue;
    const fp = `${fpPrefix}${s}`;
    const entry = state.processed?.[fp];
    if (!entry || !isProcessedDone(entry)) return { msg: s, quiet: false };
    const reply = String(entry.reply || "");
    if (reply && threadHasAgentReply(thread, reply)) continue;
    // 记了 processed 但聊天里看不到 → 允许重发一次
    if (entry.pendingResend) continue;
    clearProcessedFp(cfg, state, fp);
    return { msg: s, quiet: false, resentCleared: true };
  }
  // 全都处理过且气泡里有回复，但平台仍挂待回复：静默，别空转
  return { msg: "", quiet: true };
}

/**
 * 这条「已处理记录」算不算已经搞定、别再碰？
 * 谁调用：claimMessage、挑未回话时。
 *
 * 返回 false = 还可以再试，例如：
 *   - 根本没有记录
 *   - 上次发送失败（claimFailed）
 *   - 只回了澄清 soft 且还没重试过
 *   - claiming 卡住超过 20 秒（进程可能挂了）
 */
function isProcessedDone(entry) {
  if (!entry) return false;
  if (entry.claimFailed) return false; // 发送失败 → 允许重试
  if (entry.soft && !entry.softRetried) return false; // 软澄清 → 允许再试一次
  if (entry.claiming && !entry.reply) {
    // 正在占坑但还没写出最终回复
    const age = Date.now() - new Date(entry.at || 0).getTime();
    // 超过 20 秒还停在 claiming → 当僵死，允许别的 tick 接管
    if (!Number.isFinite(age) || age > 20 * 1000) return false;
    return true; // 20 秒内仍算「别人正在处理」，别抢
  }
  return true; // 正常已完成
}

/**
 * 发送前「占坑」：马上把这句标成 claiming 并写入 state 文件。
 * 谁调用：process* 在 generateReply 之前。
 *
 * 步骤白话：
 *   1) 磁盘 state + 内存 state 合并（但尊重我们主动删过的指纹，别复活）
 *   2) 若这句已经算处理完 → 返回 false（日志 claim-race / already processed）
 *   3) 否则写入 claiming=true 并立刻 saveJson → 返回 true，可以继续想回复、发送
 */
function claimMessage(cfg, state, fp, meta = {}) {
  const disk = loadJson(cfg.stateFile, { processed: {} });
  // 合并：内存覆盖磁盘；但 _clearedFps 里的键必须删掉（防止清掉后又被磁盘旧数据加回来）
  const merged = { ...(disk.processed || {}), ...(state.processed || {}) };
  for (const k of state._clearedFps || []) {
    delete merged[k];
  }
  state.processed = merged;

  const prev = state.processed[fp];
  if (isProcessedDone(prev)) {
    // 特殊：claiming 僵死超过 20s → 下面仍可强制接管；否则占不到
    if (prev?.claiming && !prev?.reply) {
      const age = Date.now() - new Date(prev.at || 0).getTime();
      if (Number.isFinite(age) && age <= 20 * 1000) return false;
    } else {
      return false;
    }
  }

  // 占坑成功：标记 claiming，马上落盘，其它重叠 tick 会看到并跳过
  state.processed[fp] = {
    ...(prev || {}),
    at: new Date().toISOString(),
    claiming: true,
    claimFailed: false,
    ...meta,
    softRetried: prev?.soft ? true : prev?.softRetried,
  };
  if (state._clearedFps) state._clearedFps = state._clearedFps.filter((k) => k !== fp);
  saveJson(cfg.stateFile, state);
  return true;
}

/**
 * 发送成功（或只进 pending 不发）后，把指纹改成终态并落盘。
 * 谁调用：process* 在 send 成功 / escalate / autoSend=false 之后。
 * 下一步：同会话可处理下一条未回话，或进入短冷却。
 */
function finalizeClaim(cfg, state, fp, patch) {
  state.processed[fp] = {
    ...(state.processed[fp] || {}),
    ...patch,
    claiming: false,
    at: new Date().toISOString(),
  };
  saveJson(cfg.stateFile, state);
}

/**
 * 想回复失败、或不发了：去掉 claiming，下轮还能再试这句。
 * 谁调用：generateReply 抛错、发送未确认等。
 */
function releaseClaim(cfg, state, fp) {
  if (state.processed?.[fp]?.claiming) {
    delete state.processed[fp];
    state._clearedFps = state._clearedFps || [];
    if (!state._clearedFps.includes(fp)) state._clearedFps.push(fp);
    saveJson(cfg.stateFile, state);
  }
}

/**
 * 删掉某条「已处理」记录，并记入 _clearedFps，防止从磁盘合并时又被加回来。
 * 谁调用：气泡里明明还没客服回、但本地误标已处理 → 清掉以便重回。
 */
function clearProcessedFp(cfg, state, fp) {
  if (!fp) return;
  if (state.processed?.[fp]) delete state.processed[fp];
  state._clearedFps = state._clearedFps || [];
  if (!state._clearedFps.includes(fp)) state._clearedFps.push(fp);
  // 先与磁盘合并再删，避免 save 时用「不完整内存」覆盖掉其它指纹
  const disk = loadJson(cfg.stateFile, { processed: {} });
  const merged = { ...(disk.processed || {}), ...(state.processed || {}) };
  for (const k of state._clearedFps) delete merged[k];
  delete merged[fp];
  state.processed = merged;
  saveJson(cfg.stateFile, state);
}

/**
 * 是不是「该查单却回了糊弄澄清」——这种标 soft，修逻辑后还能自动再试。
 * 谁调用：process* 在 finalizeClaim 前判断。
 */
function isSoftClarifyReply(customerMsg, reply) {
  const msg = String(customerMsg || "");
  const r = String(reply || "");
  if (!msg || !r) return false;
  const orderish =
    /查|订单|单号|yl_|进度|催|洗好|取衣|取件|核销/.test(msg) || /1[3-9]\d{9}/.test(msg);
  if (!orderish) return false;
  return /对照门店最新政策|方便再说下具体|发张截图吗|这个问题我这边还需要/.test(r);
}

/**
 * 打日志：控制台 + memory/cs-watch.log 各写一份。
 * 谁调用：几乎所有步骤（TICK / MEITUAN detect / KB_HIT…）。排障先看这个文件。
 */
function log(cfg, ...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(cfg.logFile, line + "\n", "utf8");
  } catch {}
}

/* ========== SECTION B：连浏览器（CDP）——点页面、读页面 ==========
 * 被谁用：processMeituan / processDouyin 开头 findTab → cdpSession；
 *         之后所有 evaluate / 发送 / 扫列表都靠这里的 send()。
 * CDP 地址：cfg.cdpUrl，常见 http://127.0.0.1:18800
 * ================================================================== */

/** HTTP GET 并解析 JSON。谁调用：findTab 拉 /json/list 看有哪些标签页。 */
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(d));
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

/**
 * 发 HTTP(S) JSON 请求（带超时）。
 * 谁调用：generateReply 里调 OpenClaw 的 /v1/chat/completions（LLM）。
 */
function requestJson(url, { method = "GET", headers = {}, body, timeoutMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port,
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

/**
 * 连上某个浏览器标签页的 CDP WebSocket，得到 { send, close }。
 * 谁调用：processMeituan / processDouyin 找到 tab 之后。
 *
 * 白话步骤：
 *   1) 用 tab.webSocketDebuggerUrl 建 WebSocket
 *   2) 连上后返回 send(method, params)：发一条 CDP 命令并等回包
 *   3) pending Map 用递增 id 把「发出去的请求」和「回来的结果」对上号
 *   4) 用完务必 close()，否则会占着连接
 *
 * 注意：经营宝大量 UI 只能通过 Accessibility 稳定读，不能只信 body.innerText。
 */
function cdpSession(wsUrl, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map(); // id → { res, rej }，等 CDP 回包时取出
    // 整段连接超时：一直连不上就 reject
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("cdp connect timeout"));
    }, timeoutMs);
    // send：发一条 CDP 命令（如 Runtime.evaluate），返回 Promise 等结果
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
    // 回包：按 msg.id 找到对应的 Promise 并 resolve/reject
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

/**
 * 在当前标签页里跑一段 JS，把结果返回给 Node。
 * 谁调用：扫列表、读气泡、发送、关智能推荐……几乎所有页面操作。
 *
 * 白话：Node 这边不能直接摸浏览器 DOM，只能把 expression 字符串交给 CDP，
 * 浏览器执行完再把 returnByValue 的结果带回来。美团聊天在 iframe 里，
 * 表达式通常要用 meituanChatDocExpr(...) 先钻进 iframe 文档。
 */
async function evaluate(send, expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  // 页面 JS 抛错时 CDP 不会直接 reject，要自己看 exceptionDetails
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result && r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 给「某一句顾客话」做身份证字符串，用来去重。
 * 格式：  平台::顾客会话键::消息前180字
 * 例如：  meituan::AXw…@@id:s1429…::门店在哪
 * 同一句指纹相同 → state 里记过就不会再回。
 * 谁调用：claim / finalize / 判断是否已处理。
 */
function fingerprint(platform, customer, text) {
  return `${platform}::${customer}::${String(text || "").slice(0, 180)}`;
}

/**
 * 在浏览器已打开的标签里，找到美团或抖音客服页。
 * 谁调用：process* 第一步。
 * 做法：向 CDP 要 /json/list（所有标签），先按标题 tabTitle 找，找不到再按网址包含 urlIncludes。
 * 抖音：优先带 accountId 的完整客服台 URL，避免命中无参的「系统异常」页。
 */
async function findTab(cdpUrl, platformCfg) {
  const tabs = await getJson(`${cdpUrl}/json/list`);
  const includes = platformCfg.urlIncludes || "";
  const byTitle = tabs.find((t) => t.title === platformCfg.tabTitle);
  if (byTitle && (!includes || String(byTitle.url || "").includes(includes))) {
    // 标题命中但仍是异常空参页时继续往下挑
    if (!/life\.douyin\.com\/cs\/web\/?(\?|$)/.test(String(byTitle.url || "")) || /[?&]accountId=/.test(String(byTitle.url || ""))) {
      return byTitle;
    }
  }
  const urlHits = tabs.filter((t) => includes && String(t.url || "").includes(includes));
  const withAccount = urlHits.find((t) => /[?&]accountId=/.test(String(t.url || "")));
  if (withAccount) return withAccount;
  if (urlHits[0]) return urlHits[0];
  // 抖音可能停在商家首页，也返回以便 ensure 去点「顾客咨询」
  if (includes.includes("douyin") || includes.includes("cs/web")) {
    const home = tabs.find((t) => /life\.douyin\.com\/p\/home/.test(String(t.url || "")));
    if (home) return home;
  }
  return byTitle || null;
}

/** 是否抖音完整客服台 URL（带 accountId，不是裸 /cs/web） */
function isDouyinWorkbenchUrl(url) {
  const u = String(url || "");
  return /life\.douyin\.com\/cs\/web/.test(u) && /[?&]accountId=/.test(u);
}

/**
 * 从已打开标签 / 缓存里发现「带账号参数」的客服台地址（不写死 accountId）。
 * 谁调用：ensureDouyinWorkbench。
 */
async function discoverDouyinWorkbenchUrl(cfg, state, tabUrl) {
  if (isDouyinWorkbenchUrl(tabUrl)) return String(tabUrl);
  if (isDouyinWorkbenchUrl(state?.douyinWorkbenchUrl)) return String(state.douyinWorkbenchUrl);
  // 配置里若有人手动填了完整 URL 也可以用，但不要求写死
  if (isDouyinWorkbenchUrl(cfg.platforms?.douyin?.openUrl)) return String(cfg.platforms.douyin.openUrl);
  try {
    const tabs = await getJson(`${cfg.cdpUrl}/json/list`);
    const hit = (tabs || []).find((t) => isDouyinWorkbenchUrl(t.url));
    if (hit?.url) return String(hit.url);
  } catch {}
  return "";
}

function rememberDouyinWorkbenchUrl(cfg, state, href) {
  if (!isDouyinWorkbenchUrl(href)) return;
  if (state.douyinWorkbenchUrl === href) return;
  state.douyinWorkbenchUrl = href;
  try {
    saveJson(cfg.stateFile, state);
  } catch {}
  log(cfg, "DOUYIN workbench cached", href.slice(0, 140));
}

/**
 * 抖音来客：确保当前在带 accountId 的 IM 工作台，而不是「系统异常」空参页。
 * 账号参数不写死：优先用缓存/标签发现的完整 URL；否则走 退出 → 首页点「顾客咨询」让平台自己带参。
 * 谁调用：processDouyin 扫列表前。
 */
async function ensureDouyinWorkbench(cfg, state, send, tabUrl) {
  const dy = cfg.platforms?.douyin || {};
  const homeBase = String(dy.homeUrl || "https://life.douyin.com/p/home").replace(/\?.*$/, "").trim();

  const snap = async () =>
    evaluate(
      send,
      `(() => {
        const t = (document.body && document.body.innerText) || '';
        const href = location.href || '';
        return {
          href,
          error: /系统异常/.test(t) && /IM工作台|重新进入|刷新页面/.test(t),
          home: /life\\.douyin\\.com\\/p\\/home/.test(href),
          hasAccount: /[?&]accountId=/.test(href),
          groupId: (href.match(/[?&]groupId=([^&]+)/) || [])[1] || '',
          hasCards: document.querySelectorAll('[class*="contactCard"], [class*="ContactCard"]').length > 0,
        };
      })()`
    ).catch(() => null);

  let st = await snap();
  if (st?.hasAccount && !st.error) {
    rememberDouyinWorkbenchUrl(cfg, state, st.href);
    return { ok: true, via: "ready", href: st.href };
  }
  if (isDouyinWorkbenchUrl(tabUrl) && st && !st.error) {
    rememberDouyinWorkbenchUrl(cfg, state, st.href || tabUrl);
    return { ok: true, via: "tab-url", href: st.href || tabUrl };
  }

  // 1) 用「上次成功 / 其它标签发现」的完整 URL 导航（不含写死账号）
  const known = await discoverDouyinWorkbenchUrl(cfg, state, tabUrl);
  if (known) {
    log(cfg, "DOUYIN workbench navigate cached/discovered");
    await send("Page.navigate", { url: known }).catch(() => {});
    await sleep(2800);
    st = await snap();
    if (st?.hasAccount && !st.error) {
      rememberDouyinWorkbenchUrl(cfg, state, st.href);
      return { ok: true, via: "navigate-discovered", href: st.href };
    }
  }

  // 2) 异常页点「退出」→ 商家首页（由平台带登录态）
  if (st?.error) {
    log(cfg, "DOUYIN workbench click 退出 (system error page)");
    const exitClicked = await evaluate(
      send,
      `(() => {
        const nodes = Array.from(document.querySelectorAll('button, a, [role="button"], div'));
        const hit = nodes.find((el) => ((el.innerText || '').trim() === '退出'));
        if (!hit) return { ok:false };
        hit.click();
        return { ok:true };
      })()`
    ).catch(() => ({ ok: false }));
    if (!exitClicked?.ok) await axClickName(send, "退出").catch(() => ({}));
    await sleep(2000);
    st = await snap();
  }

  // 3) 不在首页则打开基础首页；若当前/标签已有 groupId 则拼上（仍不写死）
  st = st || (await snap());
  if (st && !st.home && !st.hasAccount && homeBase) {
    let homeUrl = homeBase;
    let groupId = st.groupId || "";
    if (!groupId) {
      try {
        const tabs = await getJson(`${cfg.cdpUrl}/json/list`);
        for (const t of tabs || []) {
          const m = String(t.url || "").match(/[?&]groupId=([^&]+)/);
          if (m) {
            groupId = decodeURIComponent(m[1]);
            break;
          }
        }
      } catch {}
    }
    if (groupId) homeUrl = `${homeBase}?groupId=${encodeURIComponent(groupId)}`;
    log(cfg, "DOUYIN workbench navigate home", groupId ? `groupId=${groupId}` : "(no groupId)");
    await send("Page.navigate", { url: homeUrl }).catch(() => {});
    await sleep(2500);
    st = await snap();
  }

  // 4) 首页点右上角「顾客咨询」——平台会跳到带 accountId 的正确地址
  log(cfg, "DOUYIN workbench click 顾客咨询");
  const consult = await evaluate(
    send,
    `(() => {
      const nodes = Array.from(document.querySelectorAll('a, button, [role="button"], span, div'));
      const hit = nodes.find((el) => {
        const t = (el.innerText || '').replace(/\\s+/g, '');
        return t === '顾客咨询' || t.startsWith('顾客咨询') || /^顾客咨询\\d*\\+?$/.test(t);
      });
      if (!hit) return { ok:false };
      hit.click();
      return { ok:true, text: (hit.innerText || '').slice(0, 20) };
    })()`
  ).catch(() => ({ ok: false }));
  if (!consult?.ok) {
    const ax = await axClickName(send, "顾客咨询").catch(() => ({ ok: false }));
    if (!ax?.ok) {
      const nodes = await axNames(send).catch(() => []);
      const n = nodes.find((x) => /^顾客咨询/.test(String(x.name || "")));
      if (n?.name) await axClickName(send, n.name).catch(() => ({}));
    }
  }
  await sleep(3000);
  st = await snap();
  if (st?.hasAccount && !st.error) {
    rememberDouyinWorkbenchUrl(cfg, state, st.href);
    return { ok: true, via: "click-顾客咨询", href: st.href };
  }
  if (st?.hasCards) {
    if (st.href) rememberDouyinWorkbenchUrl(cfg, state, st.href);
    return { ok: true, via: "cards-visible", href: st.href };
  }
  return { ok: false, via: "failed", href: st?.href || tabUrl, error: st?.error };
}

/**
 * 用无障碍树列出页面上的控件名字（DOM 选不到时的备用读法）。
 * 谁调用：axClickName、读线程失败时的弱兜底。
 */
async function axNames(send) {
  await send("Accessibility.enable").catch(() => {});
  const ax = await send("Accessibility.getFullAXTree");
  return (ax.nodes || [])
    .map((n) => ({
      name: (n.name && n.name.value) || "",
      role: (n.role && n.role.value) || "",
      backendDOMNodeId: n.backendDOMNodeId,
    }))
    .filter((n) => n.name);
}

/**
 * 按控件显示名模拟鼠标点击。
 * 谁调用：openMeituanConversation 用 DOM 点不开时；抖音 open 失败时也可能走这路。
 */
async function axClickName(send, name) {
  const nodes = await axNames(send);
  const node = nodes.find((n) => n.name === name && n.backendDOMNodeId);
  if (!node) return { ok: false, reason: "not-found" };
  await send("DOM.enable").catch(() => {});
  const resolved = await send("DOM.resolveNode", { backendNodeId: node.backendDOMNodeId });
  const box = await send("Runtime.callFunctionOn", {
    objectId: resolved.object.objectId,
    functionDeclaration: `function() {
      this.scrollIntoView({block:'center'});
      const r = this.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2, w:r.width, h:r.height };
    }`,
    returnByValue: true,
  });
  const b = box.result && box.result.value;
  if (!b || typeof b.x !== "number") return { ok: false, reason: "no-box" };
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x, y: b.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", clickCount: 1 });
  return { ok: true, box: b };
}

/**
 * 在一段页面文字里，找出第一个出现的白名单昵称。
 * 谁调用：抖音扫列表等「整卡文字里抠名字」的地方。
 */
function whitelistHit(list, haystack) {
  const text = String(haystack || "");
  return (list || []).find((name) => name && text.includes(name)) || null;
}

/* ========== SECTION C：想好「回什么字」==========
 * 被谁用：processMeituan / processDouyin 在 claim 成功之后。
 * 顺序固定：查单 → 门店地址 → 知识库 → LLM/澄清。
 * 外调：order-lookup.js、kb-retrieve.js、OpenClaw gateway（LLM）。
 * ================================================================== */

/**
 * 根据顾客这句话，生成要发给顾客的纯文本。
 * 谁调用：process* 里每条未回话各调一次。
 * 顺序：
 *   1) 退款赔偿等 → 升级话术
 *   2) order-lookup → 查自有订单系统
 *   3) 问门店在哪 → 只查知识库地址卡（禁止 LLM 编地名）
 *   4) kb-retrieve → 知识库；命中可直发
 *   5) 闲聊可走 LLM；事实题没库 → 澄清，不编造
 * 返回：字符串，或 { escalate:true, reply } 表示别自动发、留给人工。
 */
async function generateReply(cfg, { platform, customer, lastCustomerMsg, recent }) {
  const msg = String(lastCustomerMsg || "");
  const kbCfg = cfg.knowledge || {};
  const onMiss = String(kbCfg.onMiss || "chat").toLowerCase();
  const wantLlm =
    cfg.gateway?.useLlm === true || onMiss === "chat" || onMiss === "llm";

  const escalateReply =
    "理解您的心情，涉及退款/赔偿我先帮您转人工核实处理，请稍等。也可先把订单号发我，方便加快核对。";
  const clarifyReply =
    "在的，亲。这个问题我这边还需要对照门店最新政策确认一下。方便再说下具体是哪个套餐/订单，或发张截图吗？我帮您准确答复。";

  const retrieveKb = async (query) => {
    if (!kbCfg.enabled || !kbRetrieve || typeof kbRetrieve.retrieve !== "function") {
      return { hits: [], meta: {} };
    }
    try {
      const result = await kbRetrieve.retrieve(query, {
        mode: kbCfg.mode || "local",
        rag: kbCfg.rag,
        fallbackLocal: kbCfg.fallbackLocal !== false,
        root: kbCfg.root,
        limit: kbCfg.limit || 3,
        embedding: kbCfg.embedding || {},
        weights: kbCfg.weights,
        wiki: kbCfg.wiki,
        gateway: cfg.gateway,
        platform,
        shopId: kbCfg.rag?.shopId,
        minScore: 0,
      });
      if (result.meta?.remoteError) {
        log(cfg, "KB_REMOTE_FAIL", result.meta.remoteError.slice(0, 120), "-> local fallback");
      }
      const minScore = kbCfg.minScore || 0.25;
      const hits = (result.hits || []).filter((h) => h.score >= minScore);
      return { hits, meta: result.meta || {} };
    } catch (e) {
      log(cfg, "KB_ERR", e.message || String(e));
      return { hits: [], meta: { error: String(e.message || e) } };
    }
  };

  const logKbHit = (hit, meta, q) => {
    const origin = String(meta?.mode || "").startsWith("remote")
      ? "remote"
      : meta?.fallbackFrom === "remote"
        ? "local-fallback"
        : "local";
    log(
      cfg,
      "KB_HIT",
      `via=${origin}`,
      `score=${Number(hit.score).toFixed(3)}`,
      `source=${hit.source}`,
      String(q).slice(0, 40)
    );
  };

  /** LLM 写出知识库/配置里没有的事实 → 视为编造（闲聊语气可以，事实不行） */
  const looksHallucinated = (reply, allowedBlob) => {
    const r = String(reply || "");
    const allowed = String(allowedBlob || "");
    if (!r) return false;
    const locs = r.match(/[\u4e00-\u9fff]{2,12}(广场|商场|中心|路|街|店)/g) || [];
    for (const loc of locs) {
      const stem = loc.replace(/(广场|商场|中心|路|街|店)$/, "");
      if (stem.length >= 2 && !allowed.includes(stem) && !allowed.includes(loc)) return true;
    }
    if (/(地址在|门店在|我们在|位于)/.test(r) && !/地址|路|号/.test(allowed)) return true;
    if (/0\d{2,3}-?\d{7,8}/.test(r) && !/0\d{2,3}-?\d{7,8}/.test(allowed)) return true;
    if (/\d+\s*元/.test(r) && !/\d+\s*元/.test(allowed)) return true;
    if (/\d+\s*[-~～到至]\s*\d+\s*(天|日|小时|个工作日)/.test(r) && !/\d+\s*(天|日|小时|工作日)/.test(allowed)) {
      return true;
    }
    if (/(干洗|水洗|可洗|不能洗|支持上门|不支持上门)/.test(r) && !/(干洗|水洗|可洗|上门)/.test(allowed)) {
      // 政策结论必须来自知识库/hints，禁止空口断言
      if (!/(普通衣鞋|窗帘|上门取件)/.test(allowed)) return true;
    }
    return false;
  };

  // 高风险：顾客主动要退款/赔偿/差评才升级；订单卡上的「退款成功」状态不算
  if (
    /(要退款|申请退款|给我退|退我钱|赔偿|差评|投诉)/.test(msg) ||
    (/退款/.test(msg) && !/退款成功/.test(msg) && !/订单编号/.test(msg))
  ) {
    log(cfg, "KB_ESCALATE", "high-risk", msg.slice(0, 40));
    return escalateReply;
  }

  // ---- 自有系统查单（systems.order）----
  if (orderLookup && typeof orderLookup.tryHandle === "function") {
    try {
      const handled = await orderLookup.tryHandle(cfg, msg, { recent: recent || [] });
      if (handled && handled.reply) {
        const meta = handled.meta || {};
        log(
          cfg,
          "ORDER_LOOKUP",
          meta.reason || "ok",
          `via=${meta.via || "?"}`,
          `orders=${(meta.orders || []).length}`,
          meta.keyword ? `kw=${String(meta.keyword).slice(0, 24)}` : "",
          msg.slice(0, 40)
        );
        if (handled.escalate) {
          return { escalate: true, reply: handled.reply };
        }
        return handled.reply;
      }
    } catch (e) {
      log(cfg, "ORDER_LOOKUP_FAIL", String(e.message || e).slice(0, 120));
    }
  }

  const isCasualChat = (t) => {
    const s = String(t || "").trim();
    if (!s) return true;
    if (/^(在吗|在不在|你好|您好|哈喽|嗨|hi|hello|早上好|晚上好|午安)/i.test(s)) return true;
    if (/干啥|逗你|哈哈|嘿嘿|嗯嗯|谢谢|感谢|收到|ok|OK|噢|哦|喔|摩西|欢迎光临/.test(s)) return true;
    if (/^(嗯|哦|噢|好|行|好的|谢谢了|麻烦了)[啊呀吧呢～~。.!！]*$/.test(s)) return true;
    return false;
  };

  const isPolicyFactQuestion = (t) => {
    const s = String(t || "").trim();
    if (!s || isCasualChat(s)) return false;
    return /(多少钱|什么价|价格|套餐|能洗|可以洗|干洗|水洗|时效|几天|多久|营业|几点|上门|取件|退款|赔偿|发票|叠加|地址|位置|到店|门店在哪|在哪)/.test(
      s
    );
  };

  // ---- 门店地址 / 到店：只查知识库；问店址时固定检索「门店地址」（勿用口语原句硬撞向量）----
  const recentBlob = (recent || []).join("\n");
  const askingStoreAddress =
    /门店.{0,8}(在哪|哪|地址|位置|定位)|店址|店在哪|你们地址|怎么走|导航|发定位|发(一下)?地址|位置在哪/.test(msg) ||
    (/^(需要|要|发一下|发我|发吧)$/.test(msg) && /位置|地址|定位|门店/.test(recentBlob));
  const askingAddress =
    askingStoreAddress && !/收件|寄件|取件地址|送件地址|不同地址|两个地址/.test(msg);
  if (askingAddress || /到店|自己送|送衣服|送洗/.test(msg)) {
    const q = askingAddress ? "门店地址" : "可以到店送衣服吗 门店地址";
    const { hits, meta } = await retrieveKb(q);
    const ans = hits[0]?.answer ? String(hits[0].answer) : "";
    if (ans && /地址|路|号|店/.test(ans)) {
      logKbHit(hits[0], meta, q);
      if (askingAddress) return `亲，门店地址：${ans.replace(/^门店地址[：:]?\s*/, "")}`;
      return `亲，可以自行到店送洗/核销。门店地址：${ans.replace(/^门店地址[：:]?\s*/, "")}`;
    }
    if (askingAddress) {
      log(cfg, "KB_MISS", "address", msg.slice(0, 40));
      return "亲，门店地址我这边要以资料为准，稍等帮您核对；也可先看团购/订单页的门店导航。";
    }
    return "亲，可以自行到店送洗/核销。需要地址的话直接问「门店在哪」，我按资料回复。";
  }

  // ---- 规则兜底 ----
  const fallback = () => {
    if (/上门|取件|取衣/.test(msg) && !/到店/.test(msg)) {
      return "亲，普通衣鞋目前暂不支持上门取件，一般需顾客自行到店送洗/核销；三室一厅窗帘可上门取送。需要我帮您看营业时间或团购怎么用吗？";
    }
    if (/干啥|在吗|你好|哈喽|在不在|嗨|hello|hi/i.test(msg)) {
      return "在的，亲～有什么可以帮您的？查订单、问套餐，或到店/送洗相关都可以直接说。";
    }
    if (/逗你|哈哈|嘿嘿|摩西/.test(msg)) {
      return "哈哈好的亲～有洗护或订单方面需要帮忙随时说一声就行。";
    }
    if (/谢谢|感谢|收到|好的呢|好的呀|麻烦了/.test(msg)) {
      return "不客气亲，有需要再叫我～";
    }
    if (/周末|周六|周日|星期[六日天]|休息日/.test(msg) && /用|去|到店|营业|开门|可以|能/.test(msg)) {
      return "亲，周末一般正常营业，团购券通常可用；若订单页标注了不可用日期，以订单详情为准。您方便说下是哪张团购/订单吗？我帮您核对。";
    }
    if (/不是我的|搞错|认错/.test(msg)) {
      return "抱歉让您误会了。请把订单号或订单截图发在本对话，我帮您核对具体是哪一单，避免对错信息。";
    }
    return "在的，亲。已收到～您直接说需求就行（查单、套餐、到店送洗都可以），我帮您看。";
  };

  const missReply = () => {
    if (
      isCasualChat(msg) ||
      /上门|取件|取衣|不是我的|搞错|认错|周末|周六|周日/.test(msg)
    ) {
      return fallback();
    }
    if (onMiss === "escalate") {
      return {
        escalate: true,
        reply: "【升级】知识库未命中，请人工核实后回复。诉求摘要：" + msg.slice(0, 80),
      };
    }
    if (onMiss === "fallback" || onMiss === "chat" || onMiss === "llm") {
      if (isPolicyFactQuestion(msg) && onMiss === "fallback") return clarifyReply;
      return fallback();
    }
    if (isPolicyFactQuestion(msg)) return clarifyReply;
    return fallback();
  };

  // ---- 知识库检索（原问句）----
  let kbHits = [];
  {
    const { hits, meta } = await retrieveKb(lastCustomerMsg);
    kbHits = hits;
    if (kbHits[0]) {
      logKbHit(kbHits[0], meta, lastCustomerMsg);
      if (kbCfg.preferKbAnswer !== false) return kbHits[0].answer;
      recent = [...kbHits.map((h) => `[知识库:${h.source}] ${h.answer}`), ...(recent || [])];
    } else {
      log(cfg, "KB_MISS", String(lastCustomerMsg).slice(0, 60));
    }
  }

  // 原则：闲聊可 LLM；事实题知识库未命中 → 禁止 LLM 自由发挥（防乱编）
  if (!kbHits.length && isPolicyFactQuestion(msg)) {
    log(cfg, "KB_MISS_NO_FABRICATE", "policy-fact", msg.slice(0, 40));
    const miss = missReply();
    if (miss && typeof miss === "object" && miss.escalate) {
      log(cfg, "KB_ESCALATE", "onMiss", msg.slice(0, 40));
      return miss;
    }
    // 事实题未命中：用澄清，不用闲聊兜底里可能带的模糊承诺
    if (typeof miss === "string" && isCasualChat(msg) === false && onMiss !== "escalate") {
      return clarifyReply;
    }
    return miss;
  }

  if (!kbHits.length && !wantLlm) {
    const miss = missReply();
    if (miss && typeof miss === "object" && miss.escalate) {
      log(cfg, "KB_ESCALATE", "onMiss", msg.slice(0, 40));
      return miss;
    }
    return miss;
  }

  if (!wantLlm) {
    if (kbHits.length) return kbHits[0].answer;
    return missReply();
  }

  // ---- LLM：仅闲聊 / 或「有知识库依据」时润色；严禁补充库外事实 ----
  let token = "";
  try {
    token = fs.readFileSync(cfg.gateway.tokenFile, "utf8").trim();
  } catch {
    log(cfg, "LLM_SKIP", "no gateway token → missReply");
    return kbHits[0]?.answer || missReply();
  }

  const allowedBlob = [
    ...(kbHits || []).map((h) => `${h.answer}\n${h.source || ""}`),
    ...(cfg.shopPolicyHints || []),
  ].join("\n");
  // recent 里可能含上次 LLM 编造内容，不计入 allowed（防污染）

  const system = [
    "你是本地生活洗护门店客服。只输出发给顾客的纯文本回复正文。",
    "禁止：解释过程、加引号、复述顾客原话、输出「顾客：」「客服：」角色标签、输出对话记录格式。",
    "【两条铁律】",
    "1) 可以闲聊：问候、语气、玩笑、承接上一句，自然简短即可。",
    "2) 禁止乱编：知识库/下方「可用事实」没有的内容，一律不准写——包括地址、电话、价格、时效、可洗范围、是否上门、订单状态、活动规则。",
    "知识库未命中且顾客在问事实：不要猜，可请对方补充关键细节；不要编造地名或数字。",
    "若有「可用事实」：只能复述其中要点，不得添加库外细节。",
    "遵守：" + (cfg.shopPolicyHints || []).join("；"),
    "短句、礼貌；一次最多问一个问题。",
  ].join("\n");

  const recentLines = (recent || []).slice(-RECENT_CONTEXT_N);
  const user = [
    `平台: ${platform}`,
    `顾客昵称: ${customer}`,
    `顾客最新消息: ${lastCustomerMsg}`,
    recentLines.length
      ? `最近对话(仅供承接语气，勿复述、勿抄格式):\n${recentLines.map((l) => `- ${l}`).join("\n")}`
      : "最近对话: 无",
    kbHits.length
      ? `可用事实(唯一事实来源)：${kbHits.map((h) => h.answer).join(" || ")}`
      : "可用事实：无（知识库未命中）。本轮只允许闲聊或请对方补充，禁止输出任何具体门店事实。",
    isCasualChat(msg) ? "本轮判定：闲聊。" : "本轮判定：非纯闲聊，若无可用事实不要回答具体政策。",
    "现在直接写出要发给顾客的一句话回复：",
  ].join("\n");

  try {
    const res = await requestJson(`${cfg.gateway.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: {
        model: cfg.gateway.model || "openclaw",
        temperature: isCasualChat(msg) ? 0.45 : 0.15,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      },
    });
    const content = res.json?.choices?.[0]?.message?.content;
    if (res.status >= 200 && res.status < 300 && content) {
      const text = sanitizeCustomerFacingReply(content);
      if (text && looksHallucinated(text, allowedBlob)) {
        log(cfg, "LLM_BLOCK_HALLUCINATION", msg.slice(0, 40), text.slice(0, 60));
        return kbHits[0]?.answer || (isCasualChat(msg) ? fallback() : clarifyReply);
      }
      if (text) {
        log(cfg, "LLM_CHAT", kbHits.length ? "with-kb" : "chat-only", msg.slice(0, 40));
        return text;
      }
    }
    log(cfg, "LLM_FALLBACK", res.status, (res.raw || "").slice(0, 120));
  } catch (e) {
    log(cfg, "LLM_ERR", e.message || String(e));
  }
  return kbHits[0]?.answer || (isCasualChat(msg) ? fallback() : clarifyReply);
}

/**
 * 清洗即将发出的字：去掉 LLM 误抄的「顾客：」「客服：」对话稿格式。
 * 谁调用：normalizeReplyResult、LLM 返回后。
 */
function sanitizeCustomerFacingReply(text) {
  let s = String(text || "").trim().replace(/^["「]|["」]$/g, "");
  if (!s) return s;
  if (/顾客[：:]/.test(s) && /客服[：:]/.test(s)) {
    const m = s.match(/客服[：:]\s*([\s\S]+)$/);
    if (m) s = m[1].trim();
  }
  s = s.replace(/^(客服|顾客|助理|AI|管理员)[：:]\s*/gm, "").trim();
  s = s
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !/^顾客[：:]/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return s;
}

/**
 * 把 generateReply 的返回值统一成 { escalate, reply }。
 * 谁调用：process* 拿到 replyRaw 后立刻调；escalate=true 则只写 pending 不点发送。
 */
function normalizeReplyResult(replyOrObj) {
  if (replyOrObj && typeof replyOrObj === "object") {
    return {
      escalate: !!replyOrObj.escalate,
      reply: sanitizeCustomerFacingReply(replyOrObj.reply || ""),
    };
  }
  return { escalate: false, reply: sanitizeCustomerFacingReply(replyOrObj || "") };
}

/* ========== SECTION D：在网页上动手 —— 扫列表 / 读聊天 / 点发送 ==========
 * 被谁用：processMeituan / processDouyin。
 * 美团特殊点：聊天在 iframe 里 → meituanChatDocExpr；还有「智能推荐」浮层要先关掉。
 * ================================================================== */

/**
 * 关掉经营宝「智能推荐回复」浮层（会挡住输入框和最新气泡）。
 * 谁调用：open 会话后、meituanSend 发送前。页面往往没关闭按钮，只能用 CSS 强藏。
 */
async function dismissMeituanSmartReply(send) {
  return evaluate(
    send,
    meituanChatDocExpr(`(doc) => {
      const STYLE_ID = 'oc-hide-smart-reply';
      const css =
        '.smart-reply-container,.smart-reply-main,[class*="smart-reply"]{' +
        'display:none!important;visibility:hidden!important;pointer-events:none!important;' +
        'height:0!important;max-height:0!important;overflow:hidden!important;opacity:0!important;}';
      let style = doc.getElementById(STYLE_ID);
      if (!style) {
        style = doc.createElement('style');
        style.id = STYLE_ID;
        style.textContent = css;
        (doc.head || doc.documentElement).appendChild(style);
      } else {
        style.textContent = css;
      }
      const nodes = doc.querySelectorAll('.smart-reply-container, .smart-reply-main, [class*="smart-reply"]');
      let hidden = 0;
      nodes.forEach((el) => {
        el.style.setProperty('display', 'none', 'important');
        el.style.setProperty('pointer-events', 'none', 'important');
        el.setAttribute('data-oc-smart-hidden', '1');
        hidden++;
      });
      // 若框架又插入节点，MutationObserver 再藏一次（只挂一次）
      if (!doc.documentElement.getAttribute('data-oc-smart-obs')) {
        doc.documentElement.setAttribute('data-oc-smart-obs', '1');
        const rehide = () => {
          doc.querySelectorAll('.smart-reply-container, .smart-reply-main').forEach((el) => {
            if (el.getAttribute('data-oc-smart-hidden') === '1' && getComputedStyle(el).display === 'none') return;
            el.style.setProperty('display', 'none', 'important');
            el.style.setProperty('pointer-events', 'none', 'important');
            el.setAttribute('data-oc-smart-hidden', '1');
          });
        };
        try {
          const mo = new MutationObserver(() => rehide());
          mo.observe(doc.body || doc.documentElement, { childList: true, subtree: true });
        } catch (_) {}
      }
      const stillVisible = Array.from(doc.querySelectorAll('.smart-reply-container')).some((el) => {
        const r = el.getBoundingClientRect();
        return r.height > 8 && getComputedStyle(el).display !== 'none';
      });
      return { ok: true, injected: true, hidden, still: stillVisible, noCloseBtn: true };
    }`)
  ).catch((e) => ({ ok: false, reason: String(e.message || e) }));
}

/**
 * 在美团当前聊天里发出一段文字：关智能推荐 → 写入输入框 → 点发送按钮。
 * 谁调用：processMeituan 在 generateReply 之后。成功后再 settleAfterSend。
 */
async function meituanSend(send, reply) {
  // 真正聊天框：pre.dzim-chat-input-container[contenteditable]
  // 智能推荐浮层会盖住输入区与最新气泡，发送前强制关掉
  let smart = await dismissMeituanSmartReply(send);
  await sleep(200);
  if (smart?.still || (smart?.roots || 0) > 0) {
    smart = await dismissMeituanSmartReply(send);
    await sleep(150);
  }

  const prep = await evaluate(
    send,
    meituanChatDocExpr(`(doc) => {
      const win = doc.defaultView;
      const reply = ${JSON.stringify(reply)};
      const smartClosed = ${JSON.stringify(!!(smart && (smart.hidden || smart.clicked || smart.roots)))};

      // 写入前再藏一次（防异步又弹出来）
      doc.querySelectorAll('.smart-reply-container, .smart-reply-main, [class*="smart-reply"]').forEach((el) => {
        el.style.setProperty('display', 'none', 'important');
        el.style.setProperty('pointer-events', 'none', 'important');
      });

      const box =
        doc.querySelector('pre.dzim-chat-input-container[contenteditable], .dzim-chat-input-container[contenteditable]') ||
        doc.querySelector('.dzim-chat-input-wrapper [contenteditable="plaintext-only"], .dzim-chat-input-wrapper [contenteditable="true"]') ||
        doc.querySelector('.dzim-input-area [contenteditable]');
      if (!box) return { ok:false, reason:'no-chat-pre', smartClosed, smart: ${JSON.stringify(smart || {})} };

      box.scrollIntoView({ block: 'center' });
      box.focus();
      box.click();
      // 清空并写入
      box.textContent = '';
      box.focus();
      try {
        doc.execCommand('selectAll', false, null);
        doc.execCommand('insertText', false, reply);
      } catch (e) {
        box.textContent = reply;
        box.dispatchEvent(new win.InputEvent('input', { bubbles:true, data: reply, inputType:'insertText' }));
      }
      box.dispatchEvent(new win.Event('input', { bubbles:true }));

      const btn =
        doc.querySelector('.dzim-chat-input-send button.dzim-button-primary') ||
        Array.from(doc.querySelectorAll('.dzim-chat-input-send button, .dzim-input-area button'))
          .find((b) => ((b.innerText || '').trim() === '发送') && b.getBoundingClientRect().width >= 40);

      const br = box.getBoundingClientRect();
      const sr = btn ? btn.getBoundingClientRect() : null;
      const f = document.querySelector('iframe[name="chat"]') || document.querySelector('iframe');
      const fr = f ? f.getBoundingClientRect() : { left: 0, top: 0 };
      return {
        ok: true,
        smartClosed,
        smart: ${JSON.stringify(smart || {})},
        hasBtn: !!btn,
        val: (box.textContent || '').slice(0, 40),
        box: { x: fr.left + br.left + br.width / 2, y: fr.top + br.top + br.height / 2, w: br.width, h: br.height },
        btn: sr ? { x: fr.left + sr.left + sr.width / 2, y: fr.top + sr.top + sr.height / 2, w: sr.width, h: sr.height } : null
      };
    }`)
  ).catch((e) => ({ ok: false, reason: String(e.message || e) }));

  if (!prep?.ok) {
    // 回退：AX + Enter
    const nodes = await axNames(send);
    const boxNode = nodes.find((n) => n.role === "textbox" && n.backendDOMNodeId && /回复|输入/.test(n.name || ""));
    if (boxNode) {
      await send("DOM.enable").catch(() => {});
      await send("DOM.focus", { backendNodeId: boxNode.backendDOMNodeId }).catch(() => {});
    }
    await send("Input.insertText", { text: reply });
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    return { ok: true, via: "ax-enter-fallback", prep };
  }

  // CDP 聚焦 contenteditable + insertText + Enter（经营宝：Enter 发送）
  if (prep.box && Number.isFinite(prep.box.x) && prep.box.w > 100) {
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: prep.box.x,
      y: Math.max(1, prep.box.y),
      button: "left",
      clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: prep.box.x,
      y: Math.max(1, prep.box.y),
      button: "left",
      clickCount: 1,
    });
    await sleep(100);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65 });
    await send("Input.insertText", { text: reply });
    await sleep(200);
  }

  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await sleep(250);

  // 再点主发送（.dzim-chat-input-send 内）
  if (prep.btn && prep.btn.w >= 40) {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: prep.btn.x, y: prep.btn.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: prep.btn.x, y: prep.btn.y, button: "left", clickCount: 1 });
  } else {
    await evaluate(
      send,
      meituanChatDocExpr(`(doc) => {
        const btn = doc.querySelector('.dzim-chat-input-send button') ||
          Array.from(doc.querySelectorAll('button')).find(b => ((b.innerText||'').trim()==='发送') && b.getBoundingClientRect().width>=50 && !String(b.className).includes('small'));
        if (!btn) return false;
        btn.click();
        return true;
      }`)
    ).catch(() => false);
  }
  return { ok: true, via: "pre-contenteditable", prep };
}

/**
 * 美团：发送后轮询，直到右侧出现我们刚发的气泡（或超时）。
 * 谁调用：settleAfterSend（platform=meituan）。
 */
async function waitMeituanReplyVisible(send, reply, timeoutMs = 6000) {
  const needle = String(reply || "").trim().slice(0, 36);
  if (!needle) return { ok: false, reason: "empty" };
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = await evaluate(
      send,
      meituanChatDocExpr(`(doc) => {
        const needle = ${JSON.stringify(needle)};
        const body = (doc.body && doc.body.innerText) || '';
        if (body.includes(needle)) return { ok:true, via:'body' };
        const rights = Array.from(doc.querySelectorAll('.right-message, [class*="right-message"]'))
          .map(el => (el.innerText || '').trim()).filter(Boolean);
        const ok = rights.some(t => t.includes(needle));
        return { ok, via:'right', last: (rights[rights.length - 1] || '').slice(0, 60) };
      }`)
    ).catch(() => null);
    if (hit?.ok) return { ok: true, ...hit, ms: Date.now() - started };
    await sleep(350);
  }
  return { ok: false, timeout: true, ms: timeoutMs };
}

/**
 * 在抖音当前聊天里发出一段文字。
 * 谁调用：processDouyin，用法同 meituanSend。
 */
async function douyinSend(send, reply) {
  const typed = await evaluate(
    send,
    `(() => {
      const text = ${JSON.stringify(reply)};
      const phOf = (el) => el.getAttribute('placeholder') || el.getAttribute('aria-label') || '';
      // 排除搜索框、以及页面里藏着业务 JSON 的假 textarea（会吃掉 value，导致「假发送」）
      const isBad = (el) => {
        const ph = phOf(el);
        if (/用户昵称|聊天记录|请输入订单号|搜索/.test(ph)) return true;
        const cur = String(el.value != null ? el.value : (el.innerText || '')).trim();
        if (/bizConversationId|countdownTime|"countdown"\\s*:/.test(cur)) return true;
        if (cur.startsWith('[{') || cur.startsWith('{"')) return true;
        const r = el.getBoundingClientRect();
        if (r.width < 80 || r.height < 20) return true;
        // 输入框应在下半屏附近
        if (r.y < window.innerHeight * 0.35) return true;
        return false;
      };
      const score = (el) => {
        const ph = phOf(el);
        let s = 0;
        if (/请输入|输入消息|说点什么|回复/.test(ph)) s += 50;
        const r = el.getBoundingClientRect();
        s += Math.min(40, r.y / 20); // 越靠下越好
        s += Math.min(20, r.width / 40);
        if ((el.className || '').toString().match(/editor|composer|input|im-/i)) s += 15;
        return s;
      };
      const textareas = Array.from(document.querySelectorAll('textarea')).filter((el) => !isBad(el));
      const editables = Array.from(document.querySelectorAll('[contenteditable="true"], div[role="textbox"]')).filter((el) => !isBad(el));
      const cands = [...textareas, ...editables].sort((a, b) => score(b) - score(a));
      const el = cands[0];
      if (!el) return { ok:false, reason:'no-composer', textareaCount: document.querySelectorAll('textarea').length };
      el.focus();
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        const got = String(el.value || '');
        // 写入后仍是 JSON / 对不上 → 认失败，别假装 ok
        if (/bizConversationId/.test(got) || !got.includes(text.slice(0, Math.min(12, text.length)))) {
          return { ok:false, reason:'wrong-textarea', via: el.tagName.toLowerCase(), value: got.slice(0, 120) };
        }
        return { ok:true, via: el.tagName.toLowerCase(), value: got.slice(0, 120) };
      }
      el.textContent = '';
      document.execCommand('selectAll', false, null);
      const ok = document.execCommand('insertText', false, text);
      if (!ok) el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      const got = String(el.innerText || '');
      if (!got.includes(text.slice(0, Math.min(12, text.length)))) {
        return { ok:false, reason:'wrong-editable', value: got.slice(0, 120) };
      }
      return { ok:true, via:'contenteditable', value: got.slice(0, 120) };
    })()`
  );
  if (!typed?.ok) return { ok: false, reason: typed?.reason || "no-textarea", typed };
  await sleep(200);
  const sent = await evaluate(
    send,
    `(() => {
      const text = ${JSON.stringify(reply)};
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      // 优先找输入框附近的「发送」；来客常用纸飞机图标按钮
      let sendBtn =
        buttons.find((b) => {
          const t = (b.innerText || '').trim();
          if (t !== '发送') return false;
          const r = b.getBoundingClientRect();
          return r.y > window.innerHeight * 0.4 && r.width > 20;
        }) ||
        buttons.find((b) => (b.innerText || '').trim() === '发送') ||
        document.querySelector('button.life-im-pc-btn-type-primary') ||
        Array.from(document.querySelectorAll('button, [role="button"], [class*="send"]')).find((b) => {
          const r = b.getBoundingClientRect();
          if (r.y < window.innerHeight * 0.5 || r.width < 16 || r.height < 16) return false;
          const aria = (b.getAttribute('aria-label') || '') + (b.getAttribute('title') || '');
          return /发送|send/i.test(aria) || /send/i.test(String(b.className || ''));
        });
      if (sendBtn) {
        sendBtn.click();
      } else {
        // 无按钮：对输入框派发 Enter（页面提示「按Enter发送」）
        const areas = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).filter((el) => {
          const r = el.getBoundingClientRect();
          return r.y > window.innerHeight * 0.35 && r.width > 80;
        });
        const el = areas[areas.length - 1];
        if (!el) return { ok:false, reason:'no-send-btn' };
        el.focus();
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      }
      // 发送后输入框应清空；若仍是整段回复，多半没发出去
      const still = Array.from(document.querySelectorAll('textarea')).map((t) => t.value || '').join('');
      const stuck = still.includes(text.slice(0, Math.min(16, text.length)));
      return { ok: !stuck, via: sendBtn ? 'button' : 'enter', stuck };
    })()`
  );
  if (!sent?.ok) return { ok: false, reason: sent?.reason || (sent?.stuck ? "composer-still-has-text" : "send-click-failed"), typed, sent };
  return { ok: true, typed, sent };
}

/**
 * 抖音：发送后等到自己的气泡出现（或超时）。
 * 谁调用：settleAfterSend（platform=douyin）。
 */
async function waitDouyinReplyVisible(send, reply, timeoutMs = 6000) {
  const needle = String(reply || "").trim().slice(0, 36);
  if (!needle) return { ok: false, reason: "empty" };
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = await evaluate(
      send,
      `(() => {
        const needle = ${JSON.stringify(needle)};
        // 只认客服侧（右侧）气泡，避免输入框/空气泡误判成功
        const nodes = Array.from(document.querySelectorAll('.chatd-message, [class*="chatd-message"], [class*="message-item"]'));
        const selfTexts = [];
        for (const el of nodes) {
          const cls = String(el.className || '');
          const self = cls.includes('chatd-message--right') || cls.includes('--right') || cls.includes('self')
            || !!el.querySelector('.chatd-bubble--self, [class*="bubble--self"], [class*="--right"]');
          if (!self) continue;
          const t = (el.innerText || '').replace(/^管理员\\s*/, '').trim();
          if (t.length > 2) selfTexts.push(t);
        }
        const ok = selfTexts.some(t => t.includes(needle));
        return { ok, last: (selfTexts[selfTexts.length - 1] || '').slice(0, 60), n: selfTexts.length };
      })()`
    ).catch(() => null);
    if (hit?.ok) return { ok: true, ...hit, ms: Date.now() - started };
    await sleep(350);
  }
  return { ok: false, timeout: true, ms: timeoutMs };
}

/**
 * 发送后等到「自己的气泡」出现（或超时），再去做下一句/下一个会话。
 * 谁调用：meituanSend / douyinSend 成功之后。避免话还没刷出来就切走。
 */
async function settleAfterSend(cfg, platform, send, reply) {
  const waitMs = cfg.waitAfterSendMs ?? 2000;
  const visible =
    platform === "meituan"
      ? await waitMeituanReplyVisible(send, reply)
      : await waitDouyinReplyVisible(send, reply);
  if (!visible.ok) {
    log(cfg, platform.toUpperCase(), "settle timeout, extra wait", waitMs);
    await sleep(waitMs);
    return visible;
  }
  log(cfg, platform.toUpperCase(), "settle ok", `${visible.ms}ms`, "+", waitMs);
  await sleep(waitMs);
  return visible;
}

/**
 * 清洗抖音气泡原文：去掉「昨天, 17:38」这类时间行，留下真正的话。
 * 订单卡片优先抽出「订单编号 + 数字」，避免纯数字行被当成日期丢掉只剩「订单编号」。
 * 谁调用：processDouyin 读气泡、从列表预览取句时。
 */
function normalizeCustomerMsg(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";

  // 抖音/来客订单卡：innerText 常为多行「…\n订单编号\n111111…」
  const cardNo =
    text.match(/订单编号\s*[:：#]?\s*([A-Za-z0-9_-]{8,})/i) ||
    text.match(/订单号\s*[:：#]?\s*([A-Za-z0-9_-]{6,})/i) ||
    text.match(/订单编号[\s\S]{0,12}?(\d{12,22})/);
  if (cardNo) {
    return `订单编号 ${cardNo[1]}`.slice(0, 200);
  }

  const lines = text
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const meaningful = lines.filter(
    (l) =>
      !/^(昨天|今天|前天|刚刚|星期[一二三四五六日天]|周[一二三四五六日天])/.test(l) &&
      !/^\d{1,2}:\d{2}(:\d{2})?$/.test(l) &&
      !/^\d{1,2}月\d{1,2}日/.test(l) &&
      // 长纯数字多半是平台订单号，勿当日期丢掉
      !(/^[\d年月日/\-.\s,:]+$/.test(l) && !/^\d{10,}$/.test(l)) &&
      !/^(昨天|今天|前天)[,，\s]*\d{1,2}:\d{2}$/.test(l)
  );
  // 上一行是「订单编号」且本行是长数字 → 拼回完整句
  for (let i = 0; i < lines.length - 1; i++) {
    if (/^订单编号$/.test(lines[i]) && /^\d{10,}$/.test(lines[i + 1])) {
      return `订单编号 ${lines[i + 1]}`.slice(0, 200);
    }
  }
  const pick = meaningful.length ? meaningful[meaningful.length - 1] : lines[lines.length - 1] || "";
  return pick
    .replace(/^(昨天|今天|前天)[,，\s]*\d{1,2}:\d{2}\s*/g, "")
    .trim()
    .slice(0, 200);
}

/** 生成回复时附带的最近气泡条数（客服+顾客合计） */
const RECENT_CONTEXT_N = 5;

/**
 * 把最近几条聊天气泡收成「[顾客] xxx / [客服] xxx」，传给 generateReply。
 * 谁调用：process* 调 generateReply 时。用来承接短句（如顾客只回「需要」）。
 */
function formatRecentContext(msgsOrTexts, n = RECENT_CONTEXT_N) {
  if (!Array.isArray(msgsOrTexts) || !msgsOrTexts.length) return [];
  const first = msgsOrTexts[0];
  if (first && typeof first === "object" && ("t" in first || "self" in first)) {
    return msgsOrTexts
      .slice(-n)
      .map((m) => {
        const t = String(m?.t || "").trim().replace(/\s+/g, " ").slice(0, 120);
        if (!t || isUiChromeText(t)) return "";
        return `[${m.self ? "客服" : "顾客"}] ${t}`;
      })
      .filter(Boolean);
  }
  return msgsOrTexts
    .map((t) => String(t || "").trim().replace(/\s+/g, " ").slice(0, 120))
    .filter((t) => t && !isUiChromeText(t))
    .slice(-n);
}

/**
 * 是不是界面垃圾文案（导航、商品卡、加载中、表单标签…）而不是顾客话。
 * 注意：不按「太短」过滤——「需要」「在哪」也是有效顾客句。
 * 谁调用：挑未回话、formatRecentContext、读气泡时过滤噪声。
 */
function isUiChromeText(t) {
  const s = String(t || "").trim();
  if (!s) return true;
  // 订单卡/带单号的顾客消息：绝不当界面垃圾
  if (/订单编号\s*[A-Za-z0-9_-]{6,}/i.test(s) || /订单号\s*[A-Za-z0-9_-]{6,}/i.test(s)) return false;
  if (/^订单编号\s+\d{10,}$/.test(s)) return false;
  // 平台订单号（长纯数字）不是价格/UI
  if (/^\d{12,22}$/.test(s)) return false;
  // 「加载中...」「暂无消息」等：允许后缀省略号/空白
  if (/^(加载中|暂无消息|未知|待回复|发送|请输入|卡片消息|\[卡片消息\])/.test(s)) return true;
  // 列表时间预览（曾被当成顾客句狂刷：「30秒前」）
  if (/^(\d+\s*(秒|分钟|小时|天)前|刚刚|刚才)$/.test(s)) return true;
  if (/Shift\s*\+\s*Enter|Enter发送|换行/.test(s)) return true;
  if (/^(商品图标|性别|年龄|城市|备注|姓名|手机|电话|地址)$/.test(s)) return true;
  // 商品卡短标签（T恤/外套）——无问句语气时当 UI，不当顾客咨询
  if (/^(T恤|外套|衬衫|大衣|羽绒服|鞋|鞋子|窗帘|任洗|专洗|专护)$/i.test(s)) return true;
  return (
    (/^[\d.¥￥\s%-]+$/.test(s) && !/^\d{12,22}$/.test(s)) ||
    /^(消息|顾客管理|店铺数据|基础设置|会话顾客|黑名单|全部门店|在线|商品|促销|团购|来源:|美团|\d{1,2}:\d{2}|昨天|刚才|搜索商品名称|欢迎光临)$/.test(s) ||
    /^(昨天|今天|前天)[,，\s]*\d{1,2}:\d{2}$/.test(s) ||
    /^【/.test(s) ||
    /新用户进线|请及时回复|您的信息无法提交|请重新输入|浏览器通知|功能介绍|排队人数|今日接待|不响应率|分钟回复率/.test(s) ||
    /任洗|专洗|专护|洗护|窗帘清洗|运动鞋球鞋|换季无忧|外套专洗|鞋靴养护|总价|券数|下单时间|订单有效期|商品图标/.test(s)
  );
}

/**
 * 粗看一句像不像客服口吻（「在的」「亲，」…）。
 * 只用于没气泡时的弱判断；有左右气泡时以 self 字段为准，别靠这个拍板。
 * 谁调用：无序兜底挑句、部分预览过滤、防把自己回复碎片当顾客话。
 */
function isAgentLikeText(t) {
  const s = String(t || "");
  return (
    /^(在的|抱歉|亲[，,：:]|亲爱的|理解您|您好|好的，我|好的，请)/.test(s) ||
    s.includes("已收到您的消息") ||
    s.includes("方便说下具体需求") ||
    s.includes("暂不支持上门") ||
    s.includes("转人工") ||
    s.includes("对照门店最新政策") ||
    s.includes("帮您准确答复") ||
    s.includes("我可以帮您查进度") ||
    s.includes("把订单号") ||
    s.includes("门店地址") ||
    // 查单结果行（勿把顾客「查一下yl_xxx」误判成客服）
    (/(查到|相关订单|｜已签收|｜待清洗|｜清洗中)/.test(s) && /yl_[a-zA-Z0-9]{4,}/i.test(s))
  );
}

/**
 * 粗判像不像顾客说的话（关键词/短中文）。
 * 谁调用：只有「读不到有序气泡」时的兜底。有左右气泡时不要用它否决左侧句。
 * opts.strict=true：无未读/待回复时用——必须像真问句，拒绝商品名碎片。
 */
function looksLikeCustomerUtterance(t, opts = {}) {
  const s = String(t || "").trim();
  if (!s || isUiChromeText(s) || isAgentLikeText(s)) return false;
  const askLike =
    /[吗麼么呢吧啊哟哦哈]|怎么|怎样|可以|能不能|多少|几天|上门|取件|退款|订单|在吗|干啥|你好|哈喽|地址|位置|到店|门店|需要|好的|谢谢|在哪|什么时候/.test(
      s
    );
  if (askLike) return true;
  // 订单卡 / 平台长单号
  if (/订单编号/.test(s) || /^\d{12,22}$/.test(s) || /^订单编号\s+\S+/.test(s)) return true;
  if (opts.strict) return false;
  // 短句（需要/好的/在哪）也算顾客表达；纯商品名已被 isUiChromeText 挡掉
  if (/[\u4e00-\u9fff]/.test(s) && s.length <= 20 && !/任洗|专护|洗护套餐/.test(s)) return true;
  if (s.length >= 6 && /[\u4e00-\u9fff]/.test(s) && !/任洗|专护|洗护套餐/.test(s)) return true;
  return false;
}

/**
 * 这句是不是「自己刚回过的内容」的碎片（长气泡被 DOM 拆碎后误标成左侧）。
 * 谁调用：listUnrepliedCustomerFromBubbles。
 */
function isFragmentOfAgentMsgs(text, ordered) {
  const s = String(text || "").trim();
  if (!s || s.length < 4) return false;
  const agents = (ordered || []).filter((m) => m?.self).map((m) => String(m.t || "").replace(/\s+/g, " "));
  return agents.some((a) => a.length > s.length && a.includes(s.replace(/\s+/g, " ")));
}

/**
 * 美团聊天真正在 iframe 里，主页面只是外壳。
 * 本函数把「在 iframe 文档里跑的 JS」包好，给 evaluate 用。
 * 谁调用：扫列表、读气泡、发送、关智能推荐 —— 美团几乎所有 DOM 操作。
 */
function meituanChatDocExpr(innerFn) {
  return `(() => {
    const f = document.querySelector('iframe[name="chat"]') || document.querySelector('iframe');
    if (!f) return null;
    let doc = null;
    try { doc = f.contentDocument || (f.contentWindow && f.contentWindow.document); } catch (e) { return null; }
    if (!doc) return null;
    return (${innerFn})(doc);
  })()`;
}

/**
 * 读美团当前打开的聊天：左右气泡列表。
 * 谁调用：processMeituan 点进会话之后。
 * 返回 msgs:[{ self:是否客服侧, t:文字 }] → 交给 listUnreplied* 判断谁没回。
 */
async function readMeituanThread(send, customer) {
  const dom = await evaluate(
    send,
    meituanChatDocExpr(`(doc) => {
      // 只取最外层 message-wrapper，避免内层节点把一句话拆成多条、或把商品卡当气泡
      const nodes = Array.from(
        doc.querySelectorAll('.message-wrapper.left-message, .message-wrapper.right-message')
      );
      const msgs = [];
      for (const el of nodes) {
        const cls = String(el.className || '');
        const self = /right-message/.test(cls);
        const tEl = el.querySelector('.text-message, .normal-text, .message-detail') || el;
        let t = (tEl.innerText || '').trim();
        // 订单卡：保留「订单编号 + 单号」；其它大段卡片只留首行，避免整卡进对话
        if (/订单编号/.test(t)) {
          const m = t.match(/订单编号\\s*[:：#]?\\s*([A-Za-z0-9_-]{8,})/i)
            || t.match(/订单编号[\\s\\S]{0,12}?(\\d{12,22})/);
          if (m) t = '订单编号 ' + m[1];
          else if (t.length > 220) t = t.slice(0, 220);
        } else if (t.length > 120) {
          t = t.split(/\\n/).map((x) => x.trim()).filter(Boolean)[0] || t.slice(0, 120);
        }
        if (!t) continue;
        const prev = msgs[msgs.length - 1];
        if (prev && prev.t === t && prev.self === self) continue;
        msgs.push({ self, t });
      }
      const left = msgs.filter((m) => !m.self).map((m) => m.t);
      const right = msgs.filter((m) => m.self).map((m) => m.t);
      return { msgs: msgs.slice(-40), left: left.slice(-12), right: right.slice(-12), all: msgs.map((m) => m.t).slice(-20) };
    }`)
  ).catch(() => ({ msgs: [], left: [], right: [], all: [] }));

  if (dom?.msgs?.length || dom?.left?.length) {
    const ordered = (Array.isArray(dom.msgs) ? dom.msgs : [])
      .map((m) => ({ self: !!m.self, t: String(m.t || "").trim() }))
      .filter((m) => m.t && !isUiChromeText(m.t));
    let lastCustomerMsg = "";
    for (let i = ordered.length - 1; i >= 0; i--) {
      const m = ordered[i];
      if (m.self) continue;
      if (!looksLikeCustomerUtterance(m.t) || isUiChromeText(m.t)) continue;
      lastCustomerMsg = m.t;
      break;
    }
    if (!lastCustomerMsg && dom.left?.length) {
      lastCustomerMsg = [...dom.left].reverse().find((t) => looksLikeCustomerUtterance(t) && !isUiChromeText(t)) || "";
    }
    return {
      recent: (dom.all || []).filter((t) => t && !isUiChromeText(t)).slice(-16),
      msgs: ordered,
      right: (dom.right || []).filter((t) => t && !isUiChromeText(t)),
      left: (dom.left || []).filter((t) => t && !isUiChromeText(t)),
      lastCustomerMsg,
      source: ordered.length ? "dom-ordered" : "dom-left",
    };
  }

  const after = await axNames(send);
  const texts = after.map((n) => n.name).filter((t) => t && t !== customer && t !== "yongxinxihu" && !isUiChromeText(t));
  const dedup = [];
  for (const t of texts) {
    if (dedup[dedup.length - 1] !== t) dedup.push(t);
  }
  const last = [...dedup].reverse().find((t) => looksLikeCustomerUtterance(t)) || "";
  return { recent: dedup.filter(looksLikeCustomerUtterance).slice(-16), msgs: [], lastCustomerMsg: last, source: "ax-filtered" };
}

/**
 * 扫美团左侧会话列表：昵称、未读数、是否「待回复」、预览句、chatId。
 * 谁调用：processMeituan 连上 tab 后第一步。结果交给 pickTargetsFromList。
 * 同名多条会都留下（带 listIndex），后面按条点开，不会合并成一个人。
 */
async function scanMeituanChatList(send) {
  const dom = await evaluate(
    send,
    meituanChatDocExpr(`(doc) => {
      const items = Array.from(doc.querySelectorAll('.chat-list-item'));
      const rows = [];
      for (let i = 0; i < items.length; i++) {
        const el = items[i];
        const nameEl = el.querySelector('.userinfo-username, [class*="username"]');
        const lastEl = el.querySelector('.userinfo-lastchat, [class*="lastchat"]');
        const timeEl = el.querySelector('.userinfo-chattime, [class*="chattime"]');
        const badgeTextEl = el.querySelector('.mtd-badge-text');
        const name = ((nameEl && nameEl.innerText) || '').trim();
        if (!name) continue;
        let unread = 0;
        if (badgeTextEl && !String(badgeTextEl.className || '').includes('mtd-badge-hidden')) {
          const badgeText = (badgeTextEl.innerText || '').trim();
          const n = parseInt(badgeText, 10);
          unread = Number.isFinite(n) && n > 0 ? n : 1;
        }
        const rowText = (el.innerText || '');
        const tagText = ((el.querySelector('.operation-info-tags, .dzim-chat-operation, .operation-info, [class*="tag"], [class*="Tag"]') || {}).innerText || '').trim();
        // 待回复角标文案多变：待回复 / 未回复 / 超时未回
        const pendingReply =
          tagText.includes('待回复') ||
          tagText.includes('未回复') ||
          /(^|[\\s\\n])待回复([\\s\\n]|$)/.test(rowText) ||
          /(^|[\\s\\n])未回复([\\s\\n]|$)/.test(rowText) ||
          /超时未回|等待回复/.test(rowText);
        // 经营宝同昵称多会话：.chat-list-item 上有 data-chatid / id
        let chatId = el.getAttribute('data-chatid') || el.getAttribute('data-chat-id') || el.getAttribute('data-id')
          || el.getAttribute('data-session-id') || el.id || '';
        if (!chatId) {
          const a = el.querySelector('[data-chatid], [data-chat-id], [data-id], [data-session-id]');
          if (a) {
            chatId = a.getAttribute('data-chatid') || a.getAttribute('data-chat-id') || a.getAttribute('data-id') || a.getAttribute('data-session-id') || '';
          }
        }
        rows.push({
          name,
          unread,
          pendingReply,
          last: (((lastEl && lastEl.innerText) || '').trim()).slice(0, 100),
          time: (((timeEl && timeEl.innerText) || '').trim()).slice(0, 20),
          chatId: String(chatId || '').slice(0, 80),
          listIndex: i
        });
      }
      return rows;
    }`)
  ).catch(() => null);

  if (Array.isArray(dom) && dom.length) return { rows: dom, source: "iframe-dom" };

  // DOM 空时：用 AX 粗提取（无精确 badge，unread 默认 0）；仅保留像昵称的项
  const names = await axNames(send);
  const ignore = new Set(["消息", "顾客管理", "店铺数据", "基础设置", "会话顾客", "黑名单", "全部门店", "在线", "发送", "请输入", "待回复"]);
  const rows = [];
  let listIndex = 0;
  for (const n of names) {
    const name = n.name;
    if (!name || ignore.has(name)) continue;
    if (name.length < 2 || name.length > 24) continue;
    if (/^\d+$/.test(name) || /^\d{1,2}:\d{2}$/.test(name) || name === "昨天") continue;
    if (/任洗|专护|洗护|【|商品|促销|来源/.test(name)) continue;
    rows.push({ name, unread: 0, pendingReply: false, last: "", time: "", listIndex: listIndex++ });
  }
  return { rows, source: "ax-fallback" };
}

/**
 * 这一行会话要不要在「非白名单模式」里处理：有未读或挂着「待回复」。
 * 谁调用：pickTargetsFromList（onlyActionable 时）。
 */
function isActionableRow(r) {
  return !!(r && ((r.unread || 0) > 0 || r.pendingReply));
}

/**
 * 配置里的白名单名字，和列表上的昵称是否对得上（全等，或足够长的包含）。
 * 谁调用：pickTargets、processMeituan 把列表行对到 whitelist 项。
 */
function whitelistNameMatch(whitelistName, candidateName) {
  const w = String(whitelistName || "").trim();
  const c = String(candidateName || "").trim();
  if (!w || !c) return false;
  if (w === c) return true;
  // 禁止用超短片段做 includes（避免 "1" 命中 AXw710416874）
  if (w.length < 2 || c.length < 2) return false;
  if (c.includes(w)) return true;
  if (w.length >= 4 && c.length >= 4 && w.includes(c)) return true;
  return false;
}

/* ========== SECTION E：挑「进哪个会话」和「回哪几句话」==========
 * 被谁用：process* 在扫列表之后、打开会话 / 生成回复之前。
 * 原则：白名单会话都进；真有没有待回，进聊天看气泡，不信列表预览。
 * ================================================================== */

/**
 * 从会话列表里挑本轮要处理的人。
 * 谁调用：scan* 之后。排序：未读多的优先。
 *
 * 白话：
 *   whitelistOnly=true 且白名单非空 → 只进名单（不看角标，进线后靠气泡判断）
 *   onlyActionable=true → 优先未读/待回；角标全丢时兜底：
 *     - 有白名单 → 仍进白名单看气泡（防美团角标扫不到导致永不回）
 *     - 无白名单 → 用列表预览像顾客问句的行兜底
 */
function pickTargetsFromList(rows, whitelist, opts = {}) {
  const list = (whitelist || []).map((x) => String(x || "").trim()).filter(Boolean);
  const onlyActionable = opts.onlyActionable !== false;
  // 默认 false：不配白名单就回所有人；显式 true 才锁名单
  const whitelistOnly = opts.whitelistOnly === true;
  const maxTargets = Math.max(1, Number(opts.maxTargetsPerTick) || 8);

  let matched = rows || [];
  if (whitelistOnly && list.length) {
    matched = matched.filter((r) => list.some((w) => whitelistNameMatch(w, r.name)));
  } else if (onlyActionable) {
    const actionable = matched.filter((r) => isActionableRow(r));
    if (actionable.length) {
      matched = actionable;
    } else if (list.length) {
      // 角标扫不到时：白名单仍进线，靠气泡决定要不要回
      matched = matched.filter((r) => list.some((w) => whitelistNameMatch(w, r.name)));
    } else {
      // 全量模式角标丢了：预览像真问句的才进（避免空转点遍列表）
      matched = matched.filter(
        (r) =>
          looksLikeCustomerUtterance(r.last, { strict: true }) &&
          !isAgentLikeText(r.last) &&
          !isUiChromeText(r.last)
      );
    }
  }

  matched = matched.slice().sort((a, b) => {
    const ua = a.unread || 0;
    const ub = b.unread || 0;
    if (ub !== ua) return ub - ua;
    const pa = a.pendingReply ? 1 : 0;
    const pb = b.pendingReply ? 1 : 0;
    if (pb !== pa) return pb - pa;
    return (a.listIndex || 0) - (b.listIndex || 0);
  });
  return matched.slice(0, maxTargets);
}

/**
 * 合并「全局 + 美团/抖音平台」的选会话开关（白名单-only、每轮最多几个等）。
 * 谁调用：processMeituan / processDouyin 开头。
 * 默认 whitelistOnly=false（全量可回）；根配置 true 时平台不能擅自放宽。
 */
function targetPickOpts(cfg, platformCfg = {}) {
  // 显式 true 才开启「仅白名单」；未配置 / false = 可回所有人
  const globalWhitelistOnly = cfg.whitelistOnly === true;
  let whitelistOnly;
  if (globalWhitelistOnly) {
    whitelistOnly = true;
  } else if (platformCfg.whitelistOnly !== undefined) {
    whitelistOnly = platformCfg.whitelistOnly === true;
  } else {
    whitelistOnly = false;
  }
  return {
    onlyActionable: platformCfg.onlyActionable !== undefined ? platformCfg.onlyActionable : cfg.onlyActionable !== false,
    whitelistOnly,
    maxTargetsPerTick: platformCfg.maxTargetsPerTick || cfg.maxTargetsPerTick || 8,
    preferUnread: platformCfg.preferUnread !== false && cfg.preferUnread !== false,
  };
}

/**
 * 现在能不能真的点发送？false = 只写 pending，不发出去。
 * 谁调用：process* 在 send 之前。全局或平台任一层 autoSend=false 都会拦住。
 */
function isAutoSend(cfg, platform) {
  if (cfg.autoSend === false) return false;
  const p = cfg.platforms?.[platform];
  if (p && Object.prototype.hasOwnProperty.call(p, "autoSend") && p.autoSend === false) return false;
  return true;
}

/**
 * 给美团「这一个会话」起稳定 ID（同名多人时不能只用昵称）。
 * 优先用 chatId；没有则用 昵称+预览+时间+列表序号 拼出来。
 * 谁调用：processMeituan —— 指纹、quiet、state 都挂在这个 key 上。
 */
function meituanSessionKey(customer, target) {
  const chatId = String(target?.chatId || "").trim();
  if (chatId) return `${customer}@@id:${chatId}`;
  const last = String(target?.last || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 80);
  const time = String(target?.time || "").trim().slice(0, 20);
  const idx = target?.listIndex != null ? Number(target.listIndex) : -1;
  return `${customer}@@${last}@@${time}@@i${idx}`;
}

/** 同一次进线最多连回几条未回顾客句（防刷屏） */
const MAX_UNREPLIED_PER_OPEN = 5;

/**
 * 从气泡时间线里找出「还没客服回过」的顾客话（按时间从早到晚）。
 * 规则：找到最后一条客服气泡，它后面的顾客句都算未回。
 * 谁调用：process* 读完线程后。最多 MAX_UNREPLIED_PER_OPEN 条，然后逐条 generateReply+发送。
 *
 * opts.allowClearProcessed：仅当列表有未读/待回复时为 true。
 *   false 时：已处理过的句直接跳过，禁止清指纹重回（否则会对「加载中/商品卡」无限刷）。
 * opts.strictUtterance：无未读时为 true，只接受像真问句的内容。
 */
function listUnrepliedCustomerFromBubbles(cfg, state, platform, sessionKey, ordered, skipText, opts = {}) {
  const allowClearProcessed = opts.allowClearProcessed === true;
  const strictUtterance = opts.strictUtterance === true;
  const msgs = Array.isArray(ordered) ? ordered : [];
  // 找最后一条「客服自己说的」气泡下标
  let lastAgent = -1;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i]?.self && String(msgs[i].t || "").trim().length > 1) lastAgent = i;
  }
  const out = [];
  const seen = new Set();
  // 只扫客服最后一句之后的顾客气泡
  for (let i = lastAgent + 1; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || m.self) continue;
    const s = String(m.t || "").trim();
    if (!s || s === "未知" || isUiChromeText(s) || isAgentLikeText(s)) continue;
    if (isFragmentOfAgentMsgs(s, msgs)) continue;
    if (strictUtterance && !looksLikeCustomerUtterance(s, { strict: true })) continue;
    if (typeof skipText === "function" && skipText(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    const fp = fingerprint(platform, sessionKey, s);
    if (isProcessedDone(state.processed?.[fp])) {
      // 无未读/待回复：已处理就跳过，别清指纹（防空会话反复回）
      if (!allowClearProcessed) continue;
      // 平台仍挂待回/未读：才允许清指纹重试一次
      clearProcessedFp(cfg, state, fp);
      log(cfg, `${platform.toUpperCase()} clear-fp for unreplied bubble`, sessionKey.slice(0, 48), s.slice(0, 40));
    }
    out.push(s);
    if (out.length >= MAX_UNREPLIED_PER_OPEN) break;
  }
  return out;
}

/**
 * 美团专用：列出本会话要回的顾客话。
 * 有左右气泡 → 走 listUnrepliedCustomerFromBubbles；没有 → 弱兜底最多一条。
 * 谁调用：processMeituan。
 */
function listUnprocessedCustomerMsgs(cfg, state, sessionKey, target, thread) {
  const actionable = !!(target?.unread > 0 || target?.pendingReply);
  const ordered = Array.isArray(thread?.msgs) ? thread.msgs : [];
  if (ordered.length) {
    return listUnrepliedCustomerFromBubbles(cfg, state, "meituan", sessionKey, ordered, null, {
      allowClearProcessed: actionable,
      strictUtterance: !actionable,
    });
  }

  // 无有序气泡时的弱兜底：只拿一条；无未读时更严，避免把商品卡当咨询
  const candidates = [];
  const push = (t) => {
    const s = String(t || "").trim();
    if (!s || s === "未知" || isUiChromeText(s) || isAgentLikeText(s)) return;
    if (!looksLikeCustomerUtterance(s, { strict: !actionable })) return;
    candidates.push(s);
  };
  push(target?.last);
  push(thread?.lastCustomerMsg);
  for (const t of [...(thread?.recent || [])].reverse()) push(t);

  const seen = new Set();
  for (const msg of candidates) {
    if (seen.has(msg)) continue;
    seen.add(msg);
    if (isProcessedDone(state.processed?.[fingerprint("meituan", sessionKey, msg)])) continue;
    return [msg];
  }
  return [];
}

/**
 * 在美团列表里点开指定会话（优先 chatId，其次 listIndex+预览）。
 * 谁调用：processMeituan 对每个 target。同名多人必须点对那一条，不能总点第一个。
 */
async function openMeituanConversation(send, target) {
  const customerName = typeof target === "string" ? target : target.name;
  const listIndex = typeof target === "object" && target ? target.listIndex : undefined;
  const lastHint = typeof target === "object" && target ? target.last || "" : "";
  const timeHint = typeof target === "object" && target ? target.time || "" : "";
  const chatIdHint = typeof target === "object" && target ? target.chatId || "" : "";
  const unreadHint = typeof target === "object" && target ? target.unread || 0 : 0;

  const clicked = await evaluate(
    send,
    meituanChatDocExpr(`(doc) => {
      const targetName = ${JSON.stringify(customerName)};
      const listIndex = ${listIndex === undefined || listIndex === null ? "null" : Number(listIndex)};
      const lastHint = ${JSON.stringify(lastHint)};
      const timeHint = ${JSON.stringify(timeHint)};
      const chatIdHint = ${JSON.stringify(chatIdHint)};
      const unreadHint = ${Number(unreadHint) || 0};
      const items = Array.from(doc.querySelectorAll('.chat-list-item'));

      function rowChatId(el) {
        let chatId = el.getAttribute('data-chatid') || el.getAttribute('data-chat-id') || el.getAttribute('data-id')
          || el.getAttribute('data-session-id') || el.id || '';
        if (!chatId) {
          const a = el.querySelector('[data-chatid], [data-chat-id], [data-id], [data-session-id]');
          if (a) chatId = a.getAttribute('data-chatid') || a.getAttribute('data-chat-id') || a.getAttribute('data-id') || a.getAttribute('data-session-id') || '';
        }
        return String(chatId || '');
      }
      function rowMeta(el) {
        const name = ((el.querySelector('.userinfo-username') || {}).innerText || '').trim();
        const last = ((el.querySelector('.userinfo-lastchat') || {}).innerText || '').trim();
        const time = ((el.querySelector('.userinfo-chattime, [class*="chattime"]') || {}).innerText || '').trim();
        const b = el.querySelector('.mtd-badge-text');
        let unread = 0;
        if (b && !String(b.className || '').includes('mtd-badge-hidden')) {
          const n = parseInt((b.innerText || '').trim(), 10);
          unread = Number.isFinite(n) && n > 0 ? n : 1;
        }
        return { name, last, time, unread, chatId: rowChatId(el) };
      }

      let hit = null;
      let via = 'iframe-dom';
      if (chatIdHint) {
        hit = items.find(el => rowChatId(el) === chatIdHint) || null;
        if (hit) via = 'iframe-chatId';
      }
      if (!hit && listIndex != null && items[listIndex]) {
        const meta = rowMeta(items[listIndex]);
        if (meta.name === targetName || (meta.name && meta.name.includes(targetName))) {
          // 序号对上且预览一致才信 listIndex（排序跳动时预览对不上则改用 last/time）
          if (!lastHint || meta.last.slice(0, 40) === lastHint.slice(0, 40)) {
            hit = items[listIndex];
            via = 'iframe-index';
          }
        }
      }
      if (!hit && lastHint) {
        const cands = items.filter(el => {
          const meta = rowMeta(el);
          return meta.name === targetName && meta.last.slice(0, 40) === lastHint.slice(0, 40);
        });
        if (cands.length === 1) {
          hit = cands[0];
          via = 'iframe-last';
        } else if (cands.length > 1 && timeHint) {
          hit = cands.find(el => rowMeta(el).time === timeHint) || cands[0];
          via = 'iframe-last-time';
        } else if (cands.length > 1) {
          hit = unreadHint > 0 ? (cands.find(el => rowMeta(el).unread > 0) || cands[0]) : cands[0];
          via = 'iframe-last-multi';
        }
      }
      if (!hit) {
        const matched = items.filter(el => rowMeta(el).name === targetName);
        if (!matched.length) return { ok:false, reason:'not-in-list' };
        // 同名多条时禁止默认点第一条：有未读点未读，否则失败让上层用更精确提示重试
        if (matched.length > 1 && !(unreadHint > 0)) {
          return { ok:false, reason:'ambiguous-same-name', count: matched.length };
        }
        hit = unreadHint > 0
          ? (matched.find(el => rowMeta(el).unread > 0) || matched[0])
          : matched[0];
        via = 'iframe-name';
      }
      hit.scrollIntoView({block:'center'});
      hit.click();
      const meta = rowMeta(hit);
      return { ok:true, via, listIndex: items.indexOf(hit), unread: meta.unread, last: meta.last.slice(0, 40), chatId: meta.chatId };
    }`)
  ).catch(() => ({ ok: false }));
  if (clicked?.ok) return clicked;
  return axClickName(send, customerName);
}

/* ========== SECTION F：把上面串成「一整轮美团 / 一整轮抖音」==========
 * 谁调用：tick()。这里是业务主流程，改「先干啥后干啥」优先看这里。
 * ================================================================== */

/**
 * 美团一整轮：找页 → 扫列表 → 对每个白名单会话：进线 → 未回话逐条想→发。
 * 谁调用：tick。
 * 返回 { openWork:true } = 这轮还有没回完（占坑冲突/发送失败等）→ tick 先别去抖音。
 */
async function processMeituan(cfg, state) {
  /** @type {{ openWork: boolean }} 仍有未读/待回未完成时，tick 应先留在美团、勿切抖音 */
  const result = { openWork: false };
  if (!cfg.platforms.meituan?.enabled) return result;
  const list = cfg.whitelist?.meituan || [];
  const pickOpts = targetPickOpts(cfg, cfg.platforms.meituan || {});
  // 白名单为空：不提前 return，走「所有人」+ onlyActionable

  const tab = await findTab(cfg.cdpUrl, cfg.platforms.meituan);
  if (!tab) {
    log(cfg, "MEITUAN skip: tab not found");
    return result;
  }
  const { send, close } = await cdpSession(tab.webSocketDebuggerUrl);
  try {
    await send("Page.bringToFront").catch(() => {});
    const scanned = await scanMeituanChatList(send);
    const targets = pickTargetsFromList(scanned.rows || [], list, pickOpts);
    const unreadCount = (scanned.rows || []).filter((r) => r.unread > 0).length;
    const pendingCount = (scanned.rows || []).filter((r) => r.pendingReply).length;
    log(
      cfg,
      "MEITUAN list",
      `source=${scanned.source}`,
      `rows=${(scanned.rows || []).length}`,
      `unreadTotal=${unreadCount}`,
      `pendingTotal=${pendingCount}`,
      `onlyActionable=${pickOpts.onlyActionable}`,
      `whitelistOnly=${pickOpts.whitelistOnly}`,
      `targets=${targets.map((t) => `${t.name}#${t.listIndex ?? "?"}${t.chatId ? "@" + String(t.chatId).slice(0, 18) : ""}(u${t.unread}${t.pendingReply ? "+待" : ""})`).join(",") || "(none)"}`
    );

    for (const target of targets) {
      const customer = list.find((w) => whitelistNameMatch(w, target.name)) || target.name;
      const sessionKey = meituanSessionKey(customer, target);
      const sessionTag = `${customer}#${target.listIndex}/[${(target.last || "").slice(0, 16)}]`;

      // 刚检查过且无待回：短冷却，避免白名单每 tick 空转；有未读/待回复则立刻进
      const mtQuiet = state.quiet?.[`meituan:${sessionKey}`];
      if (mtQuiet?.allProcessed && !(target.unread > 0) && !target.pendingReply) {
        const age = Date.now() - new Date(mtQuiet.at || 0).getTime();
        // 无咨询时冷却加长到 60s，减少空点进线 + 误读商品卡
        if (Number.isFinite(age) && age < 60000) {
          log(cfg, "MEITUAN skip cooldown", sessionTag, `${Math.round(age / 1000)}s`);
          continue;
        }
        delete state.quiet[`meituan:${sessionKey}`];
      }

      const open = await openMeituanConversation(send, target);
      if (!open.ok) {
        if (target.unread > 0 || target.pendingReply) result.openWork = true;
        log(cfg, "MEITUAN open fail", sessionTag, JSON.stringify(open));
        continue;
      }
      log(
        cfg,
        "MEITUAN switch",
        sessionTag,
        `unread=${target.unread}`,
        `pending=${!!target.pendingReply}`,
        `via=${open.via || "ax"}`,
        `sid=${sessionKey.slice(0, 72)}`
      );
      await sleep(900);
      // 切入会话后先关智能推荐，避免盖住最新气泡/输入框
      const smartDismiss = await dismissMeituanSmartReply(send);
      if (smartDismiss?.roots || smartDismiss?.hidden) {
        log(cfg, "MEITUAN dismiss smart-reply", sessionTag, JSON.stringify(smartDismiss));
        await sleep(120);
      }
      const thread = await readMeituanThread(send, customer);

      // 同名多会话：只在本 sessionKey 下去重；连续未回按时间顺序逐条回
      // 无未读/待回复时禁止 reconcile 清指纹重发（那是「平台卡住」专用）
      let pendingMsgs = listUnprocessedCustomerMsgs(cfg, state, sessionKey, target, thread);
      if (!pendingMsgs.length) {
        const actionable = !!(target.unread > 0 || target.pendingReply);
        if (actionable) {
          const cands = [];
          const push = (t) => {
            const s = String(t || "").trim();
            if (s && looksLikeCustomerUtterance(s) && !isAgentLikeText(s) && !isUiChromeText(s)) cands.push(s);
          };
          push(target?.last);
          push(thread?.lastCustomerMsg);
          for (const t of [...(thread?.recent || [])].reverse()) push(t);
          const rec = reconcileStuckPending(
            cfg,
            state,
            `meituan::${sessionKey}::`,
            [...new Set(cands)],
            thread,
            { pending: !!target.pendingReply, unread: target.unread || 0 }
          );
          if (rec.resentCleared) {
            pendingMsgs = [rec.msg];
            log(cfg, "MEITUAN retry missing-bubble", sessionTag, rec.msg.slice(0, 40));
            state._meituanPendingResend = state._meituanPendingResend || {};
            state._meituanPendingResend[fingerprint("meituan", sessionKey, rec.msg)] = true;
          }
        }
        if (!pendingMsgs.length) {
          state.quiet = state.quiet || {};
          state.quiet[`meituan:${sessionKey}`] = {
            msg: (target.last || "").toString().slice(0, 80),
            at: new Date().toISOString(),
            allProcessed: true,
          };
          saveJson(cfg.stateFile, state);
          log(
            cfg,
            target.unread > 0 || target.pendingReply
              ? "MEITUAN skip all-msgs-processed"
              : "MEITUAN skip empty/ui",
            sessionTag,
            thread.source || (target.last || "").slice(0, 40)
          );
          continue;
        }
      } else if (state.quiet?.[`meituan:${sessionKey}`]) {
        delete state.quiet[`meituan:${sessionKey}`];
      }

      if (pendingMsgs.length > 1) {
        log(
          cfg,
          "MEITUAN consecutive unreplied",
          sessionTag,
          `n=${pendingMsgs.length}`,
          pendingMsgs.map((m) => m.slice(0, 24)).join(" | ")
        );
      }

      const orderedMsgs = Array.isArray(thread.msgs) ? thread.msgs : [];
      let lastAgentIdx = -1;
      for (let i = 0; i < orderedMsgs.length; i++) {
        if (orderedMsgs[i]?.self && String(orderedMsgs[i].t || "").trim().length > 1) lastAgentIdx = i;
      }
      const contextMsgs = orderedMsgs.slice(0, lastAgentIdx + 1);
      let lastHandled = "";
      let brokeEarly = false;
      for (const lastCustomerMsg of pendingMsgs) {
        const fp = fingerprint("meituan", sessionKey, lastCustomerMsg);
        if (isProcessedDone(state.processed?.[fp])) {
          log(cfg, "MEITUAN already processed", sessionTag, lastCustomerMsg.slice(0, 40));
          continue;
        }
        if (
          !claimMessage(cfg, state, fp, {
            sessionKey,
            listIndex: target.listIndex,
            chatId: target.chatId || "",
            pendingResend: !!(state._meituanPendingResend && state._meituanPendingResend[fp]),
          })
        ) {
          result.openWork = true;
          brokeEarly = true;
          log(cfg, "MEITUAN skip claim-race", sessionTag, lastCustomerMsg.slice(0, 40));
          break;
        }
        if (state._meituanPendingResend) delete state._meituanPendingResend[fp];

        contextMsgs.push({ self: false, t: lastCustomerMsg });
        let replyRaw;
        try {
          replyRaw = await generateReply(cfg, {
            platform: "meituan",
            customer,
            lastCustomerMsg,
            recent: formatRecentContext(contextMsgs.length ? contextMsgs : thread.recent),
          });
        } catch (e) {
          releaseClaim(cfg, state, fp);
          result.openWork = true;
          brokeEarly = true;
          log(cfg, "MEITUAN generateReply fail", sessionTag, String(e.message || e).slice(0, 80));
          break;
        }
        const { escalate, reply } = normalizeReplyResult(replyRaw);
        log(
          cfg,
          "MEITUAN detect",
          sessionTag,
          "|",
          lastCustomerMsg.slice(0, 60),
          "=>",
          reply.slice(0, 60),
          escalate ? "(escalate)" : ""
        );

        const soft = isSoftClarifyReply(lastCustomerMsg, reply);
        const allowSend = isAutoSend(cfg, "meituan");
        if (escalate || !allowSend) {
          state.pending = state.pending || [];
          state.pending.push({
            platform: "meituan",
            customer,
            sessionKey,
            listIndex: target.listIndex,
            chatId: target.chatId || "",
            lastCustomerMsg,
            reply,
            escalate: !!escalate,
            unread: target.unread,
            at: new Date().toISOString(),
          });
          finalizeClaim(cfg, state, fp, {
            escalate: !!escalate,
            reply: reply.slice(0, 200),
            sessionKey,
            pendingOnly: !escalate && !allowSend,
            soft,
          });
          if (escalate) log(cfg, "MEITUAN escalate hold", sessionTag);
          else if (!allowSend) log(cfg, "MEITUAN autoSend off, pending only", sessionTag);
          result.openWork = true;
          brokeEarly = true;
          break;
        }
        const sent = await meituanSend(send, reply);
        log(cfg, "MEITUAN send", sessionTag, JSON.stringify(sent));
        const settled = await settleAfterSend(cfg, "meituan", send, reply);
        if (!settled?.ok) {
          finalizeClaim(cfg, state, fp, {
            claimFailed: true,
            sendUnconfirmed: true,
            reply: reply.slice(0, 200),
            sent,
          });
          result.openWork = true;
          brokeEarly = true;
          log(cfg, "MEITUAN send unconfirmed, claimFailed for retry", sessionTag, reply.slice(0, 40));
          break;
        }
        finalizeClaim(cfg, state, fp, {
          reply: reply.slice(0, 200),
          unread: target.unread,
          listIndex: target.listIndex,
          chatId: target.chatId || "",
          sessionKey,
          sent,
          settled,
          soft,
          softRetried: soft ? !!state.processed[fp]?.softRetried : undefined,
        });
        state.processed[fingerprint("meituan", sessionKey, reply)] = {
          at: new Date().toISOString(),
          self: true,
        };
        contextMsgs.push({ self: true, t: reply });
        lastHandled = lastCustomerMsg;
        log(cfg, "MEITUAN ready-next after", sessionTag, lastCustomerMsg.slice(0, 40));
        await sleep(400);
      }

      if (!brokeEarly && lastHandled) {
        state.quiet = state.quiet || {};
        state.quiet[`meituan:${sessionKey}`] = {
          msg: lastHandled.slice(0, 80),
          at: new Date().toISOString(),
          allProcessed: true,
        };
        saveJson(cfg.stateFile, state);
      }
    }
  } finally {
    close();
  }
  return result;
}

/**
 * 扫抖音左侧会话卡，筛出白名单顾客及未读/待回复。
 * 谁调用：processDouyin。注意：「只看未回复」是开关，不要每轮乱点，否则列表会空。
 */
async function scanDouyinChatList(send, whitelist) {
  // 注意：不要反复点击「只看未回复」——该控件是开关，点第二次会关掉导致列表空
  await sleep(200);

  return evaluate(
    send,
    `(() => {
      const whitelist = ${JSON.stringify(whitelist || [])};
      const whitelistOn = whitelist.length > 0;
      const text = document.body.innerText || '';
      // 来客会话卡：contactCard-*（旧 item/session 选择器会漏）
      const cards = Array.from(document.querySelectorAll('[class*="contactCard"], [class*="ContactCard"]'));
      const rows = [];
      const seen = new Set();
      function cardName(t, lines) {
        if (whitelistOn) return whitelist.find(w => t.includes(w)) || '';
        // 无白名单：取卡片首行可用昵称
        for (const l of lines) {
          if (!l || l.length > 40) continue;
          if (/^\\d+\\s*(秒|分钟|小时|天)$/.test(l)) continue;
          if (/用户咨询|待回复|未回复|只看未回复/.test(l)) continue;
          return l;
        }
        return lines[0] || '';
      }
      for (const el of cards) {
        const t = (el.innerText || '').trim();
        if (!t || t.length > 200) continue;
        const lines = t.split(/\\n/).map(s => s.trim()).filter(Boolean);
        const name = cardName(t, lines);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const last = lines
          .filter(l => !l.includes(name) && !/^\\d+\\s*(秒|分钟|小时|天)$/.test(l) && !/用户咨询/.test(l))
          .pop() || '';
        let unread = 0;
        // 勿把页面「只看未回复」滤镜当成会话待回复；等待时长（30秒）视为待回
        const pendingReply =
          /(^|[\\s\\n])待回复([\\s\\n]|$)/.test(t) ||
          /(^|[\\s\\n])未回复([\\s\\n]|$)/.test(t) ||
          /\\d+\\s*(秒|分钟|小时)/.test(t);
        const badge = el.querySelector('sup, [class*="badge"], [class*="unread"], [class*="Badge"], [class*="red"]');
        if (badge) {
          const n = parseInt((badge.innerText || '').trim(), 10);
          unread = Number.isFinite(n) && n > 0 ? n : 1;
        }
        rows.push({ name, unread, pendingReply, last: last.slice(0, 100), clickText: name });
      }
      // 白名单模式兜底：卡片没扫到时，只要页面出现该昵称也挂一条
      if (whitelistOn && !rows.length) {
        for (const w of whitelist) {
          if (text.includes(w)) rows.push({ name: w, unread: 0, pendingReply: false, last: '', clickText: w });
        }
      }
      return rows;
    })()`
  ).catch(() => []);
}

/**
 * 在抖音列表里点开某个白名单顾客的会话卡。
 * 谁调用：processDouyin 对每个 target。
 */
async function openDouyinConversation(send, customerName) {
  return evaluate(
    send,
    `(() => {
      const target = ${JSON.stringify(customerName)};
      const card = Array.from(document.querySelectorAll('[class*="contactCard"], [class*="ContactCard"]'))
        .find(el => ((el.innerText || '').includes(target)));
      const hit = card || Array.from(document.querySelectorAll('*')).find(el => {
        const t = (el.innerText || '').trim();
        return t === target || (t.includes(target) && t.length < 40 && el.childElementCount < 5);
      });
      if (!hit) return { ok:false };
      hit.scrollIntoView({block:'center'});
      hit.click();
      return { ok:true, via: card ? 'contactCard' : 'fallback' };
    })()`
  ).catch(() => ({ ok: false }));
}

/**
 * 抖音一整轮（流程同 processMeituan）。
 * 谁调用：tick 在美团没有 openWork 之后。
 * 若提示「被其他客服接待」或没有输入框 → 跳过该人。
 */
async function processDouyin(cfg, state) {
  if (!cfg.platforms.douyin?.enabled) return;
  const list = cfg.whitelist?.douyin || [];
  const pickOpts = targetPickOpts(cfg, cfg.platforms.douyin || {});
  // 白名单为空：不提前 return，走「所有人」+ onlyActionable

  let tab = await findTab(cfg.cdpUrl, cfg.platforms.douyin);
  if (!tab) {
    // 用缓存的完整客服台地址新开标签（不写死账号；没有缓存则等首页/登录页）
    const known = await discoverDouyinWorkbenchUrl(cfg, state, "");
    const openTry = known || cfg.platforms?.douyin?.homeUrl || "https://life.douyin.com/p/home";
    try {
      await getJson(`${cfg.cdpUrl}/json/new?${encodeURIComponent(openTry)}`);
      await sleep(2000);
      tab = await findTab(cfg.cdpUrl, cfg.platforms.douyin);
    } catch {}
  }
  if (!tab) {
    log(cfg, "DOUYIN skip: tab not found");
    return;
  }
  let session = await cdpSession(tab.webSocketDebuggerUrl);
  let { send, close } = session;
  try {
    await send("Page.bringToFront").catch(() => {});
    // 纠正「系统异常」空参页 / 停在商家首页：发现或点「顾客咨询」进入带参工作台
    const ensured = await ensureDouyinWorkbench(cfg, state, send, tab.url);
    if (!ensured.ok) {
      log(cfg, "DOUYIN workbench not ready", JSON.stringify(ensured));
      return;
    }
    if (ensured.via !== "ready" && ensured.via !== "tab-url") {
      log(cfg, "DOUYIN workbench ok", ensured.via, String(ensured.href || "").slice(0, 120));
      // 顾客咨询可能开了新标签，重新找带 accountId 的页
      close();
      await sleep(800);
      tab = await findTab(cfg.cdpUrl, cfg.platforms.douyin);
      if (!tab) {
        log(cfg, "DOUYIN skip: tab lost after workbench recover");
        return;
      }
      session = await cdpSession(tab.webSocketDebuggerUrl);
      send = session.send;
      close = session.close;
      await send("Page.bringToFront").catch(() => {});
    }
    const rows = (await scanDouyinChatList(send, list)) || [];
    const targets = pickTargetsFromList(rows, list, pickOpts);
    log(
      cfg,
      "DOUYIN list",
      `rows=${rows.length}`,
      `unread=${rows.filter((r) => r.unread > 0).length}`,
      `pending=${rows.filter((r) => r.pendingReply).length}`,
      `onlyActionable=${pickOpts.onlyActionable}`,
      `targets=${targets.map((t) => `${t.name}(u${t.unread}${t.pendingReply ? "+待" : ""})`).join(",") || "(none)"}`
    );

    for (const target of targets) {
      const customer = target.name;
      // 冷却：刚回完即使用待回角标还在，也要冷却，避免「30秒前」预览死循环刷屏
      const quiet = state.quiet?.[`douyin:${customer}`];
      if (quiet?.allProcessed) {
        const age = Date.now() - new Date(quiet.at || 0).getTime();
        const coolMs = 180000;
        const preview = String(target.last || "").trim();
        const samePreview =
          !!quiet.msg &&
          !!preview &&
          (preview === quiet.msg || preview.includes(quiet.msg) || quiet.msg.includes(preview));
        const freshCustomerPreview =
          !samePreview &&
          !isUiChromeText(preview) &&
          looksLikeCustomerUtterance(preview, { strict: true });
        // 未读角标 / 列表出现新顾客句 → 立刻再进；否则冷却期内一律跳过
        if (Number.isFinite(age) && age < coolMs && !(target.unread > 0) && !freshCustomerPreview) {
          log(cfg, "DOUYIN skip cooldown", customer, `${Math.round(age / 1000)}s`, preview.slice(0, 20) || "pending-stuck");
          continue;
        }
        delete state.quiet[`douyin:${customer}`];
      }
      const opened = await openDouyinConversation(send, customer);
      if (!opened?.ok) {
        log(cfg, "DOUYIN open fail", customer);
        continue;
      }
      log(cfg, "DOUYIN switch", customer, `unread=${target.unread}`, `pending=${!!target.pendingReply}`);
      await sleep(1200);

      // 其它客服接待中：无回复框，继续操作只会失败或误填搜索框
      const locked = await evaluate(
        send,
        `(() => {
          const text = (document.body && document.body.innerText) || '';
          const byOther = text.includes('当前用户正在被其他客服接待') || text.includes('不可回复');
          const hasComposer = !!(
            document.querySelector('textarea') ||
            document.querySelector('[placeholder*="回复顾客"]') ||
            document.querySelector('[placeholder*="要回复"]') ||
            Array.from(document.querySelectorAll('[contenteditable="true"]')).some((el) => {
              const r = el.getBoundingClientRect();
              return r.width > 120 && r.height > 24 && r.y > 200;
            })
          );
          return { byOther, hasComposer };
        })()`
      ).catch(() => null);
      if (locked?.byOther) {
        log(cfg, "DOUYIN skip locked-by-other-agent", customer);
        continue;
      }
      if (locked && locked.hasComposer === false) {
        log(cfg, "DOUYIN skip no-composer", customer);
        continue;
      }

      const snap = await evaluate(
        send,
        `(() => {
          const nodes = Array.from(document.querySelectorAll(
            '.chatd-message, [class*="chatd-message"], [class*="messageItem"], [class*="message-item"]'
          ));
          const msgs = [];
          for (const el of nodes) {
            const cls = String(el.className || '');
            const self = cls.includes('chatd-message--right') || cls.includes('--right') || cls.includes('self')
              || !!el.querySelector('.chatd-bubble--self, [class*="bubble--self"], [class*="--right"]');
            let t = (el.innerText || '').trim().replace(/^管理员[\\n\\s]*/, '').trim();
            // 订单卡：优先拼出「订单编号 + 数字」，避免后续清洗只剩标签
            if (/订单编号/.test(t)) {
              const m = t.match(/订单编号\\s*[:：#]?\\s*([A-Za-z0-9_-]{8,})/i)
                || t.match(/订单编号[\\s\\S]{0,20}?(\\d{12,22})/);
              if (m) t = '订单编号 ' + m[1];
            }
            // 空气泡 / 只有勾选图标 → 不当有效客服句
            if (!t || t.length < 2) continue;
            if (/^[✓✔√\\s]+$/.test(t)) continue;
            msgs.push({ self, t });
          }
          const uniq = [];
          for (const m of msgs) {
            const prev = uniq[uniq.length - 1];
            if (!prev || prev.t !== m.t || prev.self !== m.self) uniq.push(m);
          }
          // 订单卡常被拆成「订单编号」+「1111…」两条顾客气泡 → 合并
          const merged = [];
          for (let i = 0; i < uniq.length; i++) {
            const cur = uniq[i];
            const next = uniq[i + 1];
            if (
              cur && !cur.self && next && !next.self &&
              /^订单编号$/.test(String(cur.t || '').trim()) &&
              /^\\d{12,22}$/.test(String(next.t || '').trim())
            ) {
              merged.push({ self: false, t: '订单编号 ' + String(next.t).trim() });
              i++;
              continue;
            }
            if (
              cur && !cur.self && next && !next.self &&
              /订单编号/.test(String(cur.t || '')) &&
              !/\\d{12,}/.test(String(cur.t || '')) &&
              /^\\d{12,22}$/.test(String(next.t || '').trim())
            ) {
              merged.push({ self: false, t: '订单编号 ' + String(next.t).trim() });
              i++;
              continue;
            }
            merged.push(cur);
          }
          return { msgs: merged.slice(-30), hasTa: !!document.querySelector('textarea'), rawNodes: nodes.length };
        })()`
      );

      const isSkipCust = (m) =>
        !m ||
        m === customer ||
        m.replace(/\s+/g, "") === String(customer || "").replace(/\s+/g, "") ||
        m.startsWith("管理员") ||
        m.includes("用户超时未回复") ||
        m.includes("从历史会话发起会话") ||
        m.includes("以上是历史会话") ||
        m.includes("新用户进线") ||
        m.includes("请及时回复") ||
        m.includes("对方撤回了一条消息") ||
        m.includes("撤回了一条消息") ||
        m.length >= 200;
      const ordered = (snap?.msgs || []).map((m) => ({
        self: !!m.self,
        t: normalizeCustomerMsg(m.t),
      }));
      const actionable = !!(target.unread > 0 || target.pendingReply);
      let pendingMsgs = listUnrepliedCustomerFromBubbles(
        cfg,
        state,
        "douyin",
        customer,
        ordered,
        isSkipCust,
        {
          allowClearProcessed: actionable,
          strictUtterance: !actionable,
        }
      );
      // 客服刚要过单号，但上文顾客其实甩了订单卡/长单号 → 清指纹重查
      if (!pendingMsgs.length && actionable && orderLookup?.extractQuery) {
        let lastAgentAskId = false;
        for (let i = ordered.length - 1; i >= 0; i--) {
          const m = ordered[i];
          if (!m) continue;
          if (m.self) {
            if (/把订单号|发我任意一样|方便发一下订单号|订单号、下单手机号|我可以帮您查进度/.test(String(m.t || ""))) {
              lastAgentAskId = true;
            }
            break;
          }
        }
        if (lastAgentAskId) {
          let pick = "";
          for (let i = ordered.length - 1; i >= 0; i--) {
            const m = ordered[i];
            if (!m || m.self) continue;
            const t = String(m.t || "").trim();
            if (!t || isSkipCust(t)) continue;
            const q = orderLookup.extractQuery(t, {});
            if (q?.orderId || (q?.keyword && (/订单编号/.test(t) || /^\d{12,}$/.test(q.keyword) || /^yl_/i.test(q.keyword)))) {
              pick = /订单编号/.test(t) || /^\d{12,}$/.test(t) ? (t.startsWith("订单") ? t : `订单编号 ${q.keyword}`) : t;
              break;
            }
            // 「订单编号」与下一行数字被拆开时：向前拼
            if (/^订单编号$/.test(t) && i + 1 < ordered.length) {
              const nxt = String(ordered[i + 1]?.t || "").trim();
              if (/^\d{12,22}$/.test(nxt)) {
                pick = `订单编号 ${nxt}`;
                break;
              }
            }
            if (/^\d{12,22}$/.test(t) && i > 0 && /^订单编号$/.test(String(ordered[i - 1]?.t || "").trim())) {
              pick = `订单编号 ${t}`;
              break;
            }
          }
          if (pick) {
            const fp = fingerprint("douyin", customer, pick);
            clearProcessedFp(cfg, state, fp);
            // 同时清掉残缺「订单编号」指纹，避免后面又被当成已处理
            clearProcessedFp(cfg, state, fingerprint("douyin", customer, "订单编号"));
            pendingMsgs = [pick];
            log(cfg, "DOUYIN retry order-card after ask-id", customer, pick.slice(0, 40));
          }
        }
      }
      // 仅当几乎读不到气泡时才用列表预览兜底；已读到对话且客服已是最后一句 → 禁止用「30秒前」这类预览狂刷
      if (!pendingMsgs.length && actionable && ordered.length < 2) {
        const fallback = normalizeCustomerMsg(target.last || "");
        if (
          fallback &&
          !isSkipCust(fallback) &&
          !isUiChromeText(fallback) &&
          !isAgentLikeText(fallback) &&
          looksLikeCustomerUtterance(fallback, { strict: true })
        ) {
          const fp = fingerprint("douyin", customer, fallback);
          // 已回过同一预览句：清指纹也不重发，防待回角标卡住死循环
          if (!isProcessedDone(state.processed?.[fp])) {
            pendingMsgs = [fallback];
            log(cfg, "DOUYIN fallback list-preview", customer, fallback.slice(0, 40), `bubbles=${ordered.length}`);
          }
        }
      }
      if (!pendingMsgs.length) {
        log(
          cfg,
          "DOUYIN skip all-msgs-processed",
          customer,
          "pending=",
          !!target.pendingReply,
          `bubbles=${ordered.length}`,
          `raw=${snap?.rawNodes ?? "?"}`
        );
        state.quiet = state.quiet || {};
        state.quiet[`douyin:${customer}`] = {
          msg: (target.last || "all").toString().slice(0, 80),
          at: new Date().toISOString(),
          allProcessed: true,
        };
        saveJson(cfg.stateFile, state);
        continue;
      }
      if (pendingMsgs.length > 1) {
        log(
          cfg,
          "DOUYIN consecutive unreplied",
          customer,
          `n=${pendingMsgs.length}`,
          pendingMsgs.map((m) => m.slice(0, 24)).join(" | ")
        );
      }

      let lastAgentIdx = -1;
      for (let i = 0; i < ordered.length; i++) {
        if (ordered[i]?.self && String(ordered[i].t || "").trim().length > 1) lastAgentIdx = i;
      }
      const contextMsgs = ordered.slice(0, lastAgentIdx + 1);
      let lastHandled = "";
      let brokeEarly = false;
      for (const lastCustomerMsg of pendingMsgs) {
        const fp = fingerprint("douyin", customer, lastCustomerMsg);
        if (isProcessedDone(state.processed?.[fp])) {
          log(cfg, "DOUYIN already processed", customer, lastCustomerMsg.slice(0, 40));
          continue;
        }
        if (!claimMessage(cfg, state, fp, { platform: "douyin" })) {
          brokeEarly = true;
          log(cfg, "DOUYIN skip claim-race", customer, lastCustomerMsg.slice(0, 40));
          break;
        }

        contextMsgs.push({ self: false, t: lastCustomerMsg });
        let replyRaw;
        try {
          replyRaw = await generateReply(cfg, {
            platform: "douyin",
            customer,
            lastCustomerMsg,
            recent: formatRecentContext(contextMsgs),
          });
        } catch (e) {
          releaseClaim(cfg, state, fp);
          brokeEarly = true;
          log(cfg, "DOUYIN generateReply fail", customer, String(e.message || e).slice(0, 80));
          break;
        }
        const { escalate, reply } = normalizeReplyResult(replyRaw);
        log(
          cfg,
          "DOUYIN detect",
          customer,
          "|",
          lastCustomerMsg.slice(0, 60),
          "=>",
          reply.slice(0, 60),
          escalate ? "(escalate)" : ""
        );

        const soft = isSoftClarifyReply(lastCustomerMsg, reply);
        const allowSend = isAutoSend(cfg, "douyin");
        if (escalate || !allowSend) {
          state.pending = state.pending || [];
          state.pending.push({
            platform: "douyin",
            customer,
            lastCustomerMsg,
            reply,
            escalate: !!escalate,
            unread: target.unread,
            at: new Date().toISOString(),
          });
          finalizeClaim(cfg, state, fp, {
            escalate: !!escalate,
            reply: reply.slice(0, 200),
            pendingOnly: !escalate && !allowSend,
            soft,
          });
          if (escalate) log(cfg, "DOUYIN escalate hold", customer);
          else if (!allowSend) log(cfg, "DOUYIN autoSend off, pending only", customer);
          brokeEarly = true;
          break;
        }
        const sent = await douyinSend(send, reply);
        log(cfg, "DOUYIN send", JSON.stringify(sent));
        const settled = await settleAfterSend(cfg, "douyin", send, reply);
        if (!settled?.ok) {
          finalizeClaim(cfg, state, fp, {
            claimFailed: true,
            sendUnconfirmed: true,
            reply: reply.slice(0, 200),
            sent,
          });
          brokeEarly = true;
          log(cfg, "DOUYIN send unconfirmed, claimFailed for retry", customer, reply.slice(0, 40));
          break;
        }
        finalizeClaim(cfg, state, fp, {
          reply: reply.slice(0, 200),
          unread: target.unread,
          settled,
          soft,
          softRetried: soft ? !!state.processed[fp]?.softRetried : undefined,
        });
        state.processed[fingerprint("douyin", customer, reply)] = { at: new Date().toISOString(), self: true };
        contextMsgs.push({ self: true, t: reply });
        lastHandled = lastCustomerMsg;
        log(cfg, "DOUYIN ready-next after", customer, lastCustomerMsg.slice(0, 40));
        await sleep(400);
      }

      if (!brokeEarly && lastHandled) {
        state.quiet = state.quiet || {};
        state.quiet[`douyin:${customer}`] = {
          msg: lastHandled.slice(0, 80),
          at: new Date().toISOString(),
          allProcessed: true,
        };
        saveJson(cfg.stateFile, state);
      }
    }
  } finally {
    close();
  }
}

/* ========== SECTION G：程序入口 ==========
 * main = 开机；tick = 每一轮心跳。从这里顺着调到 F → E → D → C。
 * ================================================================== */

/**
 * 一轮巡检心跳。
 * 谁调用：main 的死循环（或 --once 只调一次）。
 * 顺序：合并 state → processMeituan →（没空的话）processDouyin。
 * 配置热更新：main 每次循环都会重新 loadRuntimeConfig 再传入本函数。
 */
async function tick(cfg, state) {
  // 每轮从磁盘合并，避免多实例/崩溃后内存过旧；已主动清除的指纹不可复活
  const disk = loadJson(cfg.stateFile, { processed: {} });
  const merged = { ...(disk.processed || {}), ...(state.processed || {}) };
  for (const k of state._clearedFps || []) delete merged[k];
  state.processed = merged;
  log(
    cfg,
    "TICK whitelist meituan=",
    (cfg.whitelist.meituan || []).join("|"),
    "douyin=",
    (cfg.whitelist.douyin || []).join("|"),
    "listen=",
    `mt=${cfg.platforms?.meituan?.enabled !== false}`,
    `dy=${cfg.platforms?.douyin?.enabled !== false}`,
    "autoSend=",
    `mt=${isAutoSend(cfg, "meituan")}`,
    `dy=${isAutoSend(cfg, "douyin")}`
  );
  const mt = await processMeituan(cfg, state);
  // 美团仍有未读/待回未完成（含 claim-race / 发送失败）→ 本轮不切抖音，下一 tick 继续回
  if (mt?.openWork) {
    log(cfg, "TAB skip douyin: meituan still has open unreplied work");
    state.lastTickAt = new Date().toISOString();
    saveJson(cfg.stateFile, state);
    return;
  }
  const tabGap = cfg.waitBeforeSwitchTabMs ?? 1200;
  if (tabGap > 0) {
    log(cfg, "TAB settle before douyin", tabGap);
    await sleep(tabGap);
  }
  await processDouyin(cfg, state);
  state.lastTickAt = new Date().toISOString();
  saveJson(cfg.stateFile, state);
}

/**
 * 进程入口（文件最底下会调用 main()）。
 * 步骤：检查配置文件 → 抢锁 → 读配置 →
 *   --once：只 tick 一次就退出；
 *   否则：死循环「读最新配置 → tick → 睡一会儿」。
 */
async function main() {
  if (!fs.existsSync(configPath)) {
    console.error("config missing:", configPath);
    process.exit(1);
  }
  const cfg = loadRuntimeConfig(configPath);
  acquireWatchLock(cfg);
  const state = loadJson(cfg.stateFile, { processed: {} });
  log(
    cfg,
    "START",
    "config=",
    configPath,
    "once=",
    once,
    "autoSend=",
    cfg.autoSend,
    "mode=",
    cfg.knowledge?.mode,
    "rag=",
    cfg.knowledge?.rag?.baseUrl || "(none)",
    "fallbackLocal=",
    cfg.knowledge?.fallbackLocal !== false,
    "pid=",
    process.pid
  );

  if (once) {
    await tick(cfg, state);
    return;
  }

  // reload config each tick so whitelist / RAG_BASE_URL edits apply without restart
  for (;;) {
    const live = loadRuntimeConfig(configPath);
    await tick(live, state);
    await sleep(live.pollIntervalMs || 5000);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
