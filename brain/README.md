# @file brain/README.md
# Mid-platform (Brain) — lives in this repo

This folder is the **knowledge mid-platform** for openclawProject delivery.
Edge (cs-watch / admin) talks to it only via `RAG_BASE_URL` (HTTP).

## Layout

| Path | Role |
|---|---|
| `brain/.env` | DB + Embedding + RAG_API_KEY (local secrets) |
| `brain/rag-service/` | rag-service process (`dist/main.js` on :8787) |
| `infra/init-db.sql` | RAG/pgvector DDL（Ensure-Infra 使用） |
| `infra/docker-compose.yml` | Postgres + Redis containers |

## First-time setup

1. Copy `brain/.env.example` → `brain/.env`, set `EMBEDDING_API_KEY` (Qwen/DashScope).
2. Ensure `brain/rag-service` exists:
   - Preferred: copy or submodule `services/rag-service` from the platform repo into `brain/rag-service`.
   - Dev shortcut: directory junction to the platform `services/rag-service` (already used on this machine).
3. Build once: in `brain/rag-service` (or platform monorepo) run `pnpm build` / `pnpm build:rag`.
4. Run root `Start-All.bat` — it starts infra + brain + edge from **this project**.

## Not used

- Old Chrome RPA plugin / ports 3000/3001 — forbidden.
- Edge `.env` should **not** hold DB/Embedding secrets; those belong here.
