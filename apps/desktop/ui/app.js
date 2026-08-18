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
  const editionBadge = document.getElementById("editionBadge");
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
  const obRagHint = document.getElementById("obRagHint");
  const obSummary = document.getElementById("obSummary");
  const obSub = document.getElementById("obSub");
  const advancedBar = document.getElementById("advancedBar");
  const btnToggleAdvanced = document.getElementById("btnToggleAdvanced");
  const workspace = document.getElementById("workspace");
  const btnToggleLog = document.getElementById("btnToggleLog");
  const btnShowLog = document.getElementById("btnShowLog");

  let busy = false;
  let loadedAdminUrl = "";
  let needsSetup = false;
  let advancedOpen = false;
  let logOpen = false;
  let obStep = 0;
  const OB_TOTAL = 3;
  let packageMeta = {
    deployRole: "all",
    packageKind: "fullstack",
    editionLabel: "全栈版",
    roleLocked: false,
  };

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

  function setAdvanced(on) {
    advancedOpen = !!on;
    if (advancedBar) advancedBar.hidden = !advancedOpen;
    if (btnToggleAdvanced) {
      btnToggleAdvanced.setAttribute("aria-expanded", advancedOpen ? "true" : "false");
      btnToggleAdvanced.classList.toggle("on", advancedOpen);
    }
    document.querySelectorAll(".advanced-only").forEach((el) => {
      el.classList.toggle("show-advanced", advancedOpen);
    });
  }

  function setLogOpen(on) {
    logOpen = !!on;
    if (workspace) workspace.classList.toggle("log-collapsed", !logOpen);
    if (btnToggleLog) btnToggleLog.textContent = logOpen ? "收起" : "展开";
  }

  function applyPackageMeta(src) {
    if (!src) return;
    packageMeta = {
      deployRole: src.deployRole === "edge" ? "edge" : "all",
      packageKind: src.packageKind === "edge" ? "edge" : "fullstack",
      editionLabel: src.editionLabel || (src.deployRole === "edge" ? "边端版" : "全栈版"),
      roleLocked: src.roleLocked === true || src.packaged === true,
    };
    if (editionBadge) editionBadge.textContent = packageMeta.editionLabel;
    if (obSub) {
      obSub.textContent =
        packageMeta.deployRole === "edge"
          ? "当前为边端版：本机只负责接待，请填写公司话术服务地址。"
          : "当前为全栈版：话术库与接待都在本机（需 Docker）。";
    }
    if (obRagHint) {
      obRagHint.textContent =
        packageMeta.deployRole === "edge"
          ? "填写公司服务器提供的话术服务地址与密钥（不要填本机 127.0.0.1）。"
          : "全栈版一般使用本机地址；若已预填可直接下一步。";
    }
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

  function adminUrlWithProduct(url, status) {
    if (!url) return url;
    try {
      const u = new URL(url);
      u.searchParams.set("product", "1");
      u.searchParams.set("role", (status && status.deployRole) || packageMeta.deployRole || "all");
      return u.toString();
    } catch {
      const role = (status && status.deployRole) || packageMeta.deployRole || "all";
      const join = String(url).includes("?") ? "&" : "?";
      return `${url}${join}product=1&role=${encodeURIComponent(role)}`;
    }
  }

  function syncFrame(status) {
    if (status.admin && status.adminUrl) {
      empty.hidden = true;
      const next = adminUrlWithProduct(status.adminUrl, status);
      if (loadedAdminUrl !== next) {
        loadedAdminUrl = next;
        frame.src = next;
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
    applyPackageMeta(status);
    chkAuto.checked = status.autoStartOnLaunch !== false;
    const ready = status.readyCount || 0;
    const total = status.totalCount || 6;
    stackHint.textContent = status.watch
      ? "自动回复进行中"
      : status.admin
        ? `已就绪 ${ready}/${total}`
        : "尚未开始接待";
    roleHint.textContent = status.portableOk
      ? `${packageMeta.editionLabel} · 工作台已就绪`
      : `${packageMeta.editionLabel} · 工作台未就绪`;
    if (emptyHint) {
      emptyHint.textContent =
        packageMeta.deployRole === "edge"
          ? "边端版：连接公司服务器，无需本机数据库。"
          : "全栈版：话术库在本机，需安装 Docker。";
    }
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
    if (obStep === 2 && obSummary) {
      const role =
        packageMeta.deployRole === "edge" ? "边端版（连接公司服务器）" : "全栈版（本机独立）";
      obSummary.innerHTML =
        `<dt>安装包</dt><dd>${role}（已固化，不可更改）</dd>` +
        `<dt>工作台</dt><dd>${obPortable.value.trim() || "安装版内置 / 自动检测"}</dd>` +
        `<dt>话术服务</dt><dd>${obRagUrl.value.trim() || "—"}</dd>` +
        `<dt>访问密钥</dt><dd>${obRagKey.value ? "已填写" : "沿用已有 / 稍后在设置中填写"}</dd>`;
    }
  }

  function fillOnboard(setup) {
    applyPackageMeta(setup);
    obPortable.value = setup.portableRoot || "";
    obPortableHint.textContent = setup.portableOk
      ? "已检测到可用工作台。"
      : setup.packaged
        ? "安装版一般已内置工作台；若检测失败请手动选择。"
        : "请选择有效的工作台目录（安装人员可协助）。";
    if (packageMeta.deployRole === "edge") {
      obRagUrl.value = setup.ragBaseUrl || "";
      obRagUrl.placeholder = "例如 http://192.168.1.23:8787";
    } else {
      obRagUrl.value = setup.ragBaseUrl || "http://127.0.0.1:8787";
      obRagUrl.placeholder = "http://127.0.0.1:8787";
    }
    obRagKey.value = "";
    obStep = 0;
    renderObStep();
  }

  async function openOnboard(setup) {
    fillOnboard(setup || (await window.desktopApi.getSetup()));
    setSetupLock(true);
    setMsg("请先完成初次设置");
  }

  async function finishOnboard() {
    const body = {
      portableRoot: obPortable.value.trim(),
      ragBaseUrl: obRagUrl.value.trim(),
      ragApiKey: obRagKey.value,
    };
    const r = await window.desktopApi.saveSetup(body);
    if (!r.ok) throw new Error(r.error || "保存失败");
    setSetupLock(false);
    setMsg("设置已保存。可以点击「开始接待」。");
    appendLogLine({ stream: "out", line: "初次设置已完成。\n" });
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
        setMsg("正在开始接待…可在左侧查看进度");
      } else if (status.stopping) {
        setMsg("正在停止接待…");
      } else if (status.needsSetup) {
        setMsg("请先完成初次设置");
      } else if (!status.portableOk) {
        setMsg(status.lastError || "工作台未就绪，无法开始接待。");
      } else if (status.watch) {
        setMsg("自动回复进行中");
      } else if (status.admin) {
        setMsg(`已就绪 · 点击「开始接待」即可`);
      } else {
        setMsg(status.lastError || "尚未开始接待。点击「开始接待」即可。");
      }
    } catch (e) {
      setMsg(String(e && e.message ? e.message : e));
    }
  }

  btnStart.addEventListener("click", async () => {
    if (busy) return;
    if (needsSetup) {
      setMsg("请先完成初次设置");
      if (onboard) onboard.hidden = false;
      return;
    }
    setBusy(true);
    setMsg("正在开始接待…");
    try {
      const r = await window.desktopApi.startAll();
      if (r && r.needsSetup) {
        await openOnboard();
        setMsg(r.error || "请先完成设置");
      } else {
        setMsg(r.ok ? "已启动，请查看左侧动态与上方状态" : r.error || "启动失败");
      }
    } finally {
      setBusy(false);
      refresh();
    }
  });

  btnStop.addEventListener("click", async () => {
    if (busy) return;
    setBusy(true);
    setMsg("正在停止接待…");
    try {
      const r = await window.desktopApi.stopAll();
      setMsg(r.ok ? "已停止接待" : r.error || "停止失败");
    } finally {
      setBusy(false);
      loadedAdminUrl = "";
      frame.src = "about:blank";
      refresh();
    }
  });

  btnRefresh.addEventListener("click", () => refresh());
  if (btnLogs) btnLogs.addEventListener("click", () => window.desktopApi.openLogs());
  btnAdmin.addEventListener("click", async () => {
    const url = await window.desktopApi.reloadAdmin();
    if (url) {
      loadedAdminUrl = "";
      frame.src = adminUrlWithProduct(url);
      empty.hidden = true;
      setMsg("已刷新店铺设置页");
    }
  });
  if (btnPortable) {
    btnPortable.addEventListener("click", async () => {
      await window.desktopApi.pickPortable();
      refresh();
    });
  }
  if (btnClearLog) btnClearLog.addEventListener("click", () => clearLog());
  if (btnToggleAdvanced) {
    btnToggleAdvanced.addEventListener("click", () => setAdvanced(!advancedOpen));
  }
  if (btnToggleLog) {
    btnToggleLog.addEventListener("click", () => setLogOpen(!logOpen));
  }
  if (btnShowLog) {
    btnShowLog.addEventListener("click", () => setLogOpen(true));
  }

  chkAuto.addEventListener("change", async () => {
    await window.desktopApi.setPrefs({ autoStartOnLaunch: chkAuto.checked });
    setMsg(chkAuto.checked ? "已开启：下次打开自动开始接待" : "已关闭自动开始");
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
    obPortableHint.textContent = "已选择可用工作台。";
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
      if (obStep === 0) {
        const p = obPortable.value.trim();
        if (!p && !packageMeta.roleLocked) {
          // 开发态可要求填写；安装版常靠内置路径，允许空并在保存时校验
        }
      }
      if (obStep === 1) {
        if (!obRagUrl.value.trim()) throw new Error("请填写话术服务地址");
        if (
          packageMeta.deployRole === "edge" &&
          /127\.0\.0\.1|localhost/i.test(obRagUrl.value)
        ) {
          throw new Error("边端版请填写公司服务器地址，不要使用本机 127.0.0.1");
        }
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
    frame.src = adminUrlWithProduct(url);
    empty.hidden = true;
  });

  clearLog();
  appendLogLine({
    stream: "out",
    line: "智能客服已打开。完成设置后，点击「开始接待」即可。\n",
  });
  setAdvanced(false);
  setLogOpen(false);

  (async () => {
    const setup = await window.desktopApi.getSetup();
    applyPackageMeta(setup);
    if (setup.needsSetup) await openOnboard(setup);
    await refresh();
  })();
  setInterval(refresh, 4000);
})();
