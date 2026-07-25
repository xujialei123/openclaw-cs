/**
 * @file apps/edge-worker/lib/kb-db.js
 * @module 知识库 SQLite（Node 内置 node:sqlite）
 * @description 文档 / Wiki 页 / 卡片元数据持久化；与 knowledge/ 文件双向同步。
 */

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..", "..", "..");
const DEFAULT_DB = path.join(ROOT, "knowledge", "db", "kb.sqlite");

function openDb(dbPath = DEFAULT_DB) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT 'raw',
      title TEXT,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'uploaded',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wiki_pages (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT,
      summary TEXT,
      content TEXT,
      aliases_json TEXT,
      faq_json TEXT,
      source_files_json TEXT,
      confidence REAL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL UNIQUE,
      title TEXT,
      answer TEXT,
      questions_json TEXT,
      keywords_json TEXT,
      wiki_page_id TEXT,
      generated INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

function nowIso() {
  return new Date().toISOString();
}

function upsertDocument(db, { filename, kind = "raw", title, content, status = "uploaded" }) {
  const t = nowIso();
  const existing = db.prepare("SELECT id FROM documents WHERE filename = ?").get(filename);
  if (existing) {
    db.prepare(
      `UPDATE documents SET kind=?, title=?, content=?, status=?, updated_at=? WHERE filename=?`
    ).run(kind, title || filename, content, status, t, filename);
    return existing.id;
  }
  const r = db
    .prepare(
      `INSERT INTO documents (filename, kind, title, content, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(filename, kind, title || filename, content, status, t, t);
  return Number(r.lastInsertRowid);
}

function listDocuments(db) {
  return db
    .prepare(
      `SELECT id, filename, kind, title, status, length(content) AS bytes, created_at, updated_at
       FROM documents ORDER BY updated_at DESC`
    )
    .all();
}

function getDocument(db, id) {
  return db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id);
}

function deleteDocument(db, id) {
  const row = getDocument(db, id);
  if (!row) return null;
  db.prepare(`DELETE FROM documents WHERE id = ?`).run(id);
  return row;
}

function replaceWikiPages(db, pages = []) {
  db.exec("DELETE FROM wiki_pages");
  const ins = db.prepare(
    `INSERT INTO wiki_pages (id, title, category, summary, content, aliases_json, faq_json, source_files_json, confidence, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const t = nowIso();
  for (const p of pages) {
    ins.run(
      p.id,
      p.title || "",
      p.category || "faq",
      p.summary || "",
      p.content || "",
      JSON.stringify(p.aliases || []),
      JSON.stringify(p.faq || []),
      JSON.stringify(p.sourceFiles || p.sourceIds || []),
      p.confidence || 0,
      t
    );
  }
}

function replaceCards(db, cards = []) {
  db.exec("DELETE FROM cards");
  const ins = db.prepare(
    `INSERT INTO cards (source, title, answer, questions_json, keywords_json, wiki_page_id, generated, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const t = nowIso();
  for (const c of cards) {
    ins.run(
      c.source,
      c.title || "",
      c.answer || "",
      JSON.stringify(c.questions || []),
      JSON.stringify(c.keywords || []),
      c.wikiPageId || null,
      c.generated ? 1 : 0,
      t
    );
  }
}

function listWikiPages(db) {
  return db
    .prepare(
      `SELECT id, title, category, summary, confidence, updated_at,
              length(content) AS bytes
       FROM wiki_pages ORDER BY updated_at DESC`
    )
    .all();
}

function listCards(db) {
  return db
    .prepare(
      `SELECT id, source, title, substr(answer,1,120) AS answer_preview, generated, updated_at
       FROM cards ORDER BY source`
    )
    .all();
}

function setMeta(db, key, value) {
  db.prepare(
    `INSERT INTO meta(key,value) VALUES(?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).run(key, typeof value === "string" ? value : JSON.stringify(value));
}

function getMeta(db, key, fallback = null) {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

function addJob(db, kind, status, detail) {
  const r = db
    .prepare(`INSERT INTO jobs (kind, status, detail, created_at) VALUES (?, ?, ?, ?)`)
    .run(kind, status, typeof detail === "string" ? detail : JSON.stringify(detail || {}), nowIso());
  return Number(r.lastInsertRowid);
}

function stats(db) {
  const docs = db.prepare(`SELECT COUNT(*) AS n FROM documents`).get().n;
  const wiki = db.prepare(`SELECT COUNT(*) AS n FROM wiki_pages`).get().n;
  const cards = db.prepare(`SELECT COUNT(*) AS n FROM cards`).get().n;
  return {
    documents: Number(docs),
    wikiPages: Number(wiki),
    cards: Number(cards),
    lastParse: getMeta(db, "lastParse"),
    lastIndex: getMeta(db, "lastIndex"),
  };
}

/**
 * 将 DB 中 raw 文档写回 knowledge/raw（解析前同步）
 */
function syncDocumentsToFiles(db, kbRoot) {
  const rawDir = path.join(kbRoot, "raw");
  fs.mkdirSync(rawDir, { recursive: true });
  const rows = db.prepare(`SELECT filename, content, kind FROM documents WHERE kind = 'raw'`).all();
  const written = [];
  for (const row of rows) {
    const fp = path.join(rawDir, row.filename);
    fs.writeFileSync(fp, row.content, "utf8");
    written.push(row.filename);
  }
  return written;
}

module.exports = {
  DEFAULT_DB,
  openDb,
  upsertDocument,
  listDocuments,
  getDocument,
  deleteDocument,
  replaceWikiPages,
  replaceCards,
  listWikiPages,
  listCards,
  setMeta,
  getMeta,
  addJob,
  stats,
  syncDocumentsToFiles,
};
