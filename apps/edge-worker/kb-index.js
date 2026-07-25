/**
 * @file apps/edge-worker/kb-index.js
 * @module 知识库索引构建（Wiki → Embedding）
 * @description
 *   1) 若 knowledge.wiki.enabled：编译 raw/cards → wiki.json + _generated cards
 *   2) Embedding 写入 knowledge/index/embeddings.json
 *   配置读取 config/cs-runtime.json → knowledge.*
 *
 * @usage
 *   node apps/edge-worker/kb-index.js
 *   node apps/edge-worker/kb-index.js --config F:/openclawProject/config/cs-runtime.json
 *   node apps/edge-worker/kb-index.js --skip-wiki
 *
 * @see apps/edge-worker/kb-retrieve.js
 * @see apps/edge-worker/kb-wiki.js
 * @see apps/edge-worker/lib/embedding.js
 */

const fs = require("fs");
const path = require("path");
const { buildIndex } = require("./kb-retrieve");

const ROOT = path.join(__dirname, "..", "..");
const DEFAULT_CONFIG = path.join(ROOT, "config", "cs-runtime.json");

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function main() {
  const args = process.argv.slice(2);
  const cfgIdx = args.indexOf("--config");
  const configPath = cfgIdx >= 0 ? args[cfgIdx + 1] : DEFAULT_CONFIG;
  const skipWiki = args.includes("--skip-wiki");
  const runtime = loadJson(configPath);
  const kbRoot = runtime.knowledge?.root || path.join(ROOT, "knowledge");
  const embedding = runtime.knowledge?.embedding || {};
  const wiki = runtime.knowledge?.wiki || {};
  console.log("[kb-index] root=", kbRoot);
  console.log("[kb-index] wiki.enabled=", wiki.enabled !== false && !skipWiki);
  console.log("[kb-index] embedding configured=", Boolean(embedding.apiKey && embedding.baseUrl));
  const index = await buildIndex(kbRoot, embedding, {
    wiki,
    gateway: runtime.gateway,
    skipWiki: skipWiki || wiki.enabled === false,
  });
  console.log(
    `[kb-index] done cards=${index.cards.length} wikiPages=${index.wikiPageCount ?? "n/a"} provider=${index.provider} dim=${index.dimensions}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
