# 最终交付形态 · 生产部署说明

> 目标形态：**中台集中部署一份；边端按坐席/门店多份。**  
> 本机 `Start-All` + Docker Desktop = **联调替身**（同构缩小版），**不是**「最后再做部署」。  
> **原则：按交付形态一点点演进**；若等客服全做完再硬切中台，必现：地址写死、边端绑本机库、无备份、密钥混乱。

## 0. 为什么不能最后再一起处理部署

| 最后硬切的典型问题 | 从一开始按形态演进 |
|---|---|
| 代码写死 `127.0.0.1:5433` / `8787` | 一律配置：`RAG_BASE_URL`、`.env` |
| 边端进程直接连库 | 边端只调中台 HTTP API |
| 本机卷当「唯一数据」 | 本机卷 = 替身；生产另机 + 备份 |
| 上线才发现 Embedding/密钥/权限 | 联调就用 `.env`，prod 换值不换结构 |
| 建表脚本两套 | 同一套 `init-db.sql` / prisma migrate |

**节奏建议**：

1. **现在（§P）**：本机 Docker 当中台替身，把客服跑通；同时做形态自检（TP.10/TP.11、T9.0*）。  
2. **紧接着**：搭一台 staging 中台（可仍是 Compose），边端指过去验 `via=remote`。  
3. **再**：生产库备份、HTTPS、多坐席。  
4. **不要**：§P～§8 全做完才第一次改 `RAG_BASE_URL`。

客服功能走通仍优先；**形态约束与功能并行**，不是互斥。

## 1. 目标架构

```text
                    ┌──────────────────────────────────────┐
                    │ 企业中台（独立服务器 / 内网 / 云）        │
                    │  · rag-service (HTTPS)                 │
                    │  · Postgres + pgvector（主库，独立卷）   │
                    │  · Redis（队列/缓存，按需）              │
                    │  · 运营台 / KB Admin                    │
                    │  · 备份 · 监控 · 密钥托管                │
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
| Postgres / pgvector | **中台机**，独立数据卷 | 日备 + 保留策略；禁止只靠坐席本机 Docker |
| Redis | 中台机（若启用） | 可与 DB 同机，生产建议资源隔离 |
| rag-service | 中台机 | 进程守护 / systemd 或容器编排；健康检查 |
| 运营台 / Admin | 中台或同域反向代理 | HTTPS、账号权限（后续） |
| OpenClaw + cs-watch | **边端机** | 只连中台 `RAG_BASE_URL`；本机可不跑 Postgres |
| 自有订单系统 | 既有企业系统 | 边端 `order.lookup` 调 API，不拷库 |

## 2. 数据库（最终交付）

### 2.1 原则

- **生产库只在中台**，坐席机默认 **零数据库**。
- 连接串、备份账号只放中台密钥库 / 服务器 `.env`，**禁止**提交 Git、禁止拷到每台边端。
- 建表：中台首次部署执行 `scripts/init-db.sql`（RAG）+ Prisma migrate（业务表）；升级走迁移，不手改生产表。
- 本机 Docker `5433` 仅开发；生产端口与账号与联调分离。

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

## 3. 环境分层

| 环境 | 中台 | 边端 | 数据库 |
|---|---|---|---|
| **dev（本机）** | 本机骨架 + Docker | 同机 `Start-All` | 本机 `5433` |
| **staging** | 内网一台中台 | 1～2 台边端 | 独立 staging 库 |
| **production** | 正式中台 | 多坐席边端 | 正式库 + 备份 |

边端只改配置即可切环境，例如（也可在配置页 `http://127.0.0.1:18790/` 底部「环境变量」保存，改完需重启）：

```env
# 边端 .env（生产示例）
RAG_BASE_URL=https://rag.internal.example.com
RAG_API_KEY=<由中台签发的边端密钥>
# 不配置本机 DATABASE_URL；不跑 Ensure-Infra 的 compose（或 -SkipDocker）
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

## 4. 中台交付步骤（摘要）

1. 准备 Linux/Windows Server + Docker（或 K8s）  
2. 部署 Postgres（带 pgvector）、Redis  
3. 配置中台 `.env`：`DATABASE_URL`、`EMBEDDING_*`、`RAG_API_KEY`  
4. 执行建表 / migrate；拉起 `rag-service`  
5. 反代 HTTPS；仅内网或 VPN 可访问  
6. 健康检查：`/health`；上传样例 FAQ → 试检索  
7. 备份与监控上线  

详细命令以骨架 `docker-compose.yml`、`scripts/init-db.sql`、Prisma 为准；生产可用同构 Compose，**数据卷与密钥与开发隔离**。

## 5. 边端交付步骤（摘要）

1. 安装 OpenClaw 便携包；登录美团/抖音  
2. 部署本仓边端（无需本机 Postgres）  
3. 配置 `.env` + `cs-runtime.json` 指向生产中台  
4. `fallbackLocal=false`（生产禁止静默降级到过期本地库）  
5. 启动巡检；验收白名单会话 `KB_HIT via=remote`  

## 6. 与当前本机启动的关系

| 能力 | 本机联调 (`DEPLOY_ROLE=all`) | 本机当中台 (`npm run start:mid`) | 最终交付边端 (`DEPLOY_ROLE=edge`) |
|---|---|---|---|
| `Ensure-Infra` | ✅ 本机 Docker 替身 | ✅ | ❌ 跳过；库在中台机执行 |
| 本地拉起 rag-service | ✅ | ✅（局域网可连 `:8787`） | ❌；只健康检查远程 `RAG_BASE_URL` |
| OpenClaw / cs-watch | ✅ | ❌ 不起 | ✅ 只在坐席机 |
| 配置 | `cs-runtime.json` + 相对路径 / `${ENV}` | 本机 `brain/.env`；边端指局域网 IP | `cs-runtime.prod.example.json` 为模板 |
| 数据库 | 本机卷 | 本机卷（试点） | 中台持久卷 + 备份 |

本机中台联调：先 `npm run start:mid`，再在其他电脑装 **边端安装包**（`npm run desktop:dist:edge`），首次引导填 `RAG_BASE_URL=http://<局域网IP>:8787`。全栈安装包（`desktop:dist:full`）仅用于单机试点，角色在打包时固化，装机后不再切换。

## 7. 安全与合规底线

- API Key 按边端/环境轮换；禁止共用开发密钥  
- 顾客会话与订单号仅边端日志必要字段；定期清理  
- 生产关闭无鉴权管理口；Admin 需登录（后续）  
- 高风险写操作（改价/上架）必须审批（见 `tasks.md` §8）
