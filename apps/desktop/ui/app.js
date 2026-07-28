(() => {
  const msg = document.getElementById("msg");
  const empty = document.getElementById("empty");
  const frame = document.getElementById("adminFrame");
  const btnStart = document.getElementById("btnStart");
  const btnStop = document.getElementById("btnStop");
  const btnRefresh = document.getElementById("btnRefresh");
  const btnLogs = document.getElementById("btnLogs");
  const btnAdmin = document.getElementById("btnAdmin");

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

  function paintPills(status) {
    const map = {
      admin: !!status.admin,
      gateway: !!status.gateway,
      cdp: !!status.cdp,
      watch: !!status.watch,
      wecom: !!status.wecom,
    };
    for (const [k, on] of Object.entries(map)) {
      const el = document.querySelector(`.pill[data-k="${k}"]`);
      if (!el) continue;
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

  async function refresh() {
    try {
      const status = await window.desktopApi.getStatus();
      paintPills(status);
      syncFrame(status);
      if (status.starting) {
        setMsg("正在启动服务，请稍候…");
      } else if (status.stopping) {
        setMsg("正在停止服务…");
      } else if (status.admin) {
        setMsg(`管理台已就绪 · ${status.adminUrl}`);
      } else {
        setMsg(status.lastError || "服务未启动。点击「启动服务」开始。");
      }
    } catch (e) {
      setMsg(String(e && e.message ? e.message : e));
    }
  }

  btnStart.addEventListener("click", async () => {
    if (busy) return;
    setBusy(true);
    setMsg("正在启动 Start-All…");
    try {
      const r = await window.desktopApi.startAll();
      setMsg(r.ok ? "启动命令已发出，正在等待端口就绪…" : r.error || "启动失败");
    } finally {
      setBusy(false);
      refresh();
    }
  });

  btnStop.addEventListener("click", async () => {
    if (busy) return;
    setBusy(true);
    setMsg("正在停止服务…");
    try {
      const r = await window.desktopApi.stopAll();
      setMsg(r.ok ? "已发送停止命令" : r.error || "停止失败");
    } finally {
      setBusy(false);
      loadedAdminUrl = "";
      frame.src = "about:blank";
      refresh();
    }
  });

  btnRefresh.addEventListener("click", () => refresh());
  btnLogs.addEventListener("click", () => window.desktopApi.openLogs());
  btnAdmin.addEventListener("click", () => window.desktopApi.openExternalAdmin());

  window.desktopApi.onStatus((status) => {
    paintPills(status);
    syncFrame(status);
  });

  refresh();
  setInterval(refresh, 4000);
})();
