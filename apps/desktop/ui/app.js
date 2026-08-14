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
  const appShell = document.getElementById("appShell");
  const onboard = document.getElementById("onboard");
  const obErr = document.getElementById("obErr");
  const obPrev = document.getElementById("obPrev");
  const obNext = document.getElementById("obNext");
  const obBrowse = document.getElementById("obBrowse");
  const obPortable = document.getElementById("obPortable");
  const obPortableHint = document.getElementById("obPortableHint");
  const obRagUrl = document.getElementById("obRagUrl");
  const obRagKey = document.getElementById("obRagKey");
  const obSummary = document.getElementById("obSummary");

  let busy = false;
  let loadedAdminUrl = "";
  let needsSetup = false;
  let obStep = 0;
  const OB_TOTAL = 4;

  function setMsg(text) {
    msg.textContent = text || "";
  }

  function setBusy(on) {
    busy = on;
    btnStart.disabled = on || needsSetup;
    btnStop.disabled = on;
  }

  function setSetupLock(on) {
    needsSetup = !!on;
    appShell.classList.toggle("setup-locked", needsSetup);
    btnStart.disabled = busy || needsSetup;
    if (onboard) onboard.hidden = !on;
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

  function selectedRole() {
    const el = document.querySelector('input[name="obRole"]:checked');
    return el ? el.value : "all";
  }

  function setObErr(text) {
    if (obErr) obErr.textContent = text || "";
  }

  function renderObStep() {
    document.querySelectorAll(".onboard-pane").forEach((el) => {
      el.classList.toggle("on", Number(el.getAttribute("data-step")) === obStep);
    });
    document.querySelectorAll("#obSteps span").forEach((el) => {
      const i = Number(el.getAttribute("data-i"));
      el.classList.toggle("on", i === obStep);
      el.classList.toggle("done", i < obStep);
    });
    obPrev.disabled = obStep === 0;
    obNext.textContent = obStep === OB_TOTAL - 1 ? "保存并进入" : "下一步";
    setObErr("");
    if (obStep === 3 && obSummary) {
      const role = selectedRole() === "edge" ? "仅边端（连远程中台）" : "本机全栈";
      obSummary.innerHTML =
        `<dt>角色</dt><dd>${role}</dd>` +
        `<dt>便携包</dt><dd>${obPortable.value.trim() || "（安装包内置 / 待检测）"}</dd>` +
        `<dt>中台地址</dt><dd>${obRagUrl.value.trim() || "—"}</dd>` +
        `<dt>API Key</dt><dd>${obRagKey.value ? "已填写" : "沿用已有 / 稍后在配置中心填写"}</dd>`;
    }
  }

  function fillOnboard(setup) {
    const role = setup.deployRole === "edge" ? "edge" : "all";
    document.querySelectorAll('input[name="obRole"]').forEach((el) => {
      el.checked = el.value === role;
    });
    obPortable.value = setup.portableRoot || "";
    obPortableHint.textContent = setup.portableOk
      ? "已检测到有效便携包。"
      : setup.packaged
        ? "安装包通常自带便携包；若检测失败请手动选择。"
        : "请选择含 app\\runtime\\node-win-x64 的 OpenClaw 目录。";
    obRagUrl.value = setup.ragBaseUrl || "http://127.0.0.1:8787";
    obRagKey.value = "";
    obStep = 0;
    renderObStep();
  }

  async function openOnboard(setup) {
    fillOnboard(setup || (await window.desktopApi.getSetup()));
    setSetupLock(true);
    setMsg("请先完成启动配置引导");
  }

  async function finishOnboard() {
    const body = {
      deployRole: selectedRole(),
      portableRoot: obPortable.value.trim(),
      ragBaseUrl: obRagUrl.value.trim(),
      ragApiKey: obRagKey.value,
    };
    const r = await window.desktopApi.saveSetup(body);
    if (!r.ok) throw new Error(r.error || "保存失败");
    setSetupLock(false);
    setMsg("配置已保存。可以点击「启动全部」。");
    appendLogLine({ stream: "out", line: "启动引导已完成，配置已写入 .env。\n" });
    await refresh();
  }

  async function refresh() {
    try {
      const status = await window.desktopApi.getStatus();
      paintPills(status);
      syncFrame(status);
      syncMeta(status);
      if (status.needsSetup && onboard && onboard.hidden) {
        await openOnboard(status.setup);
      } else if (!status.needsSetup && needsSetup) {
        setSetupLock(false);
      }
      if (status.starting) {
        setMsg("正在启动全部服务…左侧可看实时日志");
      } else if (status.stopping) {
        setMsg("正在停止全部服务…");
      } else if (status.needsSetup) {
        setMsg("请先完成启动配置引导");
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
    if (needsSetup) {
      setMsg("请先完成启动配置引导");
      if (onboard) onboard.hidden = false;
      return;
    }
    setBusy(true);
    setMsg("正在启动全部服务…");
    try {
      const r = await window.desktopApi.startAll();
      if (r && r.needsSetup) {
        await openOnboard();
        setMsg(r.error || "请先完成配置");
      } else {
        setMsg(r.ok ? "启动流程结束，请看左侧日志与上方状态灯" : r.error || "启动失败");
      }
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

  obBrowse.addEventListener("click", async () => {
    const r = await window.desktopApi.browsePortable();
    if (r.cancelled) return;
    if (!r.ok) {
      setObErr(r.error || "目录无效");
      if (r.path) obPortable.value = r.path;
      return;
    }
    obPortable.value = r.path;
    obPortableHint.textContent = "已选择有效便携包。";
    setObErr("");
  });

  obPrev.addEventListener("click", () => {
    if (obStep > 0) {
      obStep--;
      renderObStep();
    }
  });

  obNext.addEventListener("click", async () => {
    try {
      if (obStep === 1) {
        const p = obPortable.value.trim();
        if (!p) throw new Error("请填写或选择 OpenClaw 便携包路径");
      }
      if (obStep === 2) {
        if (!obRagUrl.value.trim()) throw new Error("请填写中台地址");
      }
      if (obStep === OB_TOTAL - 1) {
        obNext.disabled = true;
        await finishOnboard();
        obNext.disabled = false;
        return;
      }
      obStep++;
      renderObStep();
    } catch (e) {
      obNext.disabled = false;
      setObErr(e.message || String(e));
    }
  });

  window.desktopApi.onStatus((status) => {
    paintPills(status);
    syncFrame(status);
    syncMeta(status);
    if (status.needsSetup && onboard && onboard.hidden) {
      openOnboard(status.setup);
    }
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
      "未配置时会先进入启动引导；完成后即可「启动全部」。\n",
  });

  (async () => {
    const setup = await window.desktopApi.getSetup();
    if (setup.needsSetup) await openOnboard(setup);
    await refresh();
  })();
  setInterval(refresh, 4000);
})();
