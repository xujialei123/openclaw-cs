/**
 * @file apps/edge-worker/scenario-runner.js
 * @description 多运营场景：聊天触发 → OpenClaw 开页 → 扫描 → recipe / 安全自动化
 *
 * 默认仅允许 platforms 白名单（wecom），避免顾客消息误开任意站点。
 *
 * @usage
 *   node apps/edge-worker/scenario-runner.js --list
 *   node apps/edge-worker/scenario-runner.js --run order_dashboard
 *   node apps/edge-worker/scenario-runner.js --browse "https://example.com"
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const DEFAULT_SCENARIO_SYS = {
  enabled: false,
  configFile: "config/scenarios.json",
  allowedPlatforms: ["wecom"],
  allowGenericBrowse: true,
  allowLlmAutomate: true,
  maxScanChars: 6000,
  timeoutMs: 45000,
  settleMs: 1800,
};

let _busy = Promise.resolve();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

function requestJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const body = opts.body ? JSON.stringify(opts.body) : null;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: opts.method || "GET",
        headers: {
          "Content-Type": "application/json",
          ...(opts.headers || {}),
          ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
        },
        timeout: opts.timeoutMs || 20000,
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(d || "null"), raw: d });
          } catch {
            resolve({ status: res.statusCode, json: null, raw: d });
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("request timeout"));
    });
    if (body) req.write(body);
    req.end();
  });
}

function cdpSession(wsUrl, timeoutMs = 20000) {
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
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.res(msg.result);
      }
    });
    ws.addEventListener("error", (e) => {
      clearTimeout(timer);
      reject(e.error || e);
    });
  });
}

function scenarioSysOf(cfg) {
  const s = cfg?.systems?.scenarios || {};
  return { ...DEFAULT_SCENARIO_SYS, ...s };
}

function resolveConfigPath(cfg, rel) {
  const p = String(rel || "").trim();
  if (!p) return path.join(PROJECT_ROOT, "config", "scenarios.json");
  if (path.isAbsolute(p)) return p;
  return path.join(PROJECT_ROOT, p.replace(/^\.\//, ""));
}

function loadScenarioPack(cfg) {
  const sys = scenarioSysOf(cfg);
  const file = resolveConfigPath(cfg, sys.configFile);
  const fallback = path.join(PROJECT_ROOT, "config", "scenarios.example.json");
  const use = fs.existsSync(file) ? file : fallback;
  if (!fs.existsSync(use)) {
    return { scenarios: [], file: use, missing: true };
  }
  const raw = JSON.parse(fs.readFileSync(use, "utf8"));
  const list = Array.isArray(raw.scenarios) ? raw.scenarios : [];
  return {
    scenarios: list.filter((x) => x && x.enabled !== false),
    file: use,
    missing: false,
  };
}

function openClawPaths(cfg) {
  const root =
    process.env.OPENCLAW_PORTABLE_ROOT ||
    cfg?.openclawPortableRoot ||
    "F:\\OpenClaw-USB-Portable";
  const node = path.join(root, "app", "runtime", "node-win-x64", "node.exe");
  const mjs = path.join(root, "app", "core", "node_modules", "openclaw", "openclaw.mjs");
  return { root, node, mjs };
}

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

function extractHttpUrl(text) {
  const m = String(text || "").match(/https?:\/\/[^\s<>"'）\]]+/i);
  return m ? m[0].replace(/[.,;。，；]+$/, "") : "";
}

function matchScenario(scenarios, msg) {
  const t = String(msg || "").trim();
  if (!t) return null;
  for (const s of scenarios) {
    const triggers = Array.isArray(s.triggers) ? s.triggers : [];
    for (const tr of triggers) {
      if (tr && t.includes(String(tr))) return s;
    }
  }
  // 裸 URL + 打开/扫描动词
  if (extractHttpUrl(t) && /(打开|扫描|浏览|进入|访问)/.test(t)) {
    return scenarios.find((s) => s.mode === "browse_scan" || s.id === "generic_browse") || null;
  }
  return null;
}

function platformAllowed(sys, platform) {
  const allow = Array.isArray(sys.allowedPlatforms) ? sys.allowedPlatforms : ["wecom"];
  if (!allow.length) return true;
  return allow.map((x) => String(x).toLowerCase()).includes(String(platform || "").toLowerCase());
}

async function findTabByUrl(cdpUrl, urlIncludes, startUrl) {
  const tabs = await getJson(`${cdpUrl}/json/list`);
  const pages = (Array.isArray(tabs) ? tabs : []).filter((t) => t.type === "page" || !t.type);
  const needle = urlIncludes || (() => {
    try {
      return new URL(startUrl).hostname;
    } catch {
      return "";
    }
  })();
  if (needle) {
    const hit = pages.find((t) => (t.url || "").includes(needle));
    if (hit) return hit;
  }
  if (startUrl) {
    const hit2 = pages.find((t) => (t.url || "").startsWith(startUrl.slice(0, 40)));
    if (hit2) return hit2;
  }
  return pages.sort((a, b) => Number(b.id) - Number(a.id))[0] || null;
}

async function openUrl(cfg, cdpUrl, targetUrl, urlIncludes) {
  const cli = openViaOpenClawCli(cfg, targetUrl);
  await sleep(2200);
  let tab = await findTabByUrl(cdpUrl, urlIncludes, targetUrl);
  if (tab) return { tab, how: cli.ok ? "openclaw-cli" : "existing", cli };
  // retry once
  openViaOpenClawCli(cfg, targetUrl);
  await sleep(2500);
  tab = await findTabByUrl(cdpUrl, urlIncludes, targetUrl);
  return { tab, how: tab ? "openclaw-cli-retry" : "fail", cli };
}

async function evaluate(send, expression) {
  const r = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r?.exceptionDetails) {
    throw new Error(r.exceptionDetails.text || "evaluate exception");
  }
  return r?.result?.value;
}

async function scanPage(send, maxChars) {
  const limit = Math.max(800, Number(maxChars) || 6000);
  const data = await evaluate(
    send,
    `(() => {
      const title = document.title || "";
      const href = location.href || "";
      const bodyText = (document.body && (document.body.innerText || "")) || "";
      const buttons = Array.from(document.querySelectorAll("button, [role=button], a, input[type=submit]"))
        .map((el) => (el.innerText || el.value || el.getAttribute("aria-label") || "").trim())
        .filter(Boolean)
        .slice(0, 40);
      const inputs = Array.from(document.querySelectorAll("input, textarea, [contenteditable=true]"))
        .map((el) => ({
          tag: el.tagName,
          type: el.getAttribute("type") || "",
          placeholder: el.getAttribute("placeholder") || "",
          name: el.getAttribute("name") || "",
          aria: el.getAttribute("aria-label") || "",
        }))
        .slice(0, 30);
      return { title, href, bodyText, buttons, inputs };
    })()`
  );
  let axNames = [];
  try {
    await send("Accessibility.enable").catch(() => {});
    const ax = await send("Accessibility.getFullAXTree");
    const nodes = ax?.nodes || [];
    axNames = nodes
      .map((n) => (n.name && n.name.value) || "")
      .filter((x) => x && x.length < 80)
      .slice(0, 80);
  } catch {
    /* optional */
  }
  const text = String(data?.bodyText || "").replace(/\s+\n/g, "\n").trim();
  const summary = text.slice(0, limit);
  return {
    title: data?.title || "",
    href: data?.href || "",
    summary,
    buttons: data?.buttons || [],
    inputs: data?.inputs || [],
    axNames,
  };
}

async function clickByText(send, text) {
  const needle = String(text || "").trim();
  if (!needle) return { ok: false, reason: "empty-text" };
  const ok = await evaluate(
    send,
    `(() => {
      const needle = ${JSON.stringify(needle)};
      const all = Array.from(document.querySelectorAll("button, a, [role=button], span, div, label"));
      const el = all.find((n) => {
        const t = (n.innerText || n.textContent || "").trim();
        return t === needle || t.includes(needle);
      });
      if (!el) return false;
      el.scrollIntoView({ block: "center", inline: "center" });
      el.click();
      return true;
    })()`
  );
  return { ok: !!ok, reason: ok ? "clicked" : "not-found" };
}

async function typeInto(send, { placeholder, label, text, clear }) {
  const value = String(text ?? "");
  const ph = String(placeholder || label || "").trim();
  const ok = await evaluate(
    send,
    `(() => {
      const ph = ${JSON.stringify(ph)};
      const value = ${JSON.stringify(value)};
      const clear = ${clear === false ? "false" : "true"};
      let el = null;
      if (ph) {
        el = Array.from(document.querySelectorAll("input, textarea, [contenteditable=true]")).find((n) => {
          const blob = [n.getAttribute("placeholder"), n.getAttribute("aria-label"), n.getAttribute("name"), n.id]
            .filter(Boolean).join(" ");
          return blob.includes(ph);
        }) || null;
      }
      if (!el) {
        el = document.querySelector("input:not([type=hidden]), textarea, [contenteditable=true]");
      }
      if (!el) return false;
      el.focus();
      if (el.isContentEditable) {
        if (clear) el.textContent = "";
        el.textContent = (el.textContent || "") + value;
        el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      } else {
        if (clear) el.value = "";
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return true;
    })()`
  );
  return { ok: !!ok };
}

async function pressEnter(send) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  return { ok: true };
}

async function runSteps(send, steps, sys) {
  const results = [];
  let lastScan = null;
  for (const step of steps || []) {
    const op = String(step.op || step.action || "").toLowerCase();
    if (op === "wait") {
      await sleep(Number(step.ms) || 1000);
      results.push({ op, ok: true });
    } else if (op === "scan") {
      lastScan = await scanPage(send, sys.maxScanChars);
      results.push({ op, ok: true, title: lastScan.title });
    } else if (op === "click" || op === "clicktext") {
      const r = await clickByText(send, step.text || step.name);
      results.push({ op, ...r, text: step.text || step.name });
      await sleep(sys.settleMs || 1200);
    } else if (op === "type") {
      const r = await typeInto(send, step);
      results.push({ op, ...r });
      await sleep(400);
    } else if (op === "enter" || op === "pressenter") {
      await pressEnter(send);
      results.push({ op, ok: true });
      await sleep(600);
    } else {
      results.push({ op, ok: false, reason: "unsupported-op" });
    }
  }
  if (!lastScan) {
    lastScan = await scanPage(send, sys.maxScanChars);
  }
  return { results, scan: lastScan };
}

function readGatewayToken(cfg) {
  const tf = cfg?.gateway?.tokenFile || "";
  const resolved = tf.includes("${")
    ? path.join(
        process.env.OPENCLAW_PORTABLE_ROOT || "F:\\OpenClaw-USB-Portable",
        "data",
        ".openclaw",
        "gateway-token.txt"
      )
    : tf
      ? path.isAbsolute(tf)
        ? tf
        : path.join(PROJECT_ROOT, tf)
      : path.join(
          process.env.OPENCLAW_PORTABLE_ROOT || "F:\\OpenClaw-USB-Portable",
          "data",
          ".openclaw",
          "gateway-token.txt"
        );
  try {
    if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN.trim();
    if (fs.existsSync(resolved)) return fs.readFileSync(resolved, "utf8").trim();
  } catch {}
  return "";
}

async function planActionsWithLlm(cfg, msg, scan) {
  const base = String(cfg?.gateway?.baseUrl || "http://127.0.0.1:18789").replace(/\/$/, "");
  const token = readGatewayToken(cfg);
  const model = cfg?.gateway?.model || "openclaw";
  const prompt = [
    "你是浏览器自动化规划器。根据页面扫描结果与用户指令，输出 JSON 数组 actions。",
    "只允许这些 op: clickText, type, enter, wait, scan。不要输出其它字段说明。",
    "clickText: {\"op\":\"clickText\",\"text\":\"可见文字\"}",
    "type: {\"op\":\"type\",\"placeholder\":\"占位或标签\",\"text\":\"要输入的内容\"}",
    "enter: {\"op\":\"enter\"}",
    "wait: {\"op\":\"wait\",\"ms\":1000}",
    "若无法安全操作，返回 []。",
    "",
    "用户指令:",
    String(msg || "").slice(0, 500),
    "",
    "页面标题:",
    scan.title,
    "URL:",
    scan.href,
    "可点元素:",
    JSON.stringify((scan.buttons || []).slice(0, 25)),
    "输入框:",
    JSON.stringify((scan.inputs || []).slice(0, 20)),
    "正文摘要:",
    String(scan.summary || "").slice(0, 2500),
  ].join("\n");

  const res = await requestJson(`${base}/v1/chat/completions`, {
    method: "POST",
    timeoutMs: 25000,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: {
      model,
      temperature: 0.1,
      messages: [
        { role: "system", content: "只输出 JSON。格式：{\"actions\":[...]}" },
        { role: "user", content: prompt },
      ],
    },
  });
  const content = res.json?.choices?.[0]?.message?.content || res.raw || "";
  const m = String(content).match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[0]);
    const actions = Array.isArray(parsed.actions) ? parsed.actions : Array.isArray(parsed) ? parsed : [];
    return actions
      .map((a) => {
        const op = String(a.op || a.action || "").toLowerCase();
        if (op === "clicktext" || op === "click") return { op: "clickText", text: a.text || a.name };
        if (op === "type") return { op: "type", placeholder: a.placeholder || a.label, text: a.text, clear: a.clear };
        if (op === "enter" || op === "pressenter") return { op: "enter" };
        if (op === "wait") return { op: "wait", ms: a.ms || 1000 };
        if (op === "scan") return { op: "scan" };
        return null;
      })
      .filter(Boolean)
      .slice(0, 8);
  } catch {
    return [];
  }
}

function formatReply(scenario, scan, meta) {
  const lines = [
    `已按场景「${scenario.name || scenario.id}」打开浏览器并完成扫描。`,
    `标题：${scan.title || "（无）"}`,
    `地址：${scan.href || "（无）"}`,
  ];
  if (meta?.how) lines.push(`打开方式：${meta.how}`);
  if (meta?.actions) lines.push(`已执行动作：${meta.acted}`);
  const sum = String(scan.summary || "").replace(/\n{3,}/g, "\n\n").trim();
  if (sum) {
    lines.push("", "页面摘要：", sum.slice(0, 1200) + (sum.length > 1200 ? "…" : ""));
  }
  const btns = (scan.buttons || []).slice(0, 12);
  if (btns.length) lines.push("", "可见按钮/链接：", btns.join(" · "));
  return lines.join("\n");
}

function wantsAutomate(msg) {
  return /(然后|接着|并且|并).{0,8}(点击|填写|输入|选择|查询|提交|操作)|自动(化|操作|执行)|帮我(点|填|操作)/.test(
    String(msg || "")
  );
}

async function runScenario(cfg, scenario, msg) {
  const sys = scenarioSysOf(cfg);
  const cdpUrl = String(cfg.cdpUrl || process.env.OPENCLAW_CDP_URL || "http://127.0.0.1:18800").replace(
    /\/$/,
    ""
  );
  // CDP 探活
  try {
    await getJson(`${cdpUrl}/json/version`);
  } catch (e) {
    throw new Error(`CDP 未就绪（${cdpUrl}）：${e.message || e}`);
  }

  let targetUrl = scenario.startUrl || "";
  let urlIncludes = scenario.urlIncludes || "";
  if (scenario.mode === "browse_scan" || scenario.id === "generic_browse") {
    targetUrl = extractHttpUrl(msg) || scenario.startUrl || "";
    if (!targetUrl) {
      return {
        reply: "请带上完整网址，例如：打开网站 https://example.com 并扫描",
        meta: { reason: "need-url" },
      };
    }
    try {
      urlIncludes = new URL(targetUrl).hostname;
    } catch {
      return { reply: "网址格式不正确，请发 https:// 开头的链接。", meta: { reason: "bad-url" } };
    }
  }
  if (!targetUrl) {
    return { reply: `场景「${scenario.id}」未配置 startUrl。`, meta: { reason: "no-startUrl" } };
  }

  const opened = await openUrl(cfg, cdpUrl, targetUrl, urlIncludes);
  if (!opened.tab?.webSocketDebuggerUrl) {
    return {
      reply: `已尝试打开 ${targetUrl}，但未找到浏览器标签。请确认 OpenClaw 浏览器（CDP ${cdpUrl}）已启动并登录。`,
      meta: { reason: "no-tab", how: opened.how, cli: opened.cli },
    };
  }

  const { send, close } = await cdpSession(opened.tab.webSocketDebuggerUrl, sys.timeoutMs);
  try {
    await send("Page.bringToFront").catch(() => {});
    await send("Runtime.enable").catch(() => {});
    const steps =
      Array.isArray(scenario.steps) && scenario.steps.length
        ? scenario.steps
        : [{ op: "wait", ms: sys.settleMs || 1800 }, { op: "scan" }];
    let { results, scan } = await runSteps(send, steps, sys);

    let acted = 0;
    if (sys.allowLlmAutomate && wantsAutomate(msg)) {
      const plan = await planActionsWithLlm(cfg, msg, scan);
      if (plan.length) {
        const more = await runSteps(send, plan, sys);
        results = results.concat(more.results);
        scan = more.scan || scan;
        acted = plan.length;
      }
    }

    return {
      reply: formatReply(scenario, scan, { how: opened.how, acted }),
      meta: {
        reason: "ok",
        scenarioId: scenario.id,
        how: opened.how,
        results,
        title: scan.title,
        href: scan.href,
        acted,
      },
    };
  } finally {
    close();
  }
}

async function tryHandle(cfg, msg, ctx = {}) {
  const sys = scenarioSysOf(cfg);
  if (!sys.enabled) return null;
  const platform = ctx.platform || "";
  if (!platformAllowed(sys, platform)) return null;

  const pack = loadScenarioPack(cfg);
  if (pack.missing || !pack.scenarios.length) return null;

  const scenario = matchScenario(pack.scenarios, msg);
  if (!scenario) return null;

  if (scenario.mode === "browse_scan" && !sys.allowGenericBrowse) {
    return {
      reply: "通用开站扫描已关闭。可在场景包里用预置场景，或开启 systems.scenarios.allowGenericBrowse。",
      meta: { reason: "generic-disabled" },
    };
  }

  const job = _busy.then(() => runScenario(cfg, scenario, msg));
  _busy = job.catch(() => {});
  return job;
}

module.exports = {
  tryHandle,
  runScenario,
  loadScenarioPack,
  matchScenario,
  scenarioSysOf,
  extractHttpUrl,
  mainCli,
};

async function mainCli() {
  const args = process.argv.slice(2);
  const cfgPath = path.join(PROJECT_ROOT, "config", "cs-runtime.json");
  const exampleScenarios = path.join(PROJECT_ROOT, "config", "scenarios.example.json");
  const cfg = fs.existsSync(cfgPath)
    ? JSON.parse(fs.readFileSync(cfgPath, "utf8"))
    : { cdpUrl: "http://127.0.0.1:18800", gateway: { baseUrl: "http://127.0.0.1:18789" } };
  cfg.systems = cfg.systems || {};
  cfg.systems.scenarios = {
    ...scenarioSysOf(cfg),
    enabled: true,
    configFile: fs.existsSync(path.join(PROJECT_ROOT, "config", "scenarios.json"))
      ? "config/scenarios.json"
      : "config/scenarios.example.json",
  };

  if (args.includes("--list")) {
    const pack = loadScenarioPack(cfg);
    console.log(JSON.stringify({ file: pack.file, scenarios: pack.scenarios.map((s) => ({ id: s.id, name: s.name, mode: s.mode })) }, null, 2));
    return;
  }
  const runIdx = args.indexOf("--run");
  if (runIdx >= 0) {
    const id = args[runIdx + 1];
    const pack = loadScenarioPack(cfg);
    const sc = pack.scenarios.find((s) => s.id === id);
    if (!sc) {
      console.error("scenario not found:", id);
      process.exit(1);
    }
    const r = await runScenario(cfg, sc, args.slice(runIdx + 2).join(" ") || sc.triggers?.[0] || "");
    console.log(r.reply);
    console.log(JSON.stringify(r.meta, null, 2));
    return;
  }
  const browseIdx = args.indexOf("--browse");
  if (browseIdx >= 0) {
    const url = args[browseIdx + 1];
    const sc = { id: "generic_browse", name: "CLI browse", mode: "browse_scan", startUrl: url };
    const r = await runScenario(cfg, sc, `打开网站 ${url}`);
    console.log(r.reply);
    return;
  }
  console.error("Usage:\n  --list\n  --run <scenarioId>\n  --browse <url>");
  console.error("example pack:", exampleScenarios);
  process.exit(1);
}

if (require.main === module) {
  mainCli().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
