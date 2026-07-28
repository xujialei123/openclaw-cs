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

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const UI_INDEX = path.join(__dirname, "ui", "index.html");
const START_ALL = path.join(PROJECT_ROOT, "scripts", "Start-All.ps1");
const STOP_ALL = path.join(PROJECT_ROOT, "scripts", "Stop-All.ps1");
const MEMORY_DIR = path.join(PROJECT_ROOT, "memory");
const DESKTOP_LOG = path.join(MEMORY_DIR, "desktop.log");

const ADMIN_PORT = Number(process.env.ADMIN_PORT || 18790);
const ADMIN_URL = `http://127.0.0.1:${ADMIN_PORT}/`;
const GATEWAY_URL = String(process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789").replace(/\/$/, "");
const CDP_URL = String(process.env.OPENCLAW_CDP_URL || "http://127.0.0.1:18800").replace(/\/$/, "");

let mainWindow = null;
let tray = null;
let starting = false;
let stopping = false;
let lastError = "";
let statusCache = {
  admin: false,
  gateway: false,
  cdp: false,
  watch: false,
  wecom: false,
  adminUrl: ADMIN_URL,
  starting: false,
  stopping: false,
  lastError: "",
  projectRoot: PROJECT_ROOT,
};

function appendLog(line) {
  try {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    fs.appendFileSync(DESKTOP_LOG, `[${new Date().toISOString()}] ${line}\n`, "utf8");
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
  const [admin, gateway, cdp, cmds] = await Promise.all([
    probeUrl(`${ADMIN_URL}api/status`),
    probeUrl(`${GATEWAY_URL}/`),
    probeUrl(`${CDP_URL}/json/version`),
    listNodeCmdLines(),
  ]);
  const watch = /cs-watch\.js/i.test(cmds);
  const wecom = /wecom-bridge/i.test(cmds);
  statusCache = {
    admin,
    gateway,
    cdp,
    watch,
    wecom,
    adminUrl: ADMIN_URL,
    starting,
    stopping,
    lastError,
    projectRoot: PROJECT_ROOT,
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("desktop:status-push", statusCache);
  }
  return statusCache;
}

function runPowerShell(scriptPath, args = []) {
  return new Promise((resolve) => {
    const allArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args];
    appendLog(`spawn: powershell ${allArgs.join(" ")}`);
    const child = spawn("powershell.exe", allArgs, {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      env: { ...process.env, OPENCLAW_PROJECT_ROOT: PROJECT_ROOT },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      appendLog(`spawn error: ${err.message}`);
      resolve({ ok: false, code: -1, stdout, stderr: String(err.message) });
    });
    child.on("close", (code) => {
      appendLog(`exit ${code}\n${stdout.slice(-2000)}\n${stderr.slice(-1000)}`);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "OpenClaw 客服桌面端",
    backgroundColor: "#0f1419",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(UI_INDEX);
  mainWindow.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function trayIcon() {
  // 16x16 green square PNG (minimal, no external asset)
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
    {
      label: "启动服务",
      click: () => ipcStartAll(),
    },
    {
      label: "停止服务",
      click: () => ipcStopAll(),
    },
    {
      label: "打开管理台（浏览器）",
      click: () => shell.openExternal(ADMIN_URL),
    },
    {
      label: "打开日志目录",
      click: () => shell.openPath(MEMORY_DIR),
    },
    { type: "separator" },
    {
      label: "退出",
      click: async () => {
        app.isQuitting = true;
        if (starting || stopping) {
          /* still exit */
        }
        try {
          await runPowerShell(STOP_ALL, []);
        } catch {
          /* ignore */
        }
        app.quit();
      },
    },
  ]);
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip("OpenClaw 客服桌面端");
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
  starting = true;
  lastError = "";
  await collectStatus();
  try {
    const r = await runPowerShell(START_ALL, ["-NoOpenBrowser"]);
    if (!r.ok) {
      lastError = (r.stderr || r.stdout || `退出码 ${r.code}`).slice(0, 400);
    }
    // wait a bit for admin
    for (let i = 0; i < 20; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      const s = await collectStatus();
      if (s.admin) break;
    }
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
  await collectStatus();
  try {
    const r = await runPowerShell(STOP_ALL, []);
    if (!r.ok) {
      lastError = (r.stderr || r.stdout || `退出码 ${r.code}`).slice(0, 400);
    }
    return { ok: r.ok, error: lastError || undefined };
  } finally {
    stopping = false;
    await collectStatus();
  }
}

function registerIpc() {
  ipcMain.handle("desktop:status", () => collectStatus());
  ipcMain.handle("desktop:start", () => ipcStartAll());
  ipcMain.handle("desktop:stop", () => ipcStopAll());
  ipcMain.handle("desktop:open-logs", () => {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
    return shell.openPath(MEMORY_DIR);
  });
  ipcMain.handle("desktop:open-admin", () => shell.openExternal(ADMIN_URL));
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

  app.whenReady().then(() => {
    if (!fs.existsSync(path.join(PROJECT_ROOT, "package.json"))) {
      dialog.showErrorBox(
        "项目根目录无效",
        `未找到仓库根目录：\n${PROJECT_ROOT}\n请从 monorepo 内启动 apps/desktop。`
      );
      app.quit();
      return;
    }
    registerIpc();
    createWindow();
    createTray();
    collectStatus();
    setInterval(() => {
      collectStatus().catch(() => {});
    }, 5000);
  });

  app.on("window-all-closed", (e) => {
    e.preventDefault();
  });

  app.on("before-quit", () => {
    app.isQuitting = true;
  });
}
