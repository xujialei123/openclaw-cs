# 研发流程梳理（Dev Flow）

> 给研发/Agent 用的**流程与边界图**。操作步骤见 [guide.md](./guide.md)。  
> **规则**：新功能合并前，必须更新本页相关泳道 + `tasks.md` 状态 +（若影响操作）`guide.md`。

## 总览架构

```text
┌─────────────────────────────────────────────────────────┐
│ 运营 / 研发入口                                           │
│  Start-All → db:init(Supabase) → 18790 · 8787         │
│  最终交付：中台机独立部署库+RAG；边端只连远程（见 deploy.md） │
└───────────────┬─────────────────────────┬───────────────┘
                │                         │
                ▼                         ▼
┌───────────────────────────┐   ┌───────────────────────────┐
│ 边端 Edge（本仓）           │   │ 大脑 Brain（骨架/中台机）   │
│ · cs-watch 巡检            │   │ · rag-service             │
│ · admin 薄网关             │──▶│ · Postgres/pgvector（生产库）│
│ · OpenClaw 浏览器 CDP      │   │ · 备份 · HTTPS            │
└───────────────┬───────────┘   └───────────────────────────┘
                │
                ▼
┌───────────────────────────┐
│ 平台通道（Adapter 口子）    │
│ · meituan.im · douyin.im  │
│ ·（预留）product/deal/shop │
│ · order 自有系统查单（进行中）│
└───────────────────────────┘
```

## 客服主链路（当前优先走通）

```text
Tick
 → 读 cs-runtime（白名单 / knowledge / autoSend / systems.order）
 → 美团 list/open/read/send/settle
 → 抖音 list/open/read/send/settle
 → generateReply
      → 高风险：升级，不自动承诺
      → 查单意图 / 订单号：systems.order → order.lookup（SaaS 页）→ 结构化话术
      → retrieve(shopId, platform, kbIds)  【remote 优先】
      → 命中：对外话术
      → 未命中：onMiss（clarify / escalate / fallback）
 → 写 state（processed / quiet）+ 过程日志 + 聊天日志（chat-trace）
```

查单日志关键字：`ORDER_LOOKUP` / `ORDER_LOOKUP_FAIL`。OpenClaw 浏览器需已登录自有后台。

## 能力域（扩展口子，见 tasks §7）

| 域 | 状态 | 说明 |
|---|---|---|
| `im` | 进行中 | 美团/抖音会话 |
| `product` | 预留 | 上架/改价等 |
| `deal` | 预留 | 团购套餐 |
| `shop` | 预留 | 营业时间/公告 |
| `report` | 预留 | 只读巡检 |
| `order` | **进行中** | 自有系统查单：`apps/edge-worker/order-lookup.js` + `systems.order`；浏览器打开 [全部订单](https://yl-saas.xiyihangye.com/biz/cxorderlaundry) |

新域只加 Adapter + 配置，不改检索/升级内核。

## 改动时必须同步的清单

每次加功能，按序勾选：

1. [ ] `tasks.md`：冲刺项或 §7/§8 状态更新  
2. [ ] `docs/guide.md`：若影响启动/操作/排障  
3. [ ] `docs/dev-flow.md`：若影响架构/链路/能力域（**本页**）  
4. [ ] `AGENTS.md`：若影响 Agent 行为红线或 Session 约定  
5. [ ] 边端页可点到最新文档：`/guide`、`/dev-flow`  

未更新文档视为功能未完成。

## 关键路径速查

| 用途 | 路径 |
|---|---|
| **项目全景（文件职责 HTML）** | `admin/project-map.html` → http://127.0.0.1:18790/project-map |
| 边端环境变量 | `.env` / `.env.example` |
| 中台环境变量 | `brain/.env`（骨架） |
| 运行时配置 | `config/cs-runtime.json` |
| 巡检 | `apps/edge-worker/cs-watch.js` |
| 查单 Adapter | `apps/edge-worker/order-lookup.js` |
| 检索适配 | `apps/edge-worker/kb-retrieve.js` |
| 配置校验 | `packages/runtime-config` |
| 边端控制台 | `apps/console`（Next `:18790`）；知识库上传暂用 `npm run admin:legacy` |
| 一键启动 | `Start-All.bat` / `scripts/Start-All.ps1` |
| 建表 | `scripts/Ensure-Infra.ps1` / `npm run db:init`（Supabase，无 Docker） |
| 任务板 | `tasks.md` |
| 使用教程 | `docs/guide.md` |
| 本流程页 | `docs/dev-flow.md` |
| 生产交付 | `docs/deploy.md` |
| 日志 | `memory/cs-watch.log`（过程）+ `memory/chat-trace.jsonl`（顾客↔回复） |

## 禁止事项

- 旧客服 AI 便携包 / Chrome RPA 插件（3000/3001）  
- 把 `embeddings.json` / 本地 SQLite 当企业生产向量库  
- 话术长期写死在 JS；政策类进中台知识库  
- 未留 Adapter 口子就堆新平台 DOM 进巨型函数  
