(() => {
  const msg = document.getElementById("msg");
  const empty = document.getElementById("empty");
  const emptyHint = document.getElementById("emptyHint");
  const frame = document.getElementById("adminFrame");
  const btnStart = document.getElementById("btnStart");
  const btnStop = document.getElementById("btnStop");
  const btnRefresh = document.getElementById("btnRefresh");
  const btnLogs = document.getElementById("btnLogs");
  const btnAdmin = document.getElementById("btnAdmin");
  const chkAuto = document.getElementById("chkAuto");
  const stackHint = document.getElementById("stackHint");
  const roleHint = document.getElementById("roleHint");
  const btnPortable = document.getElementById("btnPortable");
  const logView = document.getElementById("logView");
  const btnClearLog = document.getElementById("btnClearLog");

  let busy = false;
  let loadedAdminUrl = "";

  function setMsg(text) {
    msg.textContent = text || "";
  }

  function setBusy(on) {
    busy = on;
    btnStart.disabled = on;
    btnStop.disabled = on;
  }

  function appendLogLine(payload) {
    if (!logView) return;
    const span = document.createElement("span");
    if (payload && payload.stream === "err") span.className = "err";
    span.textContent = payload && payload.line != null ? String(payload.line) : "";
    logView.appendChild(span);
    logView.scrollTop = logView.scrollHeight;
  }

  function clearLog() {
    if (logView) logView.textContent = "";
  }

  function paintPills(status) {
    const keys = ["portableOk", "dockerOk", "rag", "admin", "gateway", "cdp", "watch", "wecom"];
    for (const k of keys) {
      const el = document.querySelector(`.pill[data-k="${k}"]`);
      if (!el) continue;
      const on = !!status[k];
      el.classList.toggle("on", on);
      el.classList.toggle("off", !on);
    }
  }

  function syncFrame(status) {
    if (status.admin && status.adminUrl) {
      empty.hidden = true;
      if (loadedAdminUrl !== status.adminUrl) {
        loadedAdminUrl = status.adminUrl;
        frame.src = status.adminUrl;
      }
    } else {
      empty.hidden = false;
      if (loadedAdminUrl) {
        loadedAdminUrl = "";
        frame.src = "about:blank";
      }
    }
  }

  function syncMeta(status) {
    chkAuto.checked = status.autoStartOnLaunch !== false;
    const ready = status.readyCount || 0;
    const total = status.totalCount || 6;
    stackHint.textContent = `${ready}/${total} 核心服务在线`;
    roleHint.textContent = status.portableOk
      ? `便携包 ${status.portableRoot || ""}`
      : "未检测到 OpenClaw 便携包";
    if (emptyHint && status.portableRoot) {
      emptyHint.textContent = status.portableOk
        ? `OpenClaw：${status.portableRoot}。Docker 需单独安装（可选，本地库用）。`
        : `未找到便携包：${status.portableRoot}。`;
    }
  }

  async function refresh() {
    try {
      const status = await window.desktopApi.getStatus();
      paintPills(status);
      syncFrame(status);
      syncMeta(status);
      if (status.starting) {
        setMsg("正在启动全部服务…左侧可看实时日志");
      } else if (status.stopping) {
        setMsg("正在停止全部服务…");
      } else if (!status.portableOk) {
        setMsg(status.lastError || "OpenClaw 便携包缺失，无法一键启动。");
      } else if (status.admin) {
        setMsg(`一体端就绪 · ${status.readyCount}/${status.totalCount} 在线`);
      } else {
        setMsg(status.lastError || "服务未启动。点击「启动全部」，左侧会输出启动日志。");
      }
    } catch (e) {
      setMsg(String(e && e.message ? e.message : e));
    }
  }

  btnStart.addEventListener("click", async () => {
    if (busy) return;
    setBusy(true);
    setMsg("正在启动全部服务…");
    try {
      const r = await window.desktopApi.startAll();
      setMsg(r.ok ? "启动流程结束，请看左侧日志与上方状态灯" : r.error || "启动失败");
    } finally {
      setBusy(false);
      refresh();
    }
  });

  btnStop.addEventListener("click", async () => {
    if (busy) return;
    setBusy(true);
    setMsg("正在停止全部服务…");
    try {
      const r = await window.desktopApi.stopAll();
      setMsg(r.ok ? "已全部停止" : r.error || "停止失败");
    } finally {
      setBusy(false);
      loadedAdminUrl = "";
      frame.src = "about:blank";
      refresh();
    }
  });

  btnRefresh.addEventListener("click", () => refresh());
  btnLogs.addEventListener("click", () => window.desktopApi.openLogs());
  btnAdmin.addEventListener("click", async () => {
    const url = await window.desktopApi.reloadAdmin();
    if (url) {
      loadedAdminUrl = "";
      frame.src = url;
      empty.hidden = true;
      setMsg(`已在客户端内刷新配置页 · ${url}`);
    }
  });
  if (btnPortable) {
    btnPortable.addEventListener("click", async () => {
      await window.desktopApi.pickPortable();
      refresh();
    });
  }
  if (btnClearLog) btnClearLog.addEventListener("click", () => clearLog());

  chkAuto.addEventListener("change", async () => {
    await window.desktopApi.setPrefs({ autoStartOnLaunch: chkAuto.checked });
    setMsg(chkAuto.checked ? "已开启：下次打开自动启动全部服务" : "已关闭自动启动");
  });

  window.desktopApi.onStatus((status) => {
    paintPills(status);
    syncFrame(status);
    syncMeta(status);
  });
  window.desktopApi.onLog((payload) => appendLogLine(payload));
  window.desktopApi.onLogClear(() => clearLog());
  window.desktopApi.onFocusAdmin(() => {
    if (frame.src && frame.src !== "about:blank") {
      empty.hidden = true;
    }
  });
  window.desktopApi.onReloadAdmin((url) => {
    if (!url) return;
    loadedAdminUrl = "";
    frame.src = url;
    empty.hidden = true;
  });

  clearLog();
  appendLogLine({
    stream: "out",
    line:
      "OpenClaw 客服一体端已就绪。\n" +
      "1. 点击「启动全部」查看本窗口实时日志\n" +
      "2. 管理台就绪后，右侧自动打开配置中心\n" +
      "3. Docker 未安装时可跳过；已安装则自动拉镜像建表\n",
  });
  refresh();
  setInterval(refresh, 4000);
})();
