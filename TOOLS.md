# TOOLS.md — OpenClaw 专用环境与本机约定

<!--
  给人与 Agent 的环境备忘录：路径、端口、目录职责。
  不含密钥明文；Token 仍只存在于 OpenClaw data 目录。
-->

> **不要使用** 客服 AI 便携包（3000/3001）及其 Chrome「客服中台 RPA 助手」插件。  
> 本项目只通过 **OpenClaw Gateway + OpenClaw 托管浏览器** 操作美团经营宝 / 抖音来客。

## OpenClaw

| 项 | 值 |
|---|---|
| 便携包 | `F:\OpenClaw-USB-Portable` |
| Gateway | `http://127.0.0.1:18789` |
| 配置页 | `http://127.0.0.1:18788` |
| Workspace | `F:\OpenClaw-USB-Portable\data\.openclaw\workspace\` |
| 托管浏览器 CDP | `http://127.0.0.1:18800` |

## 本仓库关键路径

| 路径 | 说明 |
|---|---|
| `AGENTS.md` | Agent 操作规则 |
| `tasks.md` | 任务板（含知识库 T5） |
| `config/cs-runtime.json` | 白名单 / 巡检 / 知识库开关 |
| `apps/edge-worker/cs-watch.js` | 白名单自动巡检 |
| `apps/edge-worker/scenario-runner.js` | 运营场景：聊天开站/扫描/安全自动化 |
| `apps/edge-worker/kb-retrieve.js` | 知识库检索 |
| `apps/console` | Next 控制台（配置，`:18790`） |
| `packages/runtime-config` | `cs-runtime.json` 校验 |
| `scripts/Start-CsWatch.ps1` | 巡检启动器 |
| `knowledge/raw/` | **上传**原始话术文档 |
| `knowledge/cards/` | 规范化一问一答卡片 |
| `knowledge/index/` | 索引产物（后续） |
| `memory/` | 日志、状态、调试快照 |

## 自动巡检

```powershell
.\scripts\Start-CsWatch.ps1 -Once   # 一轮
.\scripts\Start-CsWatch.ps1         # 持续（会自动打开美团/抖音页，若尚未打开）
.\scripts\Start-CsWatch.ps1 -SkipOpenSites  # 不自动开网站
```

白名单示例（非写死，改 JSON 即可）：

```json
"whitelist": {
  "meituan": ["AXw710416874"],
  "douyin": ["徐😏😏"]
}
```

## 知识库

1. 文档：`knowledge/raw/` 或 `knowledge/cards/`  
2. Embedding：`config/cs-runtime.json` → `knowledge.embedding`（对齐骨架 EMBEDDING_*）  
3. 建索引：`node apps/edge-worker/kb-index.js`  
4. 测检索：`node apps/edge-worker/kb-retrieve.js --query "能上门取吗" --json`  
5. 巡检日志：`KB_HIT` / `MEITUAN switch`（未读切换）

## 未读优先

`preferUnread: true` 时：

1. 扫描会话列表角标（美团 `.mtd-badge` / 抖音未读）  
2. 只处理白名单  
3. **切换到该会话**再读消息、检索、回复  

## 平台入口

| 平台 | URL |
|---|---|
| 美团经营宝 IM | `https://g.dianping.com/dzim-main-pc/index.html#/` |
| 抖音来客客服 | `https://life.douyin.com/cs/web/...` |

## 明确禁用

- `127.0.0.1:3000` / `3001` 旧客服 AI  
- Chrome RPA 扩展与 `/rpa/*`
