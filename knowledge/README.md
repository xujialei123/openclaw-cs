# knowledge/ — 客服知识（边端缓存 + 本地降级）

## 企业主路径（必读）

面向企业用户时，**向量知识库不在本目录**，而在骨架知识中台：

| 组件 | 地址 / 位置 |
|---|---|
| rag-service | `http://127.0.0.1:8787` |
| 向量库 | PostgreSQL + **pgvector** |
| Wiki / 卡片编译 | `POST .../compile-brain`（llm-wiki） |
| 检索 | `POST /api/rag/retrieve` |

边端配置：

- [`config/cs-runtime.json`](../config/cs-runtime.json) → `knowledge.mode: "remote"`
- `knowledge.rag.baseUrl` / `apiKey` / `kbIds`
- 配置页：`http://127.0.0.1:18790/`（`apps/console` 或 legacy `kb-admin-server`，只转发，不存生产向量）
- 骨架原生管理页：`http://127.0.0.1:8787/kb-admin`

一键启动：

```text
.\Start-All.bat
# 或
.\scripts\Start-All.ps1
```

## 本目录用途

| 路径 | 用途 |
|---|---|
| `raw/` | 本地上传备份 / `mode=local` 联调素材 |
| `cards/` | 本地规范化卡片（降级索引） |
| `index/` | 本地 `wiki.json` + `embeddings.json`（**非企业主索引**） |
| `db/` | 可选 SQLite 操作缓存（**不存生产向量**） |

## 模式说明

| `knowledge.mode` | 行为 |
|---|---|
| `remote` | 企业默认：调用 8787 Hybrid；失败时若 `fallbackLocal=true` 再用本目录索引 |
| `local` | 仅联调：本机 Hybrid（关键词 + Embedding + Wiki boost） |

## 本地降级命令（无中台时）

```text
node apps/edge-worker/kb-wiki.js
node apps/edge-worker/kb-index.js
node apps/edge-worker/kb-retrieve.js --query "这个套餐可以洗哪些东西？" --json
```

填写 Embedding `apiKey` 仅影响 **local** 模式。企业 Embedding 在骨架 `.env` / rag-service 配置。
