# 最终交付形态 · 生产部署说明

> 目标形态：**中台集中部署一份；边端按坐席/门店多份。**  
> 库用 **Supabase（Postgres + pgvector）**；中台进程是 `rag-service`。**不需要 Docker / Redis。**  
> **原则：按交付形态一点点演进**；若等客服全做完再硬切中台，必现：地址写死、边端绑本机库、无备份、密钥混乱。

## 0. 为什么不能最后再一起处理部署

| 最后硬切的典型问题 | 从一开始按形态演进 |
|---|---|
| 代码写死 `127.0.0.1:8787` | 一律配置：`RAG_BASE_URL`、`.env` |
| 边端进程直接连库 | 边端只调中台 HTTP API |
| 本机卷当「唯一数据」 | 库在 Supabase / 中台机；边端零库 |
| 上线才发现 Embedding/密钥/权限 | 联调就用 `.env`，prod 换值不换结构 |
| 建表脚本两套 | 同一套 `brain/scripts/init-db.sql`（`npm run db:init`） |

**节奏建议**：

1. **现在（§P）**：本机 `rag-service` + Supabase，把客服跑通；同时做形态自检（TP.10、T9.0*）。  
2. **紧接着**：把 **同一套 rag-service** 部署到一台服务器，边端 `RAG_BASE_URL` 指过去验 `via=remote`。  
3. **再**：HTTPS、备份确认、多坐席。  
4. **不要**：§P～§8 全做完才第一次改 `RAG_BASE_URL`。

客服功能走通仍优先；**形态约束与功能并行**，不是互斥。

## 1. 目标架构

```text
                    ┌──────────────────────────────────────┐
                    │ 企业中台（独立服务器 / 内网 / 云）        │
                    │  · rag-service (Node，可 HTTPS 反代)     │
                    │  · Postgres + pgvector（**Supabase**）    │
                    │  · 运营台 / KB Admin（可同机）            │
                    │  · 备份 · 监控 · 密钥托管                 │
                    └───────────────┬──────────────────────┘
                                    │ HTTPS + API Key
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
        坐席机 A               坐席机 B               门店机 …
        Edge + OpenClaw        Edge + OpenClaw        Edge …
        cs-watch               cs-watch
        美团/抖音登录           美团/抖音登录
```

| 组件 | 部署位置 | 最终交付要求 |
|---|---|---|
| Postgres / pgvector | **Supabase**（或自建 Postgres） | 打开自动备份；禁止坐席机直连库 |
| rag-service | **中台服务器**（Node 进程） | systemd / NSSM / 面板守护；`/health` |
| 运营台 / Admin | 中台或同域反向代理 | HTTPS、账号权限（后续） |
| OpenClaw + cs-watch | **边端机** | 只连中台 `RAG_BASE_URL`；本机无数据库 |
| Redis | **不需要** | 当前检索 / 客服线未使用 |
| 自有订单系统 | 既有企业系统 | 边端 `order.lookup` 调 API，不拷库 |

## 2. 数据库（最终交付）

### 2.1 原则

- **生产库只在中台侧的云库（Supabase）**，坐席机默认 **零数据库**。
- 连接串只放中台 `brain/.env`，**禁止**提交 Git、禁止拷到每台边端。
- 建表：`npm run db:init`（`brain/scripts/init-db.sql`）；可重复执行。
- **不使用 Docker Compose、不使用 Redis。**

### 2.2 库与职责

| 库/对象 | 用途 |
|---|---|
| `customer_ai`（或企业命名） | 主库 |
| `rag_*` 表 | 知识库、向量、wiki/cards（`init-db.sql`） |
| Prisma 业务表（`shops` 等） | 多店/租户元数据（中台） |
| 向量维度 | 与 `EMBEDDING_DIM` / `VECTOR_DIM` 一致（当前 1536） |

### 2.3 备份与恢复（交付必做）

1. 每日逻辑备份（`pg_dump`）+ 定期基备  
2. 备份落盘与库机分离  
3. 恢复演练文档：空库 → 恢复 → `rag-service` 健康 → 试检索  
4. 保留期限按企业合规（建议 ≥ 30 天）

### 2.4 Supabase（当前库）

1. 创建项目：https://supabase.com/dashboard （区域优先新加坡 / 东京）  
2. **Database → Extensions** 启用 `vector`  
3. **Project Settings → Database**：复制 **URI**，选 **Session pooler 或 Direct**（端口 **5432**，不要 Transaction `6543`）  
4. 只写入中台 `brain/.env`（不要进 Git、不要拷到边端）：

```env
DATABASE_URL=postgresql://postgres.xxxx:密码@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=require
VECTOR_STORE=pgvector
VECTOR_DIM=1536
```

5. 建表：`npm run db:init`（`start:mid` / 全栈 `Start-All` 也会跑）  
6. 中台跑 `rag-service:8787`；边端只填 `RAG_BASE_URL`，**不要**配 `DATABASE_URL`

连接失败时核对：密码里的 `@` 要写成 `%40`；Direct 主机 `db.*.supabase.co` 在国内常只有 IPv6（报 ENOTFOUND），改用 **Session pooler**（`postgres.项目ref@aws-0-区域.pooler.supabase.com:5432`）。IPv4 不通可开 Supabase IPv4 add-on。

## 3. 环境分层

| 环境 | 中台 | 边端 | 数据库 |
|---|---|---|---|
| **dev（本机）** | 本机 rag-service | 同机 `Start-All` | Supabase |
| **staging** | 一台中台服务器 | 1～2 台边端 | 同一或独立 Supabase 项目 |
| **production** | 正式中台服务器 | 多坐席边端 | 正式库 + 备份 |

边端只改配置即可切环境，例如（也可在配置页 `http://127.0.0.1:18790/` 底部「环境变量」保存，改完需重启）：

```env
# 边端 .env（生产示例）
RAG_BASE_URL=https://rag.internal.example.com
RAG_API_KEY=<由中台签发的边端密钥>
# 边端不要配置 DATABASE_URL
```

```json
// config/cs-runtime.json（生产）
"knowledge": {
  "mode": "remote",
  "fallbackLocal": false,
  "rag": {
    "baseUrl": "https://rag.internal.example.com",
    "apiKey": "<同上>",
    "kbIds": ["..."],
    "shopId": "<门店ID>"
  }
}
```

## 4. 中台部署到服务器（可以，且不需要 Docker）

中台 = **一台能跑 Node 的机器** + **Supabase**。与本机 `npm run start:mid` 相同，只是换主机和 `RAG_BASE_URL`。

1. 服务器安装 Node 18+（不必装 Docker）  
2. 拷贝本仓；`npm install`；在 `brain/rag-service` 执行 `npm run build`  
3. 配置 `brain/.env`：`DATABASE_URL`（Supabase）、`EMBEDDING_*`、`RAG_API_KEY`  
4. `npm run db:init`  
5. `npm run start:mid` 或用 systemd/NSSM 守护 `node brain/rag-service/dist/main.js`（工作目录 `brain/rag-service`，环境 `CUSTOMER_AI_ROOT=brain`）  
6. 放行 **TCP 8787**；生产前加 Nginx/Caddy HTTPS  
7. 健康检查：`http://服务器IP:8787/health`；上传 FAQ → 试检索  
8. 坐席机 `.env`：`DEPLOY_ROLE=edge`，`RAG_BASE_URL=http://服务器IP:8787`（或 https 域名）

本机当中台试点：同一套命令，边端填局域网 IP。

## 5. 边端交付步骤（摘要）

1. 安装 OpenClaw 便携包；登录美团/抖音  
2. 部署本仓边端（无需本机 Postgres）  
3. 配置 `.env` + `cs-runtime.json` 指向生产中台  
4. `fallbackLocal=false`（生产禁止静默降级到过期本地库）  
5. 启动巡检；验收白名单会话 `KB_HIT via=remote`  

## 6. 与当前本机启动的关系

| 能力 | 本机联调 (`DEPLOY_ROLE=all`) | 本机当中台 (`npm run start:mid`) | 最终交付边端 (`DEPLOY_ROLE=edge`) |
|---|---|---|---|
| `Ensure-Infra` / `db:init` | ✅ 对 Supabase 建表 | ✅ | ❌ 边端不碰库 |
| 本地拉起 rag-service | ✅ | ✅（局域网可连 `:8787`） | ❌；只健康检查远程 `RAG_BASE_URL` |
| OpenClaw / cs-watch | ✅ | ❌ 不起 | ✅ 只在坐席机 |
| 配置 | `cs-runtime.json` | `brain/.env`（Supabase） | 边端只填 `RAG_BASE_URL` |
| 数据库 | Supabase | Supabase | 中台 `DATABASE_URL`；边端无库 |
| Docker / Redis | ❌ 不使用 | ❌ | ❌ |

本机中台联调：先 `npm run start:mid`，再在其他电脑装 **边端安装包**（`npm run desktop:dist:edge`），首次引导填 `RAG_BASE_URL=http://<局域网IP>:8787`。全栈安装包（`desktop:dist:full`）仅用于单机试点，角色在打包时固化，装机后不再切换。

## 7. 安全与合规底线

- API Key 按边端/环境轮换；禁止共用开发密钥  
- 顾客会话与订单号仅边端日志必要字段；定期清理  
- 生产关闭无鉴权管理口；Admin 需登录（后续）  
- 高风险写操作（改价/上架）必须审批（见 `tasks.md` §8）
