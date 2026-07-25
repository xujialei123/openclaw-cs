/**
 * @file apps/edge-worker/kb-retrieve.js
 * @module 知识库检索适配层（remote 中台优先 + local 降级）
 * @description
 *   企业主路径：POST skeleton rag-service /api/rag/retrieve（pgvector Hybrid）
 *   联调降级：本地文件 Hybrid（关键词 + Embedding + Wiki boost）
 *
 * @example
 *   node apps/edge-worker/kb-retrieve.js --query "能上门取吗" --json
 *   node apps/edge-worker/kb-retrieve.js --query "营业到几点" --rebuild
 *
 * @see apps/edge-worker/lib/embedding.js
 * @see apps/edge-worker/kb-wiki.js
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { createEmbeddingProvider, cosineSimilarity, buildEmbedDocument } = require("./lib/embedding");
const { buildWiki, loadWiki, matchWikiBoostSources } = require("./kb-wiki");

const ROOT = path.join(__dirname, "..", "..");
const DEFAULT_KB_ROOT = path.join(ROOT, "knowledge");
const DEFAULT_RUNTIME = path.join(ROOT, "config", "cs-runtime.json");

const STOP = new Set(["请问", "一下", "这个", "那个", "你们", "我们", "可以", "能不能", "是否", "怎么", "怎么样"]);

function parseArgs(argv) {
  const out = { query: "", json: false, root: DEFAULT_KB_ROOT, limit: 3, rebuild: false, config: DEFAULT_RUNTIME };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--query") out.query = String(argv[++i] || "");
    else if (a === "--json") out.json = true;
    else if (a === "--root") out.root = String(argv[++i] || DEFAULT_KB_ROOT);
    else if (a === "--limit") out.limit = Number(argv[++i] || 3);
    else if (a === "--rebuild") out.rebuild = true;
    else if (a === "--config") out.config = String(argv[++i] || DEFAULT_RUNTIME);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function loadJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function normalizeChineseText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\s，。！？、,.!?;；:：()（）【】\[\]"'“”‘’]/g, "");
}

/** 镜像骨架 extractKeywords */
function extractKeywords(text) {
  const normalized = normalizeChineseText(text);
  const words = text.match(/[\u4e00-\u9fff]{2,8}|[a-zA-Z0-9_-]{2,}/g) || [];
  const bigrams = Array.from({ length: Math.max(0, normalized.length - 1) }, (_, i) => normalized.slice(i, i + 2));
  return [...new Set([...words, ...bigrams].map(normalizeChineseText).filter((item) => item.length >= 2 && !STOP.has(item)))];
}

function keywordScore(queryKeywords, cardText) {
  if (!queryKeywords.length) return 0;
  const normalized = normalizeChineseText(cardText);
  const matched = queryKeywords.filter((kw) => normalized.includes(normalizeChineseText(kw)));
  const coverage = matched.length / queryKeywords.length;
  const exactBonus = matched.some((kw) => kw.length >= 4) ? 0.15 : 0;
  return Math.min(1, coverage + exactBonus);
}

function readMarkdownDocs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".md") && f.toLowerCase() !== "readme.md")
    .map((f) => {
      const file = path.join(dir, f);
      return { file, text: fs.readFileSync(file, "utf8"), source: f };
    });
}

function extractPublicAnswer(md) {
  const noComments = String(md || "").replace(/<!--[\s\S]*?-->/g, "");
  const m = noComments.match(/##\s*对外话术\s*\n([\s\S]*?)(?=\n##\s|$)/);
  if (m) return m[1].trim();
  return noComments.trim();
}

function extractQuestionExamples(md) {
  const noComments = String(md || "").replace(/<!--[\s\S]*?-->/g, "");
  const m = noComments.match(/##\s*问法示例\s*\n([\s\S]*?)(?=\n##\s|$)/);
  if (!m) return [];
  return m[1]
    .split(/\n/)
    .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean);
}

function extractKeywordsFromCard(md) {
  const noComments = String(md || "").replace(/<!--[\s\S]*?-->/g, "");
  const m = noComments.match(/##\s*关键词\s*\n([\s\S]*?)(?=\n##\s|$)/);
  if (!m) return [];
  return m[1]
    .split(/[,，\n]/)
    .map((s) => s.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean);
}

function parseCard(doc) {
  const title = path.basename(doc.source, ".md");
  const answer = extractPublicAnswer(doc.text);
  const questions = extractQuestionExamples(doc.text);
  const keywords = extractKeywordsFromCard(doc.text);
  const embedText = buildEmbedDocument({ title, questions, answer, keywords });
  return { ...doc, title, answer, questions, keywords, embedText };
}

/**
 * 构建/刷新本地 embedding 索引。
 * @param {string} kbRoot
 * @param {object} embeddingCfg
 * @param {{ wiki?: object, gateway?: object, skipWiki?: boolean }} [extra]
 * @returns {Promise<object>}
 */
async function buildIndex(kbRoot, embeddingCfg, extra = {}) {
  const cardsDir = path.join(kbRoot, "cards");
  const indexDir = path.join(kbRoot, "index");
  fs.mkdirSync(indexDir, { recursive: true });

  let wikiMeta = null;
  if (!extra.skipWiki && extra.wiki?.enabled !== false) {
    wikiMeta = await buildWiki({
      root: kbRoot,
      wiki: extra.wiki || { enabled: true, autoCardsFromRaw: true },
      gateway: extra.gateway,
    });
  }

  const cards = readMarkdownDocs(cardsDir).map(parseCard).filter((c) => c.answer);
  const provider = createEmbeddingProvider(embeddingCfg || {});
  const vectors = await provider.embedTexts(cards.map((c) => c.embedText));
  const payload = {
    version: 2,
    builtAt: new Date().toISOString(),
    provider: provider.configured ? "openai-compatible" : "mock",
    model: embeddingCfg?.model || null,
    dimensions: provider.dimensions,
    wikiPageCount: wikiMeta?.pageCount ?? null,
    cards: cards.map((c, i) => ({
      source: c.source,
      title: c.title,
      answer: c.answer,
      questions: c.questions,
      keywords: c.keywords,
      embedText: c.embedText,
      embedding: vectors[i] || [],
    })),
  };
  fs.writeFileSync(path.join(indexDir, "embeddings.json"), JSON.stringify(payload), "utf8");
  fs.writeFileSync(
    path.join(indexDir, "meta.json"),
    JSON.stringify(
      {
        version: payload.version,
        builtAt: payload.builtAt,
        cardCount: payload.cards.length,
        wikiPageCount: payload.wikiPageCount,
        provider: payload.provider,
        model: payload.model,
        dimensions: payload.dimensions,
        status: "ready",
        mode: "hybrid+wiki",
      },
      null,
      2
    ),
    "utf8"
  );
  return payload;
}

function isRuleQuestion(query) {
  return /价格|多少钱|退款|时间|几点|电话|地址|规则|套餐|优惠|干洗|水洗|上门|取件|核销|洗哪些|可洗/.test(
    String(query || "")
  );
}

function loadIndex(kbRoot) {
  const p = path.join(kbRoot, "index", "embeddings.json");
  return loadJson(p, null);
}

function httpJson(url, { method = "GET", headers = {}, body, timeoutMs = 20000 } = {}) {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  const payload = body != null ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: {
          Accept: "application/json",
          ...(payload ? { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {
            /* ignore */
          }
          resolve({ status: res.statusCode || 0, json, raw });
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout ${timeoutMs}ms`));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * 企业主路径：骨架 Hybrid RAG（pgvector）
 */
async function retrieveRemote(query, opts = {}) {
  const rag = opts.rag || {};
  const baseUrl = String(rag.baseUrl || "http://127.0.0.1:8787").replace(/\/$/, "");
  const apiKey = rag.apiKey || "local-dev-key";
  const timeoutMs = Number(rag.timeoutMs) || 20000;
  const limit = opts.limit || 3;
  const q = String(query || "").trim();

  const res = await httpJson(`${baseUrl}/api/rag/retrieve`, {
    method: "POST",
    headers: { "x-api-key": apiKey },
    timeoutMs,
    body: {
      query: q,
      platform: opts.platform || rag.platform || "meituan",
      shopId: opts.shopId || rag.shopId || undefined,
      kbIds: Array.isArray(rag.kbIds) && rag.kbIds.length ? rag.kbIds : undefined,
    },
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`RAG HTTP ${res.status}: ${(res.raw || "").slice(0, 160)}`);
  }

  const results = res.json?.results || [];
  const hits = results
    .map((item) => ({
      score: Number(item.score ?? 0),
      answer: String(item.content || item.answer || "").trim(),
      source: item.metadata?.sourceName || item.title || item.id || "remote",
      title: item.title || "",
      vectorScore: Number(item.score ?? 0),
      keywordScore: 0,
      wikiBoost: false,
      id: item.id,
      metadata: item.metadata || {},
    }))
    .filter((h) => h.answer)
    .slice(0, limit);

  return {
    ok: true,
    query: q,
    hits,
    meta: {
      mode: "remote-rag-service",
      provider: "skeleton-8787",
      scanned: results.length,
      intent: res.json?.intent || null,
      rewrittenQueries: res.json?.rewrittenQueries || [],
      baseUrl,
      ref: "customer-ai-platform-skeleton/rag-service /api/rag/retrieve",
    },
  };
}

/** 探测中台是否存活 */
async function pingRag(rag = {}) {
  const baseUrl = String(rag.baseUrl || "http://127.0.0.1:8787").replace(/\/$/, "");
  try {
    const res = await httpJson(`${baseUrl}/health`, {
      timeoutMs: Number(rag.timeoutMs) || 3000,
      headers: rag.apiKey ? { "x-api-key": rag.apiKey } : {},
    });
    return res.status >= 200 && res.status < 300 && (res.json?.ok !== false);
  } catch {
    return false;
  }
}

/**
 * 本地文件 Hybrid（联调降级，非企业主路径）
 */
async function retrieveLocal(query, opts = {}) {
  const root = opts.root || DEFAULT_KB_ROOT;
  const limit = opts.limit || 3;
  const baseWeights = opts.weights || { vector: 0.55, keyword: 0.45, wiki: 0.1 };
  const minScore = opts.minScore ?? 0;
  const embeddingCfg = opts.embedding || {};
  const wikiCfg = opts.wiki || {};

  let index = loadIndex(root);
  const needRebuild =
    opts.rebuild ||
    !index ||
    !Array.isArray(index.cards) ||
    !index.cards.length ||
    // 卡片文件数变化时重建
    readMarkdownDocs(path.join(root, "cards")).length !== index.cards.length;

  if (needRebuild) {
    index = await buildIndex(root, embeddingCfg, { wiki: wikiCfg, gateway: opts.gateway });
  }

  const q = String(query || "").trim();
  const qKeywords = extractKeywords(q);
  const provider = createEmbeddingProvider(embeddingCfg);
  let queryVec = [];
  try {
    queryVec = await provider.embedText(q);
  } catch (e) {
    queryVec = [];
  }

  // 规则类问句：关键词权重略高（对齐 llm-wiki isRuleQuestion）
  let vectorW = Number(baseWeights.vector) || 0.55;
  let keywordW = Number(baseWeights.keyword) || 0.45;
  if (isRuleQuestion(q)) {
    vectorW = 0.42;
    keywordW = 0.58;
  }
  const wikiBoostAmount =
    wikiCfg.boost != null ? Number(wikiCfg.boost) : Number(baseWeights.wiki) || 0.1;

  let wikiPayload = wikiCfg.enabled === false ? null : loadWiki(root);
  if (wikiCfg.enabled !== false && !wikiPayload?.pages?.length && !needRebuild) {
    try {
      wikiPayload = await buildWiki({ root, wiki: wikiCfg, gateway: opts.gateway });
    } catch {
      wikiPayload = null;
    }
  }
  const { boosted: wikiBoostedSources, matchedPages } = matchWikiBoostSources(q, wikiPayload);

  const ranked = index.cards
    .map((card) => {
      const kw = keywordScore(
        qKeywords,
        `${card.title}\n${(card.questions || []).join("\n")}\n${card.answer}\n${(card.keywords || []).join(",")}`
      );
      const vec = queryVec.length && card.embedding?.length ? cosineSimilarity(queryVec, card.embedding) : 0;
      const vec01 = Math.max(0, vec);
      const wikiBoost =
        wikiCfg.enabled !== false && wikiBoostedSources.has(card.source) ? wikiBoostAmount : 0;
      const score = vectorW * vec01 + keywordW * kw + wikiBoost;
      return {
        score,
        vectorScore: vec01,
        keywordScore: kw,
        wikiBoost,
        answer: card.answer,
        source: card.source,
        title: card.title,
      };
    })
    .filter((r) => r.score > minScore && r.answer)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    ok: true,
    query: q,
    hits: ranked.map(({ score, answer, source, title, vectorScore, keywordScore, wikiBoost }) => ({
      score,
      answer,
      source,
      title,
      vectorScore,
      keywordScore,
      wikiBoost: wikiBoost > 0,
    })),
    meta: {
      mode: "local-hybrid-keyword-embedding-wiki",
      provider: provider.configured ? "openai-compatible" : "mock",
      scanned: index.cards.length,
      indexStatus: index.provider || "unknown",
      rebuilt: needRebuild,
      wikiPages: wikiPayload?.pageCount || wikiPayload?.pages?.length || 0,
      wikiMatched: matchedPages,
      ruleQuestion: isRuleQuestion(q),
      weights: { vector: vectorW, keyword: keywordW, wiki: wikiBoostAmount },
      ref: "local-fallback (not enterprise primary)",
    },
  };
}

/**
 * 统一入口：按 knowledge.mode 选择 remote / local，remote 失败可降级。
 * @param {string} query
 * @param {object} opts 可含 mode, rag, fallbackLocal, platform, shopId, 以及 local 选项
 */
async function retrieve(query, opts = {}) {
  const mode = String(opts.mode || "local").toLowerCase();
  const fallbackLocal = opts.fallbackLocal !== false;

  if (mode === "remote") {
    try {
      const remote = await retrieveRemote(query, opts);
      if ((remote.hits || []).length > 0) return remote;
      // 中台在线但无命中：可选降级本地文件（过渡期/未同步知识时）
      if (!fallbackLocal) return remote;
      const local = await retrieveLocal(query, opts);
      if ((local.hits || []).length > 0) {
        local.meta = { ...local.meta, fallbackFrom: "remote-empty", remoteMeta: remote.meta };
        return local;
      }
      return remote;
    } catch (e) {
      if (!fallbackLocal) {
        return {
          ok: false,
          query: String(query || "").trim(),
          hits: [],
          meta: {
            mode: "remote-rag-service",
            error: e.message || String(e),
            fallback: false,
          },
        };
      }
      const local = await retrieveLocal(query, opts);
      local.meta = {
        ...local.meta,
        remoteError: e.message || String(e),
        fallbackFrom: "remote",
      };
      return local;
    }
  }

  return retrieveLocal(query, opts);
}

/** 同步包装：若调用方不想 await，仍可拿到 Promise */
function retrieveSyncCompatible(query, opts) {
  return retrieve(query, opts);
}

function printHelp() {
  console.log(`Usage:
  node apps/edge-worker/kb-retrieve.js --query "能上门取吗"
  node apps/edge-worker/kb-retrieve.js --query "营业到几点" --json
  node apps/edge-worker/kb-retrieve.js --query "上门" --rebuild
`);
}

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.query) {
      printHelp();
      process.exit(args.help ? 0 : 1);
    }
    const runtime = loadJson(args.config, {});
    const kb = runtime.knowledge || {};
    const embedding = kb.embedding || runtime.embedding || {};
    const result = await retrieve(args.query, {
      mode: kb.mode || "local",
      rag: kb.rag,
      fallbackLocal: kb.fallbackLocal !== false,
      root: args.root || kb.root || DEFAULT_KB_ROOT,
      limit: args.limit || kb.limit || 3,
      embedding,
      weights: kb.weights,
      wiki: kb.wiki,
      gateway: runtime.gateway,
      platform: kb.rag?.platform,
      shopId: kb.rag?.shopId,
      minScore: 0,
      rebuild: args.rebuild,
    });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (!result.hits.length) {
      console.log("KB_MISS", result.meta?.mode || "", result.meta?.error || "");
      return;
    }
    console.log(`# mode=${result.meta?.mode || "?"}`);
    for (const h of result.hits) {
      console.log(
        `KB_HIT score=${h.score.toFixed(3)} vec=${(h.vectorScore || 0).toFixed(3)} kw=${(h.keywordScore || 0).toFixed(3)} wiki=${h.wikiBoost ? "1" : "0"} source=${h.source}`
      );
      console.log(h.answer);
      console.log("---");
    }
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  retrieve,
  retrieveRemote,
  retrieveLocal,
  pingRag,
  httpJson,
  retrieveSyncCompatible,
  buildIndex,
  extractPublicAnswer,
  extractKeywords,
  keywordScore,
};
