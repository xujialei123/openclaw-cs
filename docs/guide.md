# OpenClaw 客服边端 · 使用教程

> 本页是**操作手册**。研发流程见 [dev-flow.md](./dev-flow.md)。  
> **规则**：凡新增/变更功能，必须同步更新本文件与 `admin` 对应页（见 `AGENTS.md`）。

## 正常使用需要准备什么

### 必装 / 必有

| 组件 | 说明 | 本机常见路径 |
|---|---|---|
| **Windows + PowerShell** | 跑 `Start-All.bat` / `.ps1` | — |
| **OpenClaw USB 便携包** | 自带 Node、Gateway、托管浏览器（CDP） | `F:\OpenClaw-USB-Portable` |
| **本仓 openclawProject** | 边端 + **infra/** + **brain/**（中台） | `F:\openclawProject` |
| **brain/.env** | DB / 千问 Embedding / RAG_API_KEY | 本仓 `brain\` |
| **infra/** | Docker Compose Postgres+Redis、建表 SQL | 本仓 `infra\` |
| **OpenClaw USB 便携包** | Node、Gateway、托管浏览器 | `OPENCLAW_PORTABLE_ROOT` |

> 日常跑客服边端时，**不必单独装系统 Node**：用便携包内 `node-win-x64\node.exe` 即可。

### 企业知识中台（正式话术 / remote 模式）还要

| 组件 | 说明 |
|---|---|
| **Docker Desktop** | 跑本仓 `infra/docker-compose`（Postgres/pgvector + Redis） |
| **brain/rag-service** | 本仓中台进程（`:8787`）；见 `brain/README.md` |
| **brain/.env** | `DATABASE_URL`、`EMBEDDING_API_KEY`（千问）等 |

### 不需要装的

- 旧「客服 AI 便携包」/ Chrome RPA 插件（3000/3001）— **禁用**
- 为本仓再装一份全局 Node（可用 OpenClaw 自带）
- 把本地 `embeddings.json` / SQLite 当生产向量库

### 仅联调、暂时没有中台时

可把 `knowledge.mode` 临时改为 `local` 且 `fallbackLocal: true`，只用本仓 `knowledge/` 文件索引。**正式使用仍以 remote + 8787 为准。**

## 环境变量（.env）— 两处都在本仓

| 文件 | 作用 | 是否提交 Git |
|---|---|---|
| 本仓 `.env` | 边端：路径、端口、`RAG_BASE_URL` | ❌ |
| 本仓 `brain/.env` | 中台：库、千问 Embedding、`RAG_API_KEY` | ❌ |
| `.env.example` / `brain/.env.example` | 模板 | ✅ |

也可在边端配置页底部 **「环境变量（.env）」** 编辑常用项（`http://127.0.0.1:18790/`）：

- **首次 / 未配好时**：配置台会自动弹出 **分步引导**（路径 → 平台 → 白名单 → 查单 → 完成）；也可点顶栏「分步引导配置」重来
- 只暴露白名单字段（路径、`DEPLOY_ROLE`、`RAG_*`、`EMBEDDING_*`、`DATABASE_URL` 等）
- 密钥 GET 不回传明文；保存时**留空 = 不修改**
- 保存 `RAG_BASE_URL` / `RAG_API_KEY` 时会同步进 `cs-runtime.json`
- **改完后需重启** `Start-All`（以及已在跑的 rag-service）才完全生效

### 1）边端（本仓根目录 `.env`）

```text
F:\openclawProject\.env.example   → 复制为 .env
```

| 变量 | 含义 |
|---|---|
| `OPENCLAW_PORTABLE_ROOT` | OpenClaw 便携包路径 |
| `BRAIN_ROOT` | 中台目录，默认本仓 `brain\` |
| `RAG_BASE_URL` | 中台地址，默认 `http://127.0.0.1:8787` |
| `RAG_API_KEY` | 须与 `brain/.env` 的 `RAG_API_KEY` 一致 |

### 千问 Embedding（DashScope）

**正式路径（remote）**：密钥写在本仓 **`brain/.env`**：

```text
F:\openclawProject\brain\.env
```

```env
EMBEDDING_PROVIDER=openai-compatible
EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBEDDING_API_KEY=sk-你的密钥
EMBEDDING_MODEL=text-embedding-v4
EMBEDDING_DIM=1536
VECTOR_STORE=pgvector
```

改完后**重启 rag-service**（或再执行 `Start-All`）。

白名单 / kbIds / 分平台监听与发送 仍写在 `config/cs-runtime.json`，也可在配置页改。

### 2）知识中台（本仓 `brain/.env`）

```text
F:\openclawProject\brain\.env.example → brain\.env
```

| 变量 | 含义 |
|---|---|
| `DATABASE_URL` | Postgres，宿主端口 **5433**（本仓 `infra/` 容器） |
| `REDIS_URL` | Redis |
| `RAG_SERVICE_PORT` | 默认 `8787` |
| `RAG_API_KEY` | 与边端一致 |
| `EMBEDDING_*` | 千问 DashScope |

可选：`LLM_*`、`ORDER_*` / `ADMIN_*`（自有系统查单预留）。

> 若你「看不到 .env」：资源管理器可能隐藏了点文件；在 Cursor 里打开本仓根目录应能看到 `.env` / `.env.example`。骨架 `.env` 在骨架根目录，不在本仓。

## 一键启动

1. 安装并尽量保持 **Docker Desktop** 可用（首次会自动拉镜像、起容器、建表）。
2. 双击项目根目录 `Start-All.bat`，或：

```powershell
npm start                 # 推荐：infra + rag + 控制台 + Gateway/浏览器 + cs-watch
npm run desktop           # 桌面托盘端：启停 Start-All + 内嵌管理台
npm run start:watch       # 只起 Gateway/浏览器 + 巡检（不开 Docker/rag）
npm run edge              # 仅巡检进程（需 18800 已就绪）
npm run edge:dev          # 开发：改 apps/edge-worker 代码自动重启进程
npm run stop
# 等价：.\scripts\Start-All.ps1
# 说明：cs-runtime.json / 白名单每轮热读；改 JS 需 edge:dev 或重启巡检
```

桌面端说明见 [`apps/desktop/README.md`](../apps/desktop/README.md)。**关闭窗口或托盘「退出」都会先 `Stop-All` 再退出**（最小化窗口不会停服务）。

**配置页位置**：一体端窗口右侧 **「配置中心」**（内嵌 `http://127.0.0.1:18790/`），不弹系统浏览器；管理台绿灯后点「刷新配置页」。桌面壳改 `apps/desktop/ui/`；配置台/教程改 `admin/docs.css`、`admin/config.css`、`admin/index.html`（重启管理台或点刷新配置页）。独立「日志页」没有——启动日志在桌面左栏，配置台内有操作日志面板。

打 Windows 安装包（默认内置精简 OpenClaw 便携包，**不含登录态**）：

```powershell
npm run desktop:dist
# 产物：dist-pack/desktop/OpenClaw-CS-Setup-*.exe
```

装机后直接「启动全部」，再在托管浏览器扫码登录即可。若打包时加 `-SkipPortable`，则需手动选便携包目录。

覆盖安装前先从托盘退出一体端。若安装器提示「无法关闭」：多半是**旧目录里的 portable `node.exe` 还在跑**（不是主程序关不掉）。取消安装 → 任务管理器结束所有路径含 `openclaw-portable` 的 `node.exe` → 删掉旧安装目录 → 用 **0.2.3+** 重装到短路径如 `F:\OpenClawCS`。

启动顺序：

0. **Ensure-Infra**：检测/拉起 Docker → `docker pull`（缺镜像时）→ `compose up`（Postgres:5433 + Redis:6379）→ 执行 `init-db.sql` 建 RAG 表 → 有 Prisma 则 `migrate deploy`
1. 拉起本仓 `brain/rag-service`（8787）
2. 边端配置台（18790：已 build 的 Next `apps/console`，否则 legacy `kb-admin`）并打开教程
3. **OpenClaw Gateway**（18789，最小化窗口）→ 托管浏览器（CDP 18800）
4. cs-watch 巡检（`apps/edge-worker`）

仓库为 npm workspaces：`apps/*` + `packages/*`。首次：

```powershell
npm install
npm run console:build   # 可选：之后 Start-All 优先用 Next
npm run edge:once       # 冒烟一轮巡检
```

强制用 Next 开发台：`.env` 设 `USE_NEXT_CONSOLE=1`，或直接 `npm run console`。

若出现 `GatewayTransportError: gateway closed (1006)`：说明 Gateway 未起就调了 `browser start`。重新跑 `Start-All`（已会自动起 Gateway），或先手动运行便携包 `Start-OpenClaw.bat`。

跳过 Docker（仅联调本地 knowledge / 或已是远程中台边端）：

```powershell
.\scripts\Start-All.ps1 -SkipDocker
```

边端交付形态（不拉本机库，只连中台）——在 `.env` 设：

```env
DEPLOY_ROLE=edge
RAG_BASE_URL=https://rag.internal.example.com
RAG_API_KEY=...
```

生产配置样例：`config/cs-runtime.prod.example.json`（`fallbackLocal=false`）。

仅基础设施：

```powershell
.\scripts\Ensure-Infra.ps1
```

3. 启动后会打开边端控制台，并打印教程地址。

### 停止服务

双击 `Stop-All.bat`，或：

```powershell
.\scripts\Stop-All.ps1
```

默认停：`cs-watch`、边端控制台（Next 或 legacy admin）、本机 `rag-service`。  
默认不停：Docker 数据库、OpenClaw 浏览器（避免每次重登）。

```powershell
.\scripts\Stop-All.ps1 -StopDocker      # 额外停 Postgres/Redis 容器
.\scripts\Stop-All.ps1 -StopBrowser     # 尝试关 OpenClaw 浏览器
.\scripts\Stop-All.ps1 -KeepRag         # 保留 8787
```

| 入口 | 地址 |
|---|---|
| 使用教程（本页） | http://127.0.0.1:18790/guide |
| 研发流程梳理 | http://127.0.0.1:18790/dev-flow |
| 项目全景（目录/文件职责） | http://127.0.0.1:18790/project-map |
| 生产交付（中台/库） | http://127.0.0.1:18790/deploy |
| 边端配置 / 白名单 / 环境变量 | http://127.0.0.1:18790/（`apps/console` 或 legacy admin） |
| 知识中台（骨架） | http://127.0.0.1:8787/kb-admin |

## 启动后检查清单

1. OpenClaw 橙框浏览器已登录 **美团经营宝**、**抖音来客**。
2. `config/cs-runtime.json` 中白名单正确（测试期只开指定顾客）。
3. `knowledge.mode` 为 `remote`，`rag.kbIds` 已填中台知识库 ID。
4. 日志 `memory/cs-watch.log` 出现 `TICK` / `MEITUAN` / `DOUYIN`，检索优先见 `KB_HIT via=remote`。

### 美团慢回 / 不回（先看日志）

| 日志 | 含义 | 怎么处理 |
|---|---|---|
| 无新的 `TICK` / 进程不在 | 巡检挂了（常见 `cdp timeout`） | 桌面端或 `Start-CsWatch` 重启巡检 |
| `MEITUAN skip cooldown … 60s` | 刚查过且无未读，冷却中 | 正常；列表预览变成新问句应立刻再进 |
| `MEITUAN skip empty/ui` | 切进会话后读不到未处理顾客气泡 | 看未读角标是否为 0、气泡是否被智能推荐挡住；改代码后需**重启 cs-watch** |
| `unreadTotal=0` 且预览仍是旧问句 | 该句可能已回过（`processed` 有指纹） | 用白名单再发一条**新**消息测 |
| 顾客说「转人工」却不进线 | 旧逻辑把含「转人工」的句误判成客服话 | 已修：只过滤客服侧「帮您转人工」等；重启巡检生效 |

改 `apps/edge-worker/cs-watch.js` 后配置热读不够，必须重启巡检进程。

## 日常操作

### 改白名单

编辑 `config/cs-runtime.json` → `whitelist.meituan` / `whitelist.douyin`，或在边端配置页保存。  
巡检每轮热读配置，一般无需重启。

### 美团 / 抖音自动监听与发送

配置页「边端运行配置」顶部可分别开关：

| 开关 | 字段 | 关了会怎样 |
|---|---|---|
| 美团/抖音 · 自动监听 | `platforms.*.enabled` | 该平台本轮不巡检 |
| 美团/抖音 · 自动发送 | `platforms.*.autoSend` | 仍识别/生成回复，只进 `pending` 不发出 |

全局 `autoSend: false` 仍会关掉所有平台发送。保存后下个 tick 生效。

### OpenClaw「browser navigation blocked by policy」

启动巡检时若报 `GatewayClientRequestError: browser navigation blocked by policy`：OpenClaw 默认 SSRF 策略拦了打开美团/抖音页面。

在便携包 `data\.openclaw\openclaw.json` 增加（或合并）后**重启 Gateway**：

```json
"browser": {
  "ssrfPolicy": {
    "dangerouslyAllowPrivateNetwork": true,
    "allowedHostnames": [
      "g.dianping.com",
      "life.douyin.com",
      "yl-saas.xiyihangye.com"
    ]
  }
}
```

再跑 `Start-CsWatch` / 一体端「启动全部」。

### 转人工推送到企微群

升级（退款/赔偿、知识库强制 escalate、话术含「转人工」等）时，可推到**企微内部群**，方便负责人手机感知。

**只在配置中心配置**（不要再写 `.env`）：

1. 企微内部运营群 → 右上角 `···` → **添加群机器人** → 复制 Webhook  
2. 打开配置中心 → **升级通知 · 企微群**：粘贴 Webhook、启用=开 → 点「保存到 cs-runtime.json」  
3. 验收：触发退款类话术 → 群里收到摘要；日志 `ESCALATE_NOTIFY ok`

说明：只能推**内部群**；开关与地址以配置页为准（`notify.escalate`）。

### 企业微信智能机器人（长连接 API）

与美团/抖音浏览器巡检不同：企微走官方 **智能机器人长连接**（`@wecom/aibot-node-sdk`），**私聊与群 @ 共用**现有回复引擎（**自动查单** + 知识库 + LLM）。

1. 企微后台创建智能机器人 → **API 模式** → **使用长连接** → 获取 Bot ID / Secret；授权「消息」等权限；可见范围勾好  
2. 群设置 → **添加群机器人** → 选该智能机器人（否则群里 @ 不到）  
3. 本仓 `.env` 填写：
   ```env
   WECOM_AIBOT_ID=你的BotID
   WECOM_AIBOT_SECRET=你的Secret
   ```
4. `config/cs-runtime.json` → `platforms.wecom.enabled: true`（查单仍用 `systems.order`，与美团/抖音相同）  
5. 安装依赖并启动：
   ```powershell
   npm install
   npm run start:wecom
   ```
   或 `Start-All`（启用且密钥齐全时会自动起 wecom-bridge）  
6. 验收：私聊机器人 / 群里 @ 机器人发「查一下订单号…」→ 日志出现 `WECOM` + `ORDER_LOOKUP`  

文档：[智能机器人长连接](https://developer.work.weixin.qq.com/document/path/101463)

### 运营场景自动化（开站 → 扫描 → 操作）

面向**内部运营**（默认仅企微 `allowedPlatforms: ["wecom"]`），通过聊天让 OpenClaw 打开浏览器、扫描页面，再按场景配方或安全动作执行。

1. 复制 `config/scenarios.example.json` → `config/scenarios.json`，按业务加场景（`triggers` / `startUrl` / `steps`）  
2. `cs-runtime.json` → `systems.scenarios.enabled: true`  
3. CDP 浏览器在线后，在企微对机器人说例如：
   - `打开订单后台`
   - `打开美团客服`
   - `打开网站 https://example.com 并扫描`
   - `打开网站 https://… 然后点击查询`（需 `allowLlmAutomate`）  
4. CLI 联调：
   ```powershell
   npm run scenario -- --list
   npm run scenario -- --run order_dashboard
   npm run scenario -- --browse "https://example.com"
   ```

安全限制：顾客侧美团/抖音默认**不会**触发任意开站；动作仅允许 `clickText` / `type` / `enter` / `wait` / `scan`。

### 自有系统查单（洗护 SaaS）

配置：`config/cs-runtime.json` → `systems.order`，也可在配置页动态改（开关、后台 URL、意图模式、条数、AI 等），**保存后下个 tick 生效**。

| 项 | 说明 |
|---|---|
| 开/关 | `enabled` |
| 后台 URL | `baseUrl`（自动 `browser open`） |
| 意图 | `intentMode`：`ai+rules` / `ai` / `rules` |
| AI | `intentAi.provider` / `model` |
| 条数 / 自由文本 | `maxResults` / `freeTextKeyword` |

1. 在 OpenClaw 托管浏览器中**登录** [全部订单](https://yl-saas.xiyihangye.com/biz/cxorderlaundry)（保持登录态）。
2. 顾客要查单时会**自动打开**该后台页（OpenClaw `browser open`；无需手点）。首次需在橙框浏览器里登录一次并保持登录态。
3. 有可搜关键字 → 填「关键字」查询并回传；缺信息 → 先要订单号/手机号/订单名（不编造）
4. 日志：`ORDER_LOOKUP via=…`；打开方式见失败时的 `openHow`  
   单测：`node apps/edge-worker/order-lookup.js --once yl_你的单号`  
   AI 意图依赖 Gateway 或 `brain/.env` 的 `EMBEDDING_API_KEY`（DashScope 兼容 chat）

关闭：`systems.order.enabled=false`。纯规则：`intentMode=rules`。纯 AI：`intentMode=ai`。

### 上传话术（企业主路径）

1. 打开 http://127.0.0.1:18790/ 或骨架 `8787/kb-admin`
2. 上传 Markdown → ingest → compile-brain
3. 用试检索确认命中后再让顾客实网提问

本地 `knowledge/` 仅联调降级，**不是**生产向量库。

### 看是否自动回复

关注日志关键字：

- `detect` → 识别到顾客句  
- `KB_HIT via=remote` / `KB_MISS`  
- `send {"ok":true}` / `settle ok`

### 常见问题

| 现象 | 处理 |
|---|---|
| `GatewayTransportError` / 1006 | Gateway（18789）未起；重新 `Start-All`，或先开便携包 `Start-OpenClaw.bat` |
| 查单失败 / 登录页 | 确认 OpenClaw 浏览器在线；首次登录 [订单后台](https://yl-saas.xiyihangye.com/biz/cxorderlaundry)；看 `ORDER_LOOKUP` / `openHow` |
| 查单打不开页 | 旧逻辑 CDP `/json/new` 会 405；现已改 `browser open` 自动开；重启 cs-watch |
| 抖音不回 | 看是否 `skip quiet` / 列表 `rows=0`；确认来客 tab 在线；勿反复点「只看未回复」 |
| 美团连发 | 确认只有一个 `cs-watch`；看 lock `memory/cs-watch.lock` |
| `KB_REMOTE_FAIL` | 检查 8787 / Postgres；可临时 `fallbackLocal` |
| 中台未起 | 本仓 `brain/rag-service` + `brain/.env` 的 `DATABASE_URL`；看 8787 `/health` |

## 当前阶段范围

- **做**：白名单客服自动巡检 + 知识库回复 + **自有 SaaS 查单**（`systems.order`）  
- **交付目标**：中台独立部署、生产库在中台、边端零库（见 [deploy.md](./deploy.md) / http://127.0.0.1:18790/deploy）  
- **不做（见 tasks §8）**：全量顾客、自动退款改价、商品上架；查单 API 通道与改单写操作后置

扩展口子：`tasks.md` §7；生产部署任务：`tasks.md` §9。

## 最终交付 vs 本机联调

| | 本机联调（现在） | 最终交付 |
|---|---|---|
| 数据库 | 本机 Docker `5433`（**替身**） | **中台独立 Postgres/pgvector** + 备份 |
| rag-service | 本机 8787（替身） | 中台 HTTPS |
| 边端 | 与中台同机可 | 多坐席机，只配 `RAG_BASE_URL` |
| 启动 | `Start-All` 含 Ensure-Infra | 中台机跑库+RAG；边端 `-SkipDocker` |

**不要等最后再部署**：功能用替身跑，配置形状从一开始就要能换成远程中台（见 [deploy.md](./deploy.md) §0）。  
完整说明：[生产交付文档](./deploy.md)。
