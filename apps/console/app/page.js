"use client";

import { useCallback, useEffect, useState } from "react";

function Field({ label, children }) {
  return (
    <div>
      <label>{label}</label>
      {children}
    </div>
  );
}

export default function HomePage() {
  const [status, setStatus] = useState(null);
  const [log, setLog] = useState("就绪。");
  const [form, setForm] = useState(null);

  const pushLog = (msg, ok = true) => {
    setLog(`[${new Date().toLocaleTimeString()}] ${msg}${ok ? "" : ""}`);
  };

  const load = useCallback(async () => {
    const res = await fetch("/api/status");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "status failed");
    setStatus(data);
    const ord = data.config?.systems?.order || {};
    const plat = data.config?.platforms || {};
    const kb = data.config?.knowledge || {};
    const rag = kb.rag || {};
    setForm({
      mtListen: plat.meituan?.enabled !== false,
      mtAutoSend: plat.meituan?.autoSend !== false,
      dyListen: plat.douyin?.enabled !== false,
      dyAutoSend: plat.douyin?.autoSend !== false,
      orderEnabled: ord.enabled === true,
      intentMode: ord.intentMode || "ai+rules",
      orderBaseUrl: ord.baseUrl || "",
      orderUrlIncludes: ord.urlIncludes || "",
      orderPathIncludes: ord.pathIncludes || "",
      orderMaxResults: ord.maxResults ?? 5,
      orderFreeText: ord.freeTextKeyword !== false,
      orderAiProvider: ord.intentAi?.provider || "auto",
      orderAiModel: ord.intentAi?.model || "",
      orderTimeoutMs: ord.timeoutMs ?? 28000,
      mode: kb.mode || "remote",
      fallbackLocal: kb.fallbackLocal !== false,
      ragBase: rag.baseUrl || "http://127.0.0.1:8787",
      ragKey: rag.apiKey || "",
      kbIds: (rag.kbIds || []).join(", "),
      onMiss: kb.onMiss || "clarify",
      minScore: kb.minScore ?? 0.28,
      preferKb: kb.preferKbAnswer !== false,
      whitelistOnly: data.config?.whitelistOnly === true,
      onlyActionable: data.config?.onlyActionable !== false,
      wlMeituan: (data.config?.whitelist?.meituan || []).join(", "),
      wlDouyin: (data.config?.whitelist?.douyin || []).join(", "),
    });
  }, []);

  useEffect(() => {
    load().catch((e) => pushLog(e.message, false));
  }, [load]);

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const save = async () => {
    if (!form) return;
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          knowledge: {
            mode: form.mode,
            fallbackLocal: form.fallbackLocal,
            onMiss: form.onMiss,
            minScore: Number(form.minScore),
            preferKbAnswer: form.preferKb,
            rag: {
              baseUrl: form.ragBase.trim(),
              apiKey: form.ragKey,
              kbIds: form.kbIds.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
            },
          },
          whitelistOnly: form.whitelistOnly === true,
          onlyActionable: form.onlyActionable !== false,
          whitelist: {
            meituan: form.wlMeituan.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
            douyin: form.wlDouyin.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
          },
          platforms: {
            meituan: { enabled: form.mtListen, autoSend: form.mtAutoSend },
            douyin: { enabled: form.dyListen, autoSend: form.dyAutoSend },
          },
          systems: {
            order: {
              enabled: form.orderEnabled,
              intentMode: form.intentMode,
              baseUrl: form.orderBaseUrl.trim(),
              urlIncludes: form.orderUrlIncludes.trim(),
              pathIncludes: form.orderPathIncludes.trim(),
              maxResults: Number(form.orderMaxResults) || 5,
              freeTextKeyword: form.orderFreeText,
              timeoutMs: Number(form.orderTimeoutMs) || 28000,
              intentAi: {
                provider: form.orderAiProvider,
                model: form.orderAiModel.trim(),
              },
            },
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error((data.errors || [data.error]).join("; ") || "save failed");
      pushLog("配置已保存（下个 tick 生效）");
      await load();
    } catch (e) {
      pushLog(e.message, false);
    }
  };

  if (!form) {
    return (
      <>
        <header>
          <h1>OpenClaw <span>控制台</span></h1>
          <p>加载中…</p>
        </header>
      </>
    );
  }

  const mt = status?.config?.platforms?.meituan;
  const dy = status?.config?.platforms?.douyin;

  return (
    <>
      <header>
        <nav className="nav">
          <a className="on" href="/">配置台</a>
          <a href="/guide">使用教程</a>
          <a href="/dev-flow">研发流程</a>
          <a href="/project-map">项目全景</a>
          <a href="/deploy">生产交付</a>
          <a href="http://127.0.0.1:8787/kb-admin" target="_blank" rel="noreferrer">知识中台</a>
        </nav>
        <h1>OpenClaw <span>控制台</span></h1>
        <p>Monorepo · apps/console（Next）· 边端 worker 在 apps/edge-worker</p>
      </header>
      <main>
        <section>
          <h2>状态</h2>
          <div className="stats">
            <div className="stat"><b>{status?.ragOnline ? "在线" : "离线"}</b><small>中台</small></div>
            <div className="stat"><b>{status?.mode || "—"}</b><small>mode</small></div>
            <div className="stat"><b>{mt?.enabled === false ? "停听" : "监听"}/{mt?.autoSend === false ? "不发" : "发送"}</b><small>美团</small></div>
            <div className="stat"><b>{dy?.enabled === false ? "停听" : "监听"}/{dy?.autoSend === false ? "不发" : "发送"}</b><small>抖音</small></div>
          </div>
          <div className="actions">
            <button type="button" className="secondary" onClick={() => load().catch((e) => pushLog(e.message, false))}>刷新</button>
          </div>
          <div className={`log ${log.includes("失败") || log.includes("failed") ? "err" : "ok"}`}>{log}</div>
        </section>

        <section>
          <h2>巡检开关</h2>
          <div className="row">
            <Field label="美团 · 自动监听">
              <select value={String(form.mtListen)} onChange={(e) => set("mtListen", e.target.value === "true")}>
                <option value="true">开</option><option value="false">关</option>
              </select>
            </Field>
            <Field label="美团 · 自动发送">
              <select value={String(form.mtAutoSend)} onChange={(e) => set("mtAutoSend", e.target.value === "true")}>
                <option value="true">开</option><option value="false">关</option>
              </select>
            </Field>
          </div>
          <div className="row">
            <Field label="抖音 · 自动监听">
              <select value={String(form.dyListen)} onChange={(e) => set("dyListen", e.target.value === "true")}>
                <option value="true">开</option><option value="false">关</option>
              </select>
            </Field>
            <Field label="抖音 · 自动发送">
              <select value={String(form.dyAutoSend)} onChange={(e) => set("dyAutoSend", e.target.value === "true")}>
                <option value="true">开</option><option value="false">关</option>
              </select>
            </Field>
          </div>
        </section>

        <section>
          <h2>自有系统查单</h2>
          <p className="hint">写入 systems.order，edge-worker 热读配置。</p>
          <div className="row">
            <Field label="查单开关">
              <select value={String(form.orderEnabled)} onChange={(e) => set("orderEnabled", e.target.value === "true")}>
                <option value="true">开</option><option value="false">关</option>
              </select>
            </Field>
            <Field label="意图模式">
              <select value={form.intentMode} onChange={(e) => set("intentMode", e.target.value)}>
                <option value="ai+rules">AI + 规则</option>
                <option value="ai">仅 AI</option>
                <option value="rules">仅规则</option>
              </select>
            </Field>
          </div>
          <Field label="后台 URL">
            <input value={form.orderBaseUrl} onChange={(e) => set("orderBaseUrl", e.target.value)} />
          </Field>
          <div className="row">
            <Field label="urlIncludes">
              <input value={form.orderUrlIncludes} onChange={(e) => set("orderUrlIncludes", e.target.value)} />
            </Field>
            <Field label="pathIncludes">
              <input value={form.orderPathIncludes} onChange={(e) => set("orderPathIncludes", e.target.value)} />
            </Field>
          </div>
          <div className="row3">
            <Field label="最多条数">
              <input type="number" min={1} max={20} value={form.orderMaxResults} onChange={(e) => set("orderMaxResults", e.target.value)} />
            </Field>
            <Field label="自由文本关键字">
              <select value={String(form.orderFreeText)} onChange={(e) => set("orderFreeText", e.target.value === "true")}>
                <option value="true">开</option><option value="false">关</option>
              </select>
            </Field>
            <Field label="AI 提供方">
              <select value={form.orderAiProvider} onChange={(e) => set("orderAiProvider", e.target.value)}>
                <option value="auto">auto</option>
                <option value="gateway">gateway</option>
                <option value="openai-compatible">openai-compatible</option>
              </select>
            </Field>
          </div>
          <div className="row">
            <Field label="AI 模型">
              <input value={form.orderAiModel} onChange={(e) => set("orderAiModel", e.target.value)} placeholder="qwen-turbo" />
            </Field>
            <Field label="超时 ms">
              <input type="number" value={form.orderTimeoutMs} onChange={(e) => set("orderTimeoutMs", e.target.value)} />
            </Field>
          </div>
        </section>

        <section>
          <h2>知识库 / 白名单</h2>
          <div className="row">
            <Field label="knowledge.mode">
              <select value={form.mode} onChange={(e) => set("mode", e.target.value)}>
                <option value="remote">remote</option>
                <option value="local">local</option>
              </select>
            </Field>
            <Field label="fallbackLocal">
              <select value={String(form.fallbackLocal)} onChange={(e) => set("fallbackLocal", e.target.value === "true")}>
                <option value="true">true</option><option value="false">false</option>
              </select>
            </Field>
          </div>
          <Field label="RAG baseUrl">
            <input value={form.ragBase} onChange={(e) => set("ragBase", e.target.value)} />
          </Field>
          <div className="row">
            <Field label="RAG apiKey">
              <input type="password" value={form.ragKey} onChange={(e) => set("ragKey", e.target.value)} autoComplete="off" />
            </Field>
            <Field label="kbIds">
              <input value={form.kbIds} onChange={(e) => set("kbIds", e.target.value)} />
            </Field>
          </div>
          <div className="row">
            <Field label="仅白名单">
              <select value={String(form.whitelistOnly)} onChange={(e) => set("whitelistOnly", e.target.value === "true")}>
                <option value="false">关 · 可回所有人</option>
                <option value="true">开 · 只回白名单</option>
              </select>
            </Field>
            <Field label="仅未读/待回">
              <select value={String(form.onlyActionable)} onChange={(e) => set("onlyActionable", e.target.value === "true")}>
                <option value="true">开</option>
                <option value="false">关</option>
              </select>
            </Field>
          </div>
          <p className="hint">默认白名单留空 + 仅白名单关 = 回复所有有未读/待回的顾客。</p>
          <Field label="美团白名单（可空）">
            <input value={form.wlMeituan} onChange={(e) => set("wlMeituan", e.target.value)} placeholder="留空=不限制" />
          </Field>
          <Field label="抖音白名单（可空）">
            <input value={form.wlDouyin} onChange={(e) => set("wlDouyin", e.target.value)} placeholder="留空=不限制" />
          </Field>
          <div className="actions">
            <button type="button" onClick={save}>保存配置</button>
          </div>
        </section>
      </main>
    </>
  );
}
