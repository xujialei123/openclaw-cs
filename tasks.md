# tasks.md — 美团经营宝 × 抖音来客（仅 OpenClaw）

<!--
  文件作用：冲刺任务板（给人看，也给 Agent 读）。
  状态约定：[ ] 未开始 · [~] 进行中 · [x] 完成 · [!] 阻塞
  原则：
    1) 禁用客服 AI 便携包 / 旧 RPA 插件，只走 OpenClaw 浏览器。
    2) 白名单与知识库路径走配置，不写死顾客/话术到脚本常量里。
    3) 话术最终以知识中台为准；本地 fallback / 脚本规则仅过渡。
    4) 先把客服线走通；同时把多店 / 多能力扩展口子留好，禁止把业务堆死在 cs-watch.js。
-->

> 状态：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 完成 · `[!]` 阻塞  
> **当前优先级：客服线走通（§P）**，但**一律按最终交付形态演进**（中台可远程、边端可零库），禁止最后再硬切。  
> 扩展口子（§7）与交付约束（§9 形态项）与 §P **并行**；代运营写操作（§8）仍延后。  
> **禁用**客服 AI 便携包 / RPA 插件。只走 OpenClaw Gateway + 托管浏览器。  
> **交付原则**：中台（库+RAG）集中部署；边端多机只连远程中台。本机 Docker = 联调替身，接口形状必须与生产一致。详见 `docs/deploy.md`。

---

## 演进原则（强制，避免最后硬切翻车）

> **最后才「一起处理部署」必然出问题**：本机写死 `127.0.0.1`、边端依赖本机库、密钥进仓库、无备份……上线时才改，成本最高。  
> **正确做法**：功能可以本机跑，**形态从第一天就按交付来**——配置可指向远程中台、库只经中台、边端可 `-SkipDocker`。

| 可以本机简化 | 从一开始就不能省 |
|---|---|
| 本机 Docker 当中台替身 | `RAG_BASE_URL` / apiKey / shopId 可换环境 |
| 单店白名单联调 | 禁止业务写死本机 `5433` 为唯一库 |
| 本机 Embedding 联调 | 密钥进 `.env`，不进 Git |
| 本机 Ensure-Infra 建表 | 建表脚本与生产同一套（init-db / migrate） |

§P 每项验收时附带自检：若把 `RAG_BASE_URL` 改成另一台中台，边端是否仍能工作（不依赖本机 Postgres）。

---

## P. 当前冲刺 — 客服线走通（优先）

> 验收标准：白名单新消息 → 检测 → **中台检索 `via=remote`** → 自动发送；双平台口径一致；未命中按 `onMiss`。

| ID | 状态 | 任务 | 验收 |
|---|---|---|---|
| TP.1 | `[~]` | 美团白名单巡检稳定（未读/同名多会话/去重） | 无连发、无错会话；`settle ok`；已修：顾客「转人工」误判 + 列表预览变化破冷却 |
| TP.2 | `[~]` | 抖音白名单巡检稳定（contactCard / 气泡清洗 / quiet） | `DOUYIN detect` → `send ok`；不卡旧气泡 |
| TP.3 | `[ ]` | 检索强制带 `shopId + platform + kbIds` | 日志可见；禁止串店话术 |
| TP.4 | `[ ]` | 常用 FAQ 进中台并 `via=remote` 命中 | 营业/套餐/上门/周末等不以脚本兜底为主 |
| TP.5 | `[ ]` | T3 问法双平台回归 | 同问法口径一致；退款走升级 |
| TP.6 | `[ ]` | 去掉/收窄 `generateReply` 硬编码兜底 | 仅保留问候级；政策类进知识库 |
| TP.7 | `[~]` | 一键启动稳定（Docker/建表 + 8787 + admin + OpenClaw + cs-watch） | `Start-All.bat`；`Ensure-Infra.ps1` |
| TP.8 | `[ ]` | 客服线「单店交付」清单 | 配置/登录/白名单/kbIds/日志路径文档化 |
| TP.9 | `[x]` | 启动带使用教程 + 研发流程页 | `/guide` `/dev-flow`；新功能必须同步文档（AGENTS） |
| TP.10 | `[~]` | **形态自检**：边端可只连远程中台（本机可不跑库） | `DEPLOY_ROLE=edge` + `RAG_BASE_URL`；`-SkipDocker` |
| TP.11 | `[x]` | 配置样例拆分：`cs-runtime.json`（联调）/ `cs-runtime.prod.example.json` | prod：`fallbackLocal=false`、远程 baseUrl |
| TP.12 | `[x]` | 转人工推企微内部群 Webhook | `notify.escalate` / `WECOM_ESCALATE_WEBHOOK_URL`；日志 `ESCALATE_NOTIFY ok` |

---

## 0. 环境准备（OpenClaw）

| ID | 状态 | 任务 | 验收 |
|---|---|---|---|
| T0.1 | `[x]` | OpenClaw Gateway 已启动 | `127.0.0.1:18789` |
| T0.2 | `[x]` | OpenClaw 托管浏览器可启动 | CDP 18800 |
| T0.3 | `[x]` | OpenClaw 浏览器登录美团经营宝 | 经营宝聊天页，账号在线 |
| T0.4 | `[x]` | OpenClaw 浏览器登录抖音来客 | `life.douyin.com/cs/web` 在线 |
| T0.5 | `[x]` | `TOOLS.md` / 运行配置就位 | 已更新 |

---

## 1. 美团经营宝 — OpenClaw 浏览器

| ID | 状态 | 任务 | 验收 |
|---|---|---|---|
| T1.1 | `[x]` | 打开经营宝 IM 并确认已登录 | snapshot / AX |
| T1.2 | `[x]` | 列出未读/进行中会话 | 可读列表 |
| T1.3 | `[x]` | 打开单条会话 | 可点开白名单顾客 |
| T1.4 | `[x]` | FAQ 起草（过渡期） | 后续改接知识库 |
| T1.5 | `[x]` | 投诉升级模板 | memory 已有样例 |
| T1.6 | `[x]` | 白名单顾客发送验证 | `AXw710416874` |

---

## 2. 抖音来客 — OpenClaw 浏览器

| ID | 状态 | 任务 | 验收 |
|---|---|---|---|
| T2.1 | `[x]` | 打开来客 IM 并确认已登录 | cs/web |
| T2.2 | `[x]` | 列出进行中会话 | 可读 |
| T2.3 | `[x]` | 读取会话原文 | 可读顾客句 |
| T2.4 | `[x]` | 团购咨询起草（过渡期） | 后续改接知识库 |
| T2.5 | `[x]` | 投诉/索赔升级模板 | memory 已有样例 |
| T2.6 | `[x]` | 白名单顾客发送验证 | `徐😏😏` |

---

## 3. 双平台对照

| ID | 状态 | 测试问法 | 美团结果 | 抖音结果 |
|---|---|---|---|---|
| T3.1 | `[~]` | 「你们今天营业到几点？」 | 过渡草稿 | 待知识库 |
| T3.2 | `[~]` | 「团购怎么用 / 用不用预约？」 | 过渡草稿 | 待知识库 |
| T3.3 | `[ ]` | 「想退款可以吗？」 | | |
| T3.4 | `[~]` | 赔偿 / 认错单 | 升级模板 | 升级模板 |

> T3 全部回归应在 **知识库接通后** 再跑一遍（见 TP.5），用同一批问法对比命中话术是否一致。

---

## 4. 白名单自动巡检

| ID | 状态 | 任务 | 验收 |
|---|---|---|---|
| T4.1 | `[x]` | `config/cs-runtime.json` 配置白名单（非写死） | 可热更新 |
| T4.2 | `[x]` | `apps/edge-worker/cs-watch.js` 自动检测新消息 | 日志有 detect |
| T4.3 | `[~]` | 后台持续巡检 | `Start-CsWatch.ps1` |
| T4.4 | `[~]` | 巡检回复接入知识库 | `KB_HIT via=remote` 为主 |
| T4.5 | `[x]` | **会话列表未读检测 → 切换会话再处理** | `MEITUAN/DOUYIN list/switch` |

改名单：只编辑 `config/cs-runtime.json` → `whitelist`。  
未读优先：`preferUnread: true`（默认开）。

---

## 5. 知识库 — 企业中台（remote）+ 本地降级（local）

> **企业主路径**：本仓 `brain/rag-service:8787` + `infra/` Postgres/pgvector  
> **边端**：OpenClaw `cs-watch`；本地文件索引仅降级  
> **禁止**：旧插件 3000/3001；默认依赖外部骨架盘符（仅 `brain/rag-service` 缺失时遗留回退）

| ID | 状态 | 任务 | 验收 |
|---|---|---|---|
| T5.1 | `[x]` | 建立 `knowledge/` 目录与上传约定 | README + cards/raw |
| T5.2 | `[x]` | 运营上传 raw 文档（md 优先） | `knowledge/raw/` 有业务文件 |
| T5.3 | `[x]` | 规范化卡片（问法/对外话术/关键词） | 含 `faq-package-scope.md` 等 |
| T5.4 | `[x]` | `kb-retrieve.js` 本地 Hybrid | `--query` 可用 |
| T5.4b | `[x]` | Embedding + Hybrid（local） | `lib/embedding.js` + `kb-index.js` |
| T5.4c | `[x]` | 本地 llm-wiki（降级） | `kb-wiki.js` |
| T5.5 | `[x]` | `knowledge.mode/rag/onMiss` 配置 | `cs-runtime.json` |
| T5.6 | `[x]` | `generateReply` 注入检索 | `KB_HIT` / `KB_MISS` |
| T5.7 | `[x]` | 未命中 `onMiss` | 默认 `clarify` |
| T5.8 | `[x]` | 本地索引（降级） | `kb-index.js` |
| T5.9 | `[ ]` | T3 问法知识库回归 | 双平台口径一致（同 TP.5） |
| T5.10 | `[x]` | **企业：直连骨架 `/api/rag/retrieve`** | `mode=remote` + `via=remote` |
| T5.11 | `[x]` | Admin 薄网关 + 一键启动 | `:18790` + `Start-All.bat` |

### 企业配置（摘要）

```json
"knowledge": {
  "mode": "remote",
  "fallbackLocal": true,
  "rag": {
    "baseUrl": "http://127.0.0.1:8787",
    "apiKey": "local-dev-key",
    "kbIds": []
  },
  "onMiss": "clarify"
}
```

一键：`Start-All.bat`。中台未起时日志应见 `KB_REMOTE_FAIL`（并可 local 降级）。

---

## 7. 扩展口子（客服走通期间就要留好）

> **目的**：代运营（多店客服 + 商品/活动/门店写操作 + **自有系统查单**）不推翻重来。  
> **原则**：客服继续交付；下列以「接口/配置骨架」为主，**不实现完整写操作/查单浏览器流**。  
> **禁止**：继续把政策话术、平台 DOM、门店差异、内部 ERP 地址堆进单个 `cs-watch.js` 巨型函数。

### 7.1 租户 / 门店配置

| ID | 状态 | 任务 | 验收 |
|---|---|---|---|
| T7.1 | `[ ]` | 配置模型：`org → shop → platforms[]` | 文档或 `config/tenants.example.json` |
| T7.2 | `[ ]` | 单店配置可挂：`whitelist / kbIds / shopId / onMiss / autoSend` | 与现 `cs-runtime` 字段对齐可迁移 |
| T7.3 | `[ ]` | 状态/锁/日志按 `shopId` 可隔离路径 | 预留 `stateFile`/`logFile` 模板，先单店仍可用 |
| T7.4 | `[ ]` | retrieve / generateReply 上下文必带 `shopId+platform` | 口子先留；TP.3 落地 |

### 7.2 平台 Adapter（会话能力）

| ID | 状态 | 任务 | 验收 |
|---|---|---|---|
| T7.5 | `[ ]` | 定义统一会话接口：`list / open / readLatest / send / settle` | `adapters/*.md` 或空模块骨架 |
| T7.6 | `[ ]` | 美团 IM 逻辑标为 `adapter.meituan.im`（可仍住在 cs-watch，但边界清晰） | 注释/拆分入口，禁止新平台 pen 进核心 |
| T7.7 | `[ ]` | 抖音 IM 逻辑标为 `adapter.douyin.im` | 同上 |
| T7.8 | `[ ]` | 新平台只加 Adapter，不改检索/升级内核 | AGENTS / 本文件约定写死 |

### 7.3 能力域注册（为代运营 / 自有系统留口）

| ID | 状态 | 任务 | 验收 |
|---|---|---|---|
| T7.9 | `[ ]` | 能力枚举预留：`im` / `product` / `deal` / `shop` / `report` / **`order`（自有系统）** | 配置或常量列表，未实现标 `disabled` |
| T7.10 | `[ ]` | 任务模型草案：`job_type / shopId / payload / status / approval` | `docs` 或 example JSON，不接执行器 |
| T7.11 | `[ ]` | 高风险动作标记：`requiresApproval`（改价/上架/改适用门店等） | 枚举表；查单只读默认可免审；改单必审 |
| T7.12 | `[ ]` | 审计字段预留：执行前后快照路径 / 操作者 / 结果 | 日志 schema 或注释，客服线可先只记 send |

### 7.3b 自有业务系统（查单等）— 口子必留

> 客服常需：**打开自有后台/ERP/OMS → 按订单号/手机号查询 → 把结果用于回复或升级**。  
> 与美团/抖音 IM 同级，做成独立 Adapter，不要写死 URL 在巡检脚本里。

| ID | 状态 | 任务 | 验收 |
|---|---|---|---|
| T7.16 | `[x]` | 配置口子：`systems.order`（baseUrl / 登录态 / 浏览器 profile 或 API） | `cs-runtime.json` + 配置页开关 |
| T7.17 | `[x]` | Adapter 接口草案：`order.lookup({ orderId, phone, shopId })` → 结构化结果 | `apps/edge-worker/order-lookup.js` |
| T7.18 | `[x]` | 客服流程预留「工具调用」点：命中查单意图 → 调 `order.lookup` → 再生成回复 | `generateReply` 已接 `tryHandle` |
| T7.19 | `[x]` | 查单失败 / 多单歧义 → 澄清或升级，不编造订单事实 | 无结果要截图；多单列出让选 |
| T7.20 | `[~]` | 优先 API；无 API 再用 OpenClaw 打开自有系统页自动化 | 现网 browser；API 通道预留 |

### 7.4 运营台 / 中台

| ID | 状态 | 任务 | 验收 |
|---|---|---|---|
| T7.13 | `[ ]` | Admin 按店切换（shop 选择器口子） | UI 可先占位；现网仍单店 |
| T7.14 | `[ ]` | 中台 kb 与 shop 绑定关系可配置 | `kbIds` 已存在；文档写清多店不共享串库 |
| T7.15 | `[ ]` | 可观测：按店看 `KB_HIT/MISS/升级/发送失败/查单次数` | 日志字段统一，报表可后做 |

---

## 8. 代运营写操作 + 自有系统自动化（客服线走通后再做）

> **平台侧**：上架、改价、团购、营业时间等。  
> **自有系统侧**：打开内部后台查订单/核销/物流等，供客服与运营自动调用。  
> **本阶段不开工实现**，只认 §7 / §7.3b 口子。

| ID | 状态 | 任务 | 验收 |
|---|---|---|---|
| T8.1 | `[ ]` | 商品：上架 / 下架 / 改库存 | Adapter `product.*` + 审批 |
| T8.2 | `[ ]` | 商品：改价 / 改标题详情 | 必审批 + diff 审计 |
| T8.3 | `[ ]` | 团购/套餐：创建与修改 | Adapter `deal.*` |
| T8.4 | `[ ]` | 门店：营业时间 / 公告 | Adapter `shop.*` |
| T8.5 | `[ ]` | 活动/优惠配置 | 高风险审批流 |
| T8.6 | `[ ]` | 数据巡检：差评、超时回复、库存告警 | `report.*` 只读先行 |
| T8.7 | `[ ]` | 任务队列执行器 + 失败重试 | 与 IM 巡检进程隔离 |
| T8.8 | `[ ]` | 运营台：任务起草 → 审批 → 执行结果 | 人可接管 |
| T8.9 | `[~]` | **自有系统：按订单号/手机号自动查单** | `order.lookup` 浏览器通道已通；API 待接 |
| T8.10 | `[ ]` | 自有系统：核销状态 / 洗护进度 / 取送信息查询 | 只读；结果可注入客服回复 |
| T8.11 | `[ ]` | 自有系统：改单/退款申请类写操作（若需要） | 必审批 + 审计；默认可先人工 |
| T8.12 | `[~]` | 客服「查单」闭环：顾客发单号 → 自动查 → 回传会话 | 白名单实测；失败升级 |

---

## 9. 最终交付形态 — 中台独立部署 + 生产库（从一开始按此演进）

> 文档：`docs/deploy.md`。  
> **不是「客服全做完再部署」**，而是：联调可用本机 Docker 替身，但接口/配置/建表路径与生产同构；§P 进行中同步消化下方 **形态项**，完整上线机（HTTPS/备份演练）可稍后。  
> 禁止：功能全部堆完再一次性改远程中台。

### 9.0 与 §P 并行的形态项（优先于「大上线」）

| ID | 状态 | 任务 | 验收 |
|---|---|---|---|
| T9.0a | `[x]` | 代码/脚本不假设库在边端本机 | 检索只经 `RAG_BASE_URL`；路径 `${ENV}` / 相对根 |
| T9.0b | `[x]` | Ensure-Infra 标明「中台机执行」；边端 `DEPLOY_ROLE=edge` 默认可 SkipDocker | Start-All + `.env.example` |
| T9.0c | `[~]` | 同一套 init-db / migrate 用于本机替身与中台 | Ensure-Infra 已用骨架脚本；staging 实机待验 |

### 9.1 架构与配置

| ID | 状态 | 任务 | 验收 |
|---|---|---|---|
| T9.0m | `[x]` | Monorepo：`apps/edge-worker` + `apps/console` + `packages/runtime-config` | `npm run edge` / `npm run console`；Start-All 可回退 legacy |
| T9.1 | `[x]` | 交付架构文档（中台集中 / 边端分布 / 库在中台） | `docs/deploy.md` |
| T9.2 | `[ ]` | 环境分层：dev / staging / production 配置样例 | 边端只改 `RAG_BASE_URL` + apiKey 可切换 |
| T9.3 | `[ ]` | 生产 `fallbackLocal=false` 约定与校验 | 中台不可达时明确失败，不静默用过期本地库 |
| T9.4 | `[ ]` | 边端安装包与中台安装包拆分说明 | Start 脚本参数：边端 `-SkipDocker`；中台只跑 Ensure-Infra + rag |

### 9.2 数据库与备份

| ID | 状态 | 任务 | 验收 |
|---|---|---|---|
| T9.5 | `[ ]` | 生产库独立实例（非坐席本机 Docker 卷） | 连接串仅中台 `.env`；边端无 DATABASE_URL |
| T9.6 | `[ ]` | 中台首次部署：init-db.sql + prisma migrate | 空机可重复执行；RAG/业务表就绪 |
| T9.7 | `[ ]` | 备份策略：日备 + 保留 + 恢复演练文档 | `docs/deploy.md` 有步骤；至少演练 1 次 |
| T9.8 | `[ ]` | 库账号权限分离（应用账号 / 备份账号） | 应用无 DROP 等高危权限（按企业规范） |

### 9.3 中台与边端上线

| ID | 状态 | 任务 | 验收 |
|---|---|---|---|
| T9.9 | `[ ]` | 中台 HTTPS 反代 + 健康检查 | `/health`；内网或 VPN |
| T9.10 | `[ ]` | Embedding / RAG_API_KEY 生产密钥托管 | 非 Git；可轮换 |
| T9.11 | `[ ]` | 边端指向生产中台实网验收 | 坐席机无本机 Postgres；`KB_HIT via=remote` |
| T9.12 | `[ ]` | 监控告警：中台宕机、磁盘、备份失败 | 有通知渠道即可（邮件/企微等） |
| T9.13 | `[ ]` | staging 环境一套（缩小版中台+1 边端） | 发版先 staging 再 production |

---

## 6. 本阶段刻意延后

- 旧客服 AI / RPA 插件链路  
- 全量顾客自动发送（仅白名单灰度）  
- 退款金额 / 改价 / 商品上架等写操作全自动（见 §8）  
- 自有系统查单 / 改单自动化（见 §7.3b / T8.9–T8.12；客服通后再接）  
- 多门店并行浏览器集群（§7 口子先留，集群后做）  
- **完整生产中台上线（见 §9；客服通后做，但配置按交付形态预留）**

---

## 实测记录

### 美团经营宝

```text
日期：2026-07-20
店铺账号：yongxinxihu（在线）
后台 URL：https://g.dianping.com/dzim-main-pc/index.html#/
备注：iframe DOM + 未读优先；同名会话用 data-chatid
知识库：mode=remote；以 via=remote 为准
```

### 抖音来客

```text
日期：2026-07-21
后台 URL：life.douyin.com/cs/web
备注：contactCard 列表；气泡需去掉时间行；勿反复点「只看未回复」
知识库：mode=remote；「周末能用吗」等已能 autoSend
```
