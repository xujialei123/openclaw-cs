/**
 * @file scripts/init-remote-db.js
 * @description Apply brain/scripts/init-db.sql to DATABASE_URL (Supabase / any Postgres).
 * Does not start Docker. Called by Ensure-Infra / npm run db:init.
 *
 *   node scripts/init-remote-db.js
 *   npm run db:init
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const BRAIN_ENV = path.join(ROOT, "brain", ".env");
const SQL_CANDIDATES = [
  path.join(ROOT, "brain", "scripts", "init-db.sql"),
  path.join(ROOT, "infra", "init-db.sql"),
];

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const raw of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key === "DATABASE_URL" || process.env[key] == null || process.env[key] === "") {
      process.env[key] = val;
    }
  }
}

function resolvePg() {
  const candidates = [
    path.join(ROOT, "brain", "rag-service", "node_modules", "pg"),
    path.join(ROOT, "node_modules", "pg"),
  ];
  for (const p of candidates) {
    try {
      return require(p);
    } catch {
      /* try next */
    }
  }
  throw new Error("Cannot find package `pg`. Run npm install in the repo (or brain/rag-service).");
}

function isLocalUrl(url) {
  try {
    const u = new URL(url.replace(/^postgresql:/i, "http:"));
    return /^(127\.0\.0\.1|localhost|::1)$/i.test(u.hostname);
  } catch {
    return /127\.0\.0\.1|localhost/i.test(String(url || ""));
  }
}

function hostOf(url) {
  const m = String(url || "").match(/@([^/?]+)/);
  return m ? m[1] : "(unparsed)";
}

function splitSql(sql) {
  return sql
    .split(";")
    .map((s) =>
      s
        .split(/\n/)
        .filter((line) => !/^\s*--/.test(line))
        .join("\n")
        .trim()
    )
    .filter(Boolean);
}

async function main() {
  loadDotEnv(path.join(ROOT, ".env"));
  loadDotEnv(BRAIN_ENV);

  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  if (!databaseUrl) {
    console.error("DATABASE_URL is empty. Set it in brain/.env (Supabase URI, sslmode=require).");
    process.exit(1);
  }

  const sqlFile = SQL_CANDIDATES.find((p) => fs.existsSync(p));
  if (!sqlFile) {
    console.error("init-db.sql not found under brain/scripts or infra/");
    process.exit(1);
  }

  const { Client } = resolvePg();
  const remote = /supabase\.co|pooler\.supabase|sslmode=require/i.test(databaseUrl) || !isLocalUrl(databaseUrl);
  const connectionString = databaseUrl
    .replace(/[?&]sslmode=[^&]*/gi, "")
    .replace(/[?&]$/, "")
    .replace(/\?$/, "");
  const client = new Client({
    connectionString,
    ssl: remote ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 25000,
  });

  console.log("[db:init] host=", hostOf(databaseUrl));
  console.log("[db:init] sql=", path.relative(ROOT, sqlFile));
  await client.connect();

  const statements = splitSql(fs.readFileSync(sqlFile, "utf8"));
  let ok = 0;
  let skipped = 0;
  for (const stmt of statements) {
    try {
      await client.query(stmt);
      ok += 1;
    } catch (e) {
      const msg = String(e.message || e);
      // ivfflat needs rows; empty cloud DB often fails this index.
      if (/ivfflat|lists/i.test(stmt) || /ivfflat|lists/i.test(msg)) {
        console.warn("[db:init] skip vector index (ok on empty DB):", msg.slice(0, 160));
        skipped += 1;
        continue;
      }
      if (/already exists/i.test(msg)) {
        skipped += 1;
        continue;
      }
      await client.end().catch(() => {});
      console.error("[db:init] failed:", msg);
      process.exit(1);
    }
  }

  const ext = await client.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
  await client.end();
  console.log(
    `[db:init] done statements=${ok} skipped=${skipped} pgvector=${ext.rows[0]?.extversion || "MISSING"}`
  );
  if (!ext.rows[0]) {
    console.error("Enable the `vector` extension in Supabase: Database → Extensions → vector");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[db:init]", e.message || e);
  process.exit(1);
});
