# @file brain/README.md
# Mid-platform (Brain) — lives in this repo

This folder is the **knowledge mid-platform** for openclawProject delivery.
Edge (cs-watch / admin) talks to it only via `RAG_BASE_URL` (HTTP).

## Layout

| Path | Role |
|---|---|
| `brain/.env` | `DATABASE_URL` (Supabase) + Embedding + RAG_API_KEY |
| `brain/rag-service/` | rag-service process (`dist/main.js` on :8787) |
| `brain/scripts/init-db.sql` | RAG/pgvector DDL (`npm run db:init`) |

No Docker. No Redis.

## First-time setup

1. Copy `brain/.env.example` → `brain/.env`, set Supabase `DATABASE_URL` and `EMBEDDING_API_KEY`.
2. Build: in `brain/rag-service` run `npm run build`.
3. `npm run db:init` then `npm run start:mid` (or root `Start-All` when `DEPLOY_ROLE=all`).

## Not used

- Docker Compose / Redis
- Old Chrome RPA plugin / ports 3000/3001 — forbidden
- Edge `.env` should **not** hold DB/Embedding secrets; those belong here
