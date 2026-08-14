"use strict";

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  shell,
  ipcMain,
  dialog,
} = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");

function resolveProjectRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "openclaw-cs");
  }
  return path.resolve(__dirname, "..", "..");
}

const PROJECT_ROOT = resolveProjectRoot();
const UI_INDEX = path.join(__dirname, "ui", "index.html");
const START_ALL = path.join(PROJECT_ROOT, "scripts", "Start-All.ps1");
const STOP_ALL = path.join(PROJECT_ROOT, "scripts", "Stop-All.ps1");
const MEMORY_DIR = path.join(PROJECT_ROOT, "memory");
const DESKTOP_LOG = path.join(MEMORY_DIR, "desktop.log");
const PREFS_FILE = path.join(MEMORY_DIR, "desktop-prefs.json");
const ENV_FILE = path.join(PROJECT_ROOT, ".env");

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

function appendLog(line) {
  try {
    fs.mkdirSync(path.join(resolveProjectRoot(), "memory"), { recursive: true });
    fs.appendFileSync(
      path.join(resolveProjectRoot(), "memory", "desktop.log"),
      `[${new Date().toISOString()}] ${line}\n`,
      "utf8"
    );
  } catch {
    /* ignore */
  }
}

function ensureRuntimeSkeleton() {
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    const cfg = path.join(PROJECT_ROOT, "config", "cs-runtime.json");
    const cfgEx = path.join(PROJECT_ROOT, "config", "cs-runtime.example.json");
    if (!fs.existsSync(cfg) && fs.existsSync(cfgEx)) {
      fs.copyFileSync(cfgEx, cfg);
    }
    const sc = path.join(PROJECT_ROOT, "config", "scenarios.json");
    const scEx = path.join(PROJECT_ROOT, "config", "scenarios.example.json");
    if (!fs.existsSync(sc) && fs.existsSync(scEx)) {
      fs.copyFileSync(scEx, sc);
    }
    if (!fs.existsSync(ENV_FILE)) {
      const ex = path.join(PROJECT_ROOT, ".env.example");
      if (fs.existsSync(ex)) fs.copyFileSync(ex, ENV_FILE);
      else {
        fs.writeFileSync(
          ENV_FILE,
          "OPENCLAW_PORTABLE_ROOT=\nRAG_BASE_URL=http://127.0.0.1:8787\n",
          "utf8"
        );
      }
    }
  } catch (e) {
    try {
      appendLog(`skeleton fail: ${e.message || e}`);
    } catch {
      /* ignore */
    }
  }
}

function upsertEnvVar(key, value) {
  let text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
  const lines = text.split(/\r?\n/);
  let found = false;
  const next = lines.map((line) => {
    if (line.trim().startsWith("#") || !line.includes("=")) return line;
    const eq = line.indexOf("=");
    const k = line.slice(0, eq).trim();
    if (k !== key) return line;
    found = true;
    return `${key}=${value}`;
  });
  if (!found) next.push(`${key}=${value}`);
  fs.writeFileSync(ENV_FILE, next.filter((l, i, a) => !(l === "" && i === a.length - 1)).join("\n") + "\n", "utf8");
  process.env[key] = value;
}

function bundledPortableRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "openclaw-portable");
  }
  return "";
}

function portableNodePath(root) {
  return path.join(root, "app", "runtime", "node-win-x64", "node.exe");
}

function isPortableOk(root) {
  return !!(root && fs.existsSync(portableNodePath(root)));
}

function currentPortableRoot() {
  const env = String(process.env.OPENCLAW_PORTABLE_ROOT || "").trim();
  if (env && isPortableOk(env)) return env;
  const bundled = bundledPortableRoot();
  if (bundled && isPortableOk(bundled)) return bundled;
  if (env) return env;
  return "F:\\OpenClaw-USB-Portable";
}

ensureRuntimeSkeleton();
loadDotEnv(ENV_FILE);

const ADMIN_PORT = Number(process.env.ADMIN_PORT || 18790);
const ADMIN_URL = `http://127.0.0.1:${ADMIN_PORT}/`;
const GATEWAY_URL = String(process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789").replace(
  /\/$/,
  ""
);
const CDP_URL = String(process.env.OPENCLAW_CDP_URL || "http://127.0.0.1:18800").replace(/\/$/, "");
const RAG_BASE = String(process.env.RAG_BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");

let PORTABLE_ROOT = currentPortableRoot();

let mainWindow = null;
let tray = null;
let starting = false;
let stopping = false;
let lastError = "";
let autoStartedOnce = false;
let statusCache = emptyStatus();

function emptyStatus() {
  return {
    admin: false,
    gateway: false,
    cdp: false,
    rag: false,
    watch: false,
    wecom: false,
    portableOk: false,
    dockerOk: false,
    adminUrl: ADMIN_URL,
    ragUrl: `${RAG_BASE}/health`,
    gatewayUrl: GATEWAY_URL,
    cdpUrl: CDP_URL,
    portableRoot: "",
    starting: false,
    stopping: false,
    lastError: "",
    projectRoot: PROJECT_ROOT,
    packaged: app.isPackaged,
    autoStartOnLaunch: true,
    readyCount: 0,
    totalCount: 6,
  };
}

function loadPrefs() {
  try {
    return JSON.parse(fs.readFileSync(PREFS_FILE, "utf8"));
  } catch {
    return { autoStartOnLaunch: true, firstRunDone: false, setupCompleted: false };
  }
}

function readRuntimeJson() {
  const p = path.join(PROJECT_ROOT, "config", "cs-runtime.json");
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function writeRuntimePatch(patch) {
  const p = path.join(PROJECT_ROOT, "config", "cs-runtime.json");
  const example = path.join(PROJECT_ROOT, "config", "cs-runtime.example.json");
  let rt = {};
  if (fs.existsSync(p)) {
    try {
      rt = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      rt = {};
    }
  } else if (fs.existsSync(example)) {
    try {
      rt = JSON.parse(fs.readFileSync(example, "utf8"));
    } catch {
      rt = {};
    }
  }
  const next = { ...rt, ...patch };
  if (patch.knowledge) {
    next.knowledge = { ...(rt.knowledge || {}), ...patch.knowledge };
    if (patch.knowledge.rag) {
      next.knowledge.rag = { ...(rt.knowledge?.rag || {}), ...patch.knowledge.rag };
    }
  }
  if (patch.setup) next.setup = { ...(rt.setup || {}), ...patch.setup };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

/** 一体端启动前：未完成引导且缺便携包/中台地址 → 强制 onboarding */
function computeDesktopSetupState() {
  const prefs = loadPrefs();
  const rt = readRuntimeJson();
  const portable = currentPortableRoot();
  const portableOk = isPortableOk(portable);
  const ragFromEnv = String(process.env.RAG_BASE_URL || "").trim();
  const ragFromRt = String(rt?.knowledge?.rag?.baseUrl || "").trim();
  const ragUrl = (ragFromEnv || ragFromRt || "").replace(/\/$/, "");
  const ragOk = !!ragUrl;
  const wizardCompleted =
    prefs.setupCompleted === true || rt?.setup?.wizardCompleted === true;
  const reasons = [];
  if (!portableOk) reasons.push("缺少有效的 OpenClaw 便携包路径");
  if (!ragOk) reasons.push("缺少中台地址 RAG_BASE_URL");
  // 缺便携包或中台地址 → 一体端强制全屏引导，并禁止「启动全部」
  const needsSetup = !portableOk || !ragOk;
  return {
    needsSetup,
    wizardCompleted,
    reasons,
    deployRole: String(process.env.DEPLOY_ROLE || "all").trim() || "all",
    portableRoot: portable,
    portableOk,
    ragBaseUrl: ragUrl || "http://127.0.0.1:8787",
    ragKeySet: !!String(process.env.RAG_API_KEY || rt?.knowledge?.rag?.apiKey || "").trim(),
    packaged: app.isPackaged,
  };
}

function applySetupConfig(body) {
  const deployRole = String(body?.deployRole || "all").trim() || "all";
  const portable = String(body?.portableRoot || "").trim();
  const ragUrl = String(body?.ragBaseUrl || "").trim().replace(/\/$/, "");
  const ragKey = body?.ragApiKey != null ? String(body.ragApiKey) : "";
  if (!ragUrl) throw new Error("请填写中台地址 RAG_BASE_URL");
  if (portable) {
    if (!isPortableOk(portable) && !app.isPackaged) {
      throw new Error(`便携包无效，缺少：${portableNodePath(portable)}`);
    }
    upsertEnvVar("OPENCLAW_PORTABLE_ROOT", portable);
    PORTABLE_ROOT = portable;
  } else if (!isPortableOk(currentPortableRoot())) {
    throw new Error("请选择有效的 OpenClaw 便携包目录");
  }
  upsertEnvVar("DEPLOY_ROLE", deployRole);
  upsertEnvVar("RAG_BASE_URL", ragUrl);
  if (ragKey) upsertEnvVar("RAG_API_KEY", ragKey);
  writeRuntimePatch({
    knowledge: {
      mode: "remote",
      rag: {
        baseUrl: ragUrl,
        ...(ragKey ? { apiKey: ragKey } : {}),
      },
    },
    setup: {
      wizardCompleted: true,
      completedAt: new Date().toISOString(),
      via: "desktop-onboarding",
    },
  });
  savePrefs({ ...loadPrefs(), setupCompleted: true, firstRunDone: true, loginHintShown: true });
  return computeDesktopSetupState();
}

function savePrefs(prefs) {
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2), "utf8");
  } catch {
    /* ignore */
  }
}

function probeUrl(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        res.resume();
        done(res.statusCode >= 200 && res.statusCode < 500);
      });
      req.on("timeout", () => {
        req.destroy();
        done(false);
      });
      req.on("error", () => done(false));
    } catch {
      done(false);
    }
  });
}

function listNodeCmdLines() {
  return new Promise((resolve) => {
    const ps = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object -ExpandProperty CommandLine",
      ],
      { windowsHide: true }
    );
    let out = "";
    ps.stdout.on("data", (d) => {
      out += String(d);
    });
    ps.on("close", () => resolve(out));
    ps.on("error", () => resolve(""));
  });
}

async function collectStatus() {
  const prefs = loadPrefs();
  PORTABLE_ROOT = currentPortableRoot();
  const [admin, gateway, cdp, rag, cmds] = await Promise.all([
    probeUrl(`${ADMIN_URL}api/status`),
    probeUrl(`${GATEWAY_URL}/`),
    probeUrl(`${CDP_URL}/json/version`),
    probeUrl(`${RAG_BASE}/health`),
    listNodeCmdLines(),
  ]);
  const watch = /cs-watch\.js/i.test(cmds);
  const wecom = /wecom-bridge/i.test(cmds);
  const portableOk = isPortableOk(PORTABLE_ROOT);
  const flags = { admin, gateway, cdp, rag, watch, wecom };
  const readyCount = Object.values(flags).filter(Boolean).length;
  const setup = computeDesktopSetupState();
  statusCache = {
    ...flags,
    portableOk,
    dockerOk: !!statusCache.dockerOk,
    adminUrl: ADMIN_URL,
    ragUrl: `${(setup.ragBaseUrl || RAG_BASE).replace(/\/$/, "")}/health`,
    gatewayUrl: GATEWAY_URL,
    cdpUrl: CDP_URL,
    portableRoot: PORTABLE_ROOT,
    starting,
    stopping,
    lastError,
    projectRoot: PROJECT_ROOT,
    packaged: app.isPackaged,
    autoStartOnLaunch: prefs.autoStartOnLaunch !== false,
    readyCount,
    totalCount: 6,
    needsSetup: setup.needsSetup,
    setup,
  };
  if (tray && !tray.isDestroyed()) {
    const tip = starting
      ? "正在启动全部服务…"
      : stopping
        ? "正在停止…"
        : `OpenClaw 客服 · ${readyCount}/6 在线`;
    tray.setToolTip(tip);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("desktop:status-push", statusCache);
  }
  return statusCache;
}

function pushLog(line, stream = "out") {
  const text = String(line || "").replace(/\r/g, "");
  if (!text) return;
  appendLog(text.trimEnd());
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("desktop:log", {
      stream,
      line: text,
      at: new Date().toISOString(),
    });
  }
}

function runPowerShell(scriptPath, args = []) {
  return new Promise((resolve) => {
    const allArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args];
    pushLog(`> powershell ${path.basename(scriptPath)} ${args.join(" ")}\n`);
    const child = spawn("powershell.exe", allArgs, {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      env: {
        ...process.env,
        OPENCLAW_PROJECT_ROOT: PROJECT_ROOT,
        OPENCLAW_PORTABLE_ROOT: PORTABLE_ROOT,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      const chunk = String(d);
      stdout += chunk;
      pushLog(chunk, "out");
    });
    child.stderr.on("data", (d) => {
      const chunk = String(d);
      stderr += chunk;
      pushLog(chunk, "err");
    });
    child.on("error", (err) => {
      pushLog(`spawn error: ${err.message}\n`, "err");
      resolve({ ok: false, code: -1, stdout, stderr: String(err.message) });
    });
    child.on("close", (code) => {
      pushLog(`\n[exit ${code}]\n`, code === 0 ? "out" : "err");
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

function findDockerExe() {
  const candidates = [
    process.env.DOCKER_PATH,
    "docker",
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Docker", "Docker", "resources", "bin", "docker.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Docker", "Docker", "resources", "bin", "docker.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Docker", "resources", "bin", "docker.exe"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (c === "docker") continue;
    if (fs.existsSync(c)) return c;
  }
  return "docker";
}

function findDockerDesktopExe() {
  const candidates = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Docker", "Docker", "Docker Desktop.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Docker", "Docker Desktop.exe"),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return "";
}

function dockerInstalled() {
  if (findDockerDesktopExe()) return true;
  const exe = findDockerExe();
  if (exe !== "docker" && fs.existsSync(exe)) return true;
  return false;
}

function dockerAvailable() {
  return new Promise((resolve) => {
    const exe = findDockerExe();
    const child = spawn(exe, ["info"], { windowsHide: true });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish(false);
    }, 4000);
  });
}

async function ensureDockerReadyForStart() {
  const installed = dockerInstalled();
  let ready = await dockerAvailable();
  statusCache.dockerOk = ready;

  if (!installed && !ready) {
    pushLog("未安装 Docker Desktop。\n", "err");
    const choice = await dialog.showMessageBox({
      type: "warning",
      title: "未检测到 Docker",
      message: "本机尚未安装 Docker Desktop",
      detail:
        "本地知识库（Postgres/Redis 拉镜像、建表）需要 Docker。\n\n" +
        "可选：\n" +
        "• 去官网安装后再点「启动全部」\n" +
        "• 或继续启动（跳过 Docker，仅启 Gateway/浏览器/巡检/企微；知识库需远程中台）",
      buttons: ["打开 Docker 下载页", "仍继续（跳过 Docker）", "取消"],
      defaultId: 0,
      cancelId: 2,
    });
    if (choice.response === 0) {
      await shell.openExternal("https://www.docker.com/products/docker-desktop/");
      return { ok: false, skipDocker: true, cancelled: true, reason: "请安装 Docker Desktop 后重试" };
    }
    if (choice.response === 2) {
      return { ok: false, skipDocker: true, cancelled: true, reason: "已取消启动" };
    }
    pushLog("用户选择跳过 Docker，继续启动其它服务。\n", "err");
    return { ok: true, skipDocker: true };
  }

  if (!ready) {
    const desktop = findDockerDesktopExe();
    if (desktop) {
      pushLog("Docker 已安装但未就绪，正在启动 Docker Desktop…\n");
      try {
        spawn(desktop, [], { detached: true, stdio: "ignore", windowsHide: false }).unref();
      } catch (e) {
        pushLog(`启动 Docker Desktop 失败: ${e.message}\n`, "err");
      }
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        ready = await dockerAvailable();
        if (ready) {
          pushLog(`Docker 已就绪（约 ${(i + 1) * 2}s）。\n`);
          break;
        }
        if (i % 5 === 4) pushLog(`等待 Docker 引擎… ${(i + 1) * 2}s\n`);
      }
    }
  }

  statusCache.dockerOk = ready;
  if (!ready) {
    pushLog("Docker 引擎仍未就绪。\n", "err");
    const choice = await dialog.showMessageBox({
      type: "warning",
      title: "Docker 未就绪",
      message: "无法连接 Docker 引擎",
      detail: "请确认 Docker Desktop 已打开且引擎 Running，然后再试。也可暂时跳过 Docker 启动其它服务。",
      buttons: ["仍继续（跳过 Docker）", "取消"],
      defaultId: 1,
      cancelId: 1,
    });
    if (choice.response !== 0) {
      return { ok: false, skipDocker: true, cancelled: true, reason: "Docker 未就绪，已取消" };
    }
    return { ok: true, skipDocker: true };
  }

  pushLog("Docker 就绪：将执行拉镜像 / compose up / 建表（与本地 Start-All 相同）。\n");
  return { ok: true, skipDocker: false };
}

async function ensurePortableConfigured() {
  PORTABLE_ROOT = currentPortableRoot();

  // 安装包内已带精简便携包：自动写入路径，只提示扫码登录
  const bundled = bundledPortableRoot();
  if (bundled && isPortableOk(bundled)) {
    if (String(process.env.OPENCLAW_PORTABLE_ROOT || "").trim() !== bundled) {
      try {
        upsertEnvVar("OPENCLAW_PORTABLE_ROOT", bundled);
      } catch {
        process.env.OPENCLAW_PORTABLE_ROOT = bundled;
      }
    }
    PORTABLE_ROOT = bundled;
    const prefs = loadPrefs();
    if (!prefs.loginHintShown) {
      await dialog.showMessageBox({
        type: "info",
        title: "登录态说明",
        message: "安装包已内置 OpenClaw 运行时（无登录 Cookie）",
        detail:
          "请点击「启动全部」后，在橙框 Chrome 中扫码登录美团经营宝、抖音来客、洗护查单后台。登录态会保存在本机便携包目录，不会随安装包分发。",
        buttons: ["知道了"],
      });
      savePrefs({ ...prefs, loginHintShown: true, firstRunDone: true });
    }
    return true;
  }

  if (isPortableOk(PORTABLE_ROOT)) {
    const prefs = loadPrefs();
    if (!prefs.loginHintShown) {
      await dialog.showMessageBox({
        type: "info",
        title: "登录态说明",
        message: "美团 / 抖音 / 查单后台需要在 OpenClaw 托管浏览器中登录",
        detail:
          "登录态需自行扫码，不会随安装包分发。首次使用请在「启动全部」后于橙框 Chrome 登录各后台。",
        buttons: ["知道了"],
      });
      savePrefs({ ...prefs, loginHintShown: true });
    }
    return true;
  }

  const choice = await dialog.showMessageBox({
    type: "warning",
    title: "需要 OpenClaw 便携包",
    message: "未检测到 OpenClaw 运行时",
    detail:
      `当前路径无效：\n${PORTABLE_ROOT}\n\n` +
      "请选择本机 OpenClaw-USB-Portable 目录（内含 app\\runtime\\node-win-x64）。\n" +
      "登录态需装机后在托管浏览器中自行扫码。",
    buttons: ["选择目录", "稍后配置"],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice.response !== 0) return false;

  const picked = await dialog.showOpenDialog({
    title: "选择 OpenClaw 便携包根目录",
    properties: ["openDirectory"],
  });
  if (picked.canceled || !picked.filePaths?.[0]) return false;
  const dir = picked.filePaths[0];
  if (!isPortableOk(dir)) {
    await dialog.showMessageBox({
      type: "error",
      title: "目录无效",
      message: "所选目录不是有效的 OpenClaw 便携包",
      detail: `缺少：${portableNodePath(dir)}`,
    });
    return false;
  }
  upsertEnvVar("OPENCLAW_PORTABLE_ROOT", dir);
  PORTABLE_ROOT = dir;
  await dialog.showMessageBox({
    type: "info",
    title: "已保存便携包路径",
    message: "路径已写入 .env",
    detail:
      "接下来点击「启动全部」。首次请在 OpenClaw 橙框浏览器中登录美团经营宝、抖音来客、洗护查单后台。",
  });
  savePrefs({ ...loadPrefs(), firstRunDone: true, loginHintShown: true });
  return true;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 1000,
    minHeight: 680,
    title: "OpenClaw 客服一体端",
    backgroundColor: "#f3f4f6",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(UI_INDEX);
  mainWindow.on("close", (e) => {
    if (app.isQuitting) return;
    e.preventDefault();
    quitAndStopAll().catch(() => app.quit());
  });
}

async function quitAndStopAll() {
  if (app.isQuitting) return;
  app.isQuitting = true;
  try {
    pushLog("关闭窗口：正在停止全部服务…\n");
    await runPowerShell(STOP_ALL, []);
  } catch {
    /* ignore */
  }
  app.quit();
}

function trayIcon() {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAPElEQVQ4T2NkYGD4z0ABYBzVMKoBBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGqG4AAN0aBf0mYbYAAAAASUVORK5CYII=",
    "base64"
  );
  return nativeImage.createFromBuffer(png);
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: "显示窗口",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: "separator" },
    { label: "启动全部服务", click: () => ipcStartAll() },
    { label: "停止全部服务", click: () => ipcStopAll() },
    { label: "重新选择 OpenClaw 目录", click: () => ensurePortableConfigured() },
    { type: "separator" },
    { label: "显示配置页", click: () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send("desktop:focus-admin");
      }
    } },
    { label: "打开日志目录", click: () => shell.openPath(MEMORY_DIR) },
    { type: "separator" },
    {
      label: "退出（并停止服务）",
      click: () => {
        quitAndStopAll().catch(() => app.quit());
      },
    },
  ]);
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip("OpenClaw 客服一体端");
  tray.setContextMenu(buildTrayMenu());
  tray.on("double-click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

async function ipcStartAll() {
  if (starting) return { ok: false, error: "正在启动中" };
  if (!fs.existsSync(START_ALL)) {
    lastError = `找不到 Start-All: ${START_ALL}`;
    return { ok: false, error: lastError };
  }
  const okPortable = await ensurePortableConfigured();
  PORTABLE_ROOT = currentPortableRoot();
  if (!okPortable && !isPortableOk(PORTABLE_ROOT)) {
    lastError = `未配置 OpenClaw 便携包：${PORTABLE_ROOT}`;
    await collectStatus();
    return { ok: false, error: lastError };
  }
  starting = true;
  lastError = "";
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("desktop:log-clear");
  }
  pushLog("======== 启动全部服务 ========\n");
  await collectStatus();
  try {
    const dockerPlan = await ensureDockerReadyForStart();
    if (dockerPlan.cancelled) {
      lastError = dockerPlan.reason || "已取消";
      pushLog(`${lastError}\n`, "err");
      return { ok: false, error: lastError };
    }
    const args = ["-NoOpenBrowser"];
    if (dockerPlan.skipDocker) {
      args.push("-SkipDocker");
      pushLog("本轮参数：-NoOpenBrowser -SkipDocker\n");
    } else {
      pushLog("本轮参数：-NoOpenBrowser（含 Ensure-Infra 拉镜像建表）\n");
    }
    const r = await runPowerShell(START_ALL, args);
    if (!r.ok) {
      lastError = (r.stderr || r.stdout || `退出码 ${r.code}`).slice(0, 400);
    }
    pushLog("等待端口就绪…\n");
    for (let i = 0; i < 45; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      const s = await collectStatus();
      if (i % 5 === 0) {
        pushLog(
          `状态 ${i}s: admin=${s.admin} gateway=${s.gateway} cdp=${s.cdp} rag=${s.rag} watch=${s.watch} wecom=${s.wecom} docker=${s.dockerOk}\n`
        );
      }
      if (s.admin && s.gateway) break;
    }
    const final = await collectStatus();
    // 管理台只在客户端 iframe 内打开，不弹系统浏览器
    if (final.admin && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send("desktop:focus-admin");
      pushLog(`配置页已在客户端内加载：${ADMIN_URL}\n`);
    }
    pushLog(
      `\n完成：${final.readyCount}/${final.totalCount} 在线` +
        (lastError ? `；有错误：${lastError.slice(0, 120)}` : "") +
        "\n"
    );
    return { ok: !lastError, error: lastError || undefined };
  } finally {
    starting = false;
    await collectStatus();
  }
}

async function ipcStopAll() {
  if (stopping) return { ok: false, error: "正在停止中" };
  stopping = true;
  lastError = "";
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("desktop:log-clear");
  }
  pushLog("======== 停止全部服务 ========\n");
  await collectStatus();
  try {
    const r = await runPowerShell(STOP_ALL, []);
    if (!r.ok) {
      lastError = (r.stderr || r.stdout || `退出码 ${r.code}`).slice(0, 400);
    }
    pushLog(lastError ? `停止结束（有告警）\n` : "已停止\n");
    return { ok: r.ok, error: lastError || undefined };
  } finally {
    stopping = false;
    await collectStatus();
  }
}

async function maybeAutoStart() {
  if (autoStartedOnce) return;
  autoStartedOnce = true;
  const prefs = loadPrefs();
  if (prefs.autoStartOnLaunch === false) return;
  if (computeDesktopSetupState().needsSetup) {
    appendLog("skip auto-start: setup incomplete — complete onboarding first");
    return;
  }
  if (!isPortableOk(currentPortableRoot())) return;
  const s = await collectStatus();
  if (s.admin || s.watch || s.gateway) return;
  appendLog("auto-start all services on launch");
  await ipcStartAll();
}

function registerIpc() {
  ipcMain.handle("desktop:status", () => collectStatus());
  ipcMain.handle("desktop:start", async () => {
    if (computeDesktopSetupState().needsSetup) {
      return { ok: false, error: "请先完成启动配置引导", needsSetup: true };
    }
    return ipcStartAll();
  });
  ipcMain.handle("desktop:stop", () => ipcStopAll());
  ipcMain.handle("desktop:open-logs", () => {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    return shell.openPath(MEMORY_DIR);
  });
  ipcMain.handle("desktop:open-admin", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send("desktop:focus-admin");
    }
    return true;
  });
  ipcMain.handle("desktop:reload-admin", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("desktop:reload-admin", ADMIN_URL);
    }
    return ADMIN_URL;
  });
  ipcMain.handle("desktop:pick-portable", () => ensurePortableConfigured());
  ipcMain.handle("desktop:browse-portable", async () => {
    const picked = await dialog.showOpenDialog({
      title: "选择 OpenClaw 便携包根目录",
      properties: ["openDirectory"],
    });
    if (picked.canceled || !picked.filePaths?.[0]) return { ok: false, cancelled: true };
    const dir = picked.filePaths[0];
    if (!isPortableOk(dir)) {
      return { ok: false, error: `目录无效，缺少：${portableNodePath(dir)}`, path: dir };
    }
    return { ok: true, path: dir };
  });
  ipcMain.handle("desktop:get-setup", () => computeDesktopSetupState());
  ipcMain.handle("desktop:save-setup", (_e, body) => {
    try {
      const setup = applySetupConfig(body || {});
      return { ok: true, setup };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
  ipcMain.handle("desktop:get-prefs", () => loadPrefs());
  ipcMain.handle("desktop:set-prefs", (_e, patch) => {
    const next = { ...loadPrefs(), ...(patch || {}) };
    savePrefs(next);
    return next;
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    if (!fs.existsSync(path.join(PROJECT_ROOT, "package.json"))) {
      dialog.showErrorBox(
        "运行目录无效",
        `未找到业务目录：\n${PROJECT_ROOT}\n` +
          (app.isPackaged
            ? "安装包缺少 extraResources/openclaw-cs，请重新打包。"
            : "请从 monorepo 内启动 apps/desktop。")
      );
      app.quit();
      return;
    }
    registerIpc();
    createWindow();
    createTray();
    // 未完成引导时不弹系统对话框抢焦点，交给一体端内 onboarding
    if (!computeDesktopSetupState().needsSetup) {
      await ensurePortableConfigured();
    }
    await collectStatus();
    setInterval(() => {
      collectStatus().catch(() => {});
    }, 5000);
    setTimeout(() => {
      maybeAutoStart().catch((e) => appendLog(`auto-start fail: ${e.message || e}`));
    }, 1500);
  });

  app.on("window-all-closed", () => {
    // 关闭主窗口后退出（Stop-All 已在 close → quitAndStopAll 中执行）
    if (!app.isQuitting) {
      quitAndStopAll().catch(() => app.quit());
    }
  });

  app.on("before-quit", () => {
    app.isQuitting = true;
    if (tray && !tray.isDestroyed()) {
      tray.destroy();
      tray = null;
    }
  });
}
