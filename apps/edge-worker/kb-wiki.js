/**
 * @file apps/edge-worker/kb-wiki.js
 * @module 本地 LLM Wiki 编译（对齐骨架 WikiCompiler + llm-wiki buildLocalWiki）
 * @description
 *   扫描 knowledge/raw（及手写 cards）→ 结构化 Wiki 页 → knowledge/index/wiki.json
 *   可选：把 FAQ/章节写成 knowledge/cards/_generated-*.md 供 Hybrid 索引。
 *   默认本地规则编译；knowledge.wiki.useLlm=true 时尝试 Gateway LLM，失败降级。
 *
 * @usage
 *   node apps/edge-worker/kb-wiki.js
 *   node apps/edge-worker/kb-wiki.js --config F:/openclawProject/config/cs-runtime.json
 *
 * @see apps/edge-worker/kb-retrieve.js
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const ROOT = path.join(__dirname, "..", "..");
const DEFAULT_CONFIG = path.join(ROOT, "config", "cs-runtime.json");

function loadJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function slugify(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[^\u4e00-\u9fffa-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "page";
}

function extractKeywords(text, limit = 12) {
  const words = String(text || "").match(/[\u4e00-\u9fff]{2,8}|[a-zA-Z0-9_-]{2,}/g) || [];
  const stop = new Set(["请问", "一下", "这个", "那个", "你们", "我们", "可以", "能不能", "是否", "怎么", "怎么样", "对外话术", "问法示例", "内部备注"]);
  const uniq = [];
  for (const w of words) {
    if (stop.has(w) || uniq.includes(w)) continue;
    uniq.push(w);
    if (uniq.length >= limit) break;
  }
  return uniq;
}

function readMarkdownDocs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".md") && f.toLowerCase() !== "readme.md")
    .filter((f) => !f.startsWith("_generated-")) // 生成物不回灌编译
    .map((f) => {
      const file = path.join(dir, f);
      return { file, text: fs.readFileSync(file, "utf8"), source: f, name: path.basename(f, ".md") };
    });
}

/** 骨架 extractFaq：问/答 成对 */
function extractFaq(text) {
  const matches = [
    ...String(text || "").matchAll(
      /(?:^|\n)\s*(?:问[:：]|#{1,6}\s*问[:：]?)([^\n]+)\n+\s*(?:答[:：])?([^\n]+(?:\n(?!\s*(?:问[:：]|#{1,6}\s*问))[^\n]+)*)/g
    ),
  ];
  return matches
    .map((m) => ({ question: m[1].trim(), answer: m[2].trim() }))
    .filter((x) => x.question && x.answer);
}

function extractPublicAnswer(md) {
  const noComments = String(md || "").replace(/<!--[\s\S]*?-->/g, "");
  const m = noComments.match(/##\s*对外话术\s*\n([\s\S]*?)(?=\n##\s|$)/);
  if (m) return m[1].trim();
  return "";
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

function extractSections(text) {
  const noComments = String(text || "").replace(/<!--[\s\S]*?-->/g, "");
  const skipTitle = /问法示例|对外话术|内部备注|关键词|样例卡片/;
  return [...noComments.matchAll(/^#{1,6}\s+(.+)\r?\n([\s\S]*?)(?=^#{1,6}\s+|$)/gm)]
    .map((m) => ({ question: m[1].trim(), answer: m[2].trim() }))
    .filter((item) => {
      if (!item.question || skipTitle.test(item.question)) return false;
      // 答案若几乎全是问法列表（- xxx），不是对外话术
      const lines = item.answer.split(/\n/).map((l) => l.trim()).filter(Boolean);
      const bulletOnly = lines.length > 0 && lines.every((l) => /^[-*]\s+/.test(l));
      if (bulletOnly) return false;
      return item.answer.length >= 8 && item.answer.length <= 3000;
    });
}

function extractFieldLines(text) {
  return [...String(text || "").matchAll(/^\s*[-*]\s+([^：:\n]{2,30})[：:]\s*(.+)$/gm)].map((m) => ({
    question: m[1].trim(),
    answer: `${m[1].trim()}：${m[2].trim()}`,
  }));
}

function classifyCategory(text) {
  const t = String(text || "");
  if (/上门|取件|取送|配送/.test(t)) return "pickup";
  if (/营业|几点|时间|地址|电话/.test(t)) return "hours";
  if (/套餐|团购|核销|洗哪些|可洗/.test(t)) return "package";
  if (/退款|赔偿|售后|差评/.test(t)) return "aftersale";
  if (/价格|多少钱|费用/.test(t)) return "price";
  return "faq";
}

function stripInternal(md) {
  return String(md || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/##\s*内部备注[\s\S]*$/m, "")
    .trim();
}

/**
 * 本地规则编译一篇文档为 WikiPage（对齐骨架 WikiCompiler 降级路径）
 */
function compileLocalPage(doc, opts = {}) {
  const maxCards = Math.max(1, Number(opts.maxCardsPerDoc) || 20);
  const body = stripInternal(doc.text);
  const title = doc.name.replace(/^faq-|^policy-/, "") || doc.name;
  const publicAnswer = extractPublicAnswer(doc.text);
  const questions = extractQuestionExamples(doc.text);
  const faqMap = new Map();
  // 已是规范化卡片：只用「问法 → 对外话术」，避免把问法列表达成答案
  if (publicAnswer) {
    if (questions.length) {
      for (const q of questions) faqMap.set(q, { question: q, answer: publicAnswer });
    } else {
      faqMap.set(title, { question: title, answer: publicAnswer });
    }
  } else {
    const faqFromPairs = extractFaq(body);
    const sections = extractSections(doc.text);
    const fields = extractFieldLines(body);
    for (const item of [...faqFromPairs, ...sections, ...fields]) {
      if (!item.question || !item.answer) continue;
      if (!faqMap.has(item.question)) faqMap.set(item.question, item);
    }
    if (!faqMap.size && body.length >= 8) {
      faqMap.set(title, { question: title, answer: body.slice(0, 500) });
    }
  }

  const faq = [...faqMap.values()].slice(0, maxCards);
  const keywords = extractKeywords(`${title}\n${body}`, 30);
  const aliases = [...new Set([...questions, ...keywords.slice(0, 8), title])].slice(0, 16);
  const category = classifyCategory(`${title} ${body.slice(0, 400)}`);
  const summary = (publicAnswer || body).slice(0, 240);
  const id = `wiki_${slugify(doc.source)}`;

  return {
    id,
    title,
    slug: slugify(title),
    summary,
    content: body,
    faq,
    keywords,
    aliases,
    questionVariants: questions,
    relatedTopics: [],
    sourceIds: [doc.source],
    sourceFiles: [doc.source],
    category,
    confidence: faq.length ? 0.72 : 0.55,
    updatedAt: new Date().toISOString(),
  };
}

function mergePagesByTitle(pages, maxPages) {
  const map = new Map();
  for (const page of pages) {
    const key = page.title;
    const existed = map.get(key);
    if (!existed) {
      map.set(key, { ...page });
      continue;
    }
    existed.summary = existed.summary.length >= page.summary.length ? existed.summary : page.summary;
    existed.aliases = [...new Set([...(existed.aliases || []), ...(page.aliases || [])])].slice(0, 16);
    existed.keywords = [...new Set([...(existed.keywords || []), ...(page.keywords || [])])].slice(0, 40);
    existed.sourceIds = [...new Set([...(existed.sourceIds || []), ...(page.sourceIds || [])])];
    existed.sourceFiles = [...new Set([...(existed.sourceFiles || []), ...(page.sourceFiles || [])])];
    const faqMap = new Map([...(existed.faq || []), ...(page.faq || [])].map((f) => [f.question, f]));
    existed.faq = [...faqMap.values()];
    existed.confidence = Math.max(existed.confidence || 0, page.confidence || 0);
  }
  return [...map.values()].slice(0, maxPages);
}

function buildEdges(pages) {
  const edges = [];
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      if (pages[i].category && pages[i].category === pages[j].category) {
        edges.push({
          id: `edge_${pages[i].id}_${pages[j].id}`,
          fromPageId: pages[i].id,
          toPageId: pages[j].id,
          relation: `同属${pages[i].category}`,
          confidence: 0.5,
        });
      }
    }
  }
  return edges.slice(0, 120);
}

function cardMarkdown(item, meta = {}) {
  const kws = (meta.keywords || []).slice(0, 12).join("、");
  const variants = [item.question, ...(meta.aliases || []).filter((a) => a !== item.question)].slice(0, 8);
  return `# ${item.question}

<!--
  由 apps/edge-worker/kb-wiki.js 从 raw/wiki 自动生成；勿手改（重建会覆盖）。
  wikiPageId: ${meta.wikiPageId || ""}
  source: ${meta.source || ""}
-->

## 问法示例

${variants.map((q) => `- ${q}`).join("\n")}

## 对外话术

${item.answer}

## 关键词

${kws || item.question}
`;
}

function writeGeneratedCards(kbRoot, pages, opts = {}) {
  const cardsDir = path.join(kbRoot, "cards");
  fs.mkdirSync(cardsDir, { recursive: true });
  // 清理旧生成物
  for (const f of fs.readdirSync(cardsDir)) {
    if (f.startsWith("_generated-") && f.endsWith(".md")) {
      fs.unlinkSync(path.join(cardsDir, f));
    }
  }
  if (opts.autoCardsFromRaw === false) return [];

  const written = [];
  const seenQ = new Set();
  let n = 0;
  for (const page of pages) {
    page.generatedSources = page.generatedSources || [];
    const faqs = page.faq && page.faq.length ? page.faq : page.summary ? [{ question: page.title, answer: page.summary }] : [];
    for (const item of faqs.slice(0, opts.maxCardsPerDoc || 20)) {
      const qKey = String(item.question || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "");
      if (!qKey || seenQ.has(qKey)) continue;
      seenQ.add(qKey);
      n += 1;
      const fname = `_generated-${String(n).padStart(3, "0")}-${slugify(item.question)}.md`;
      const fp = path.join(cardsDir, fname);
      fs.writeFileSync(
        fp,
        cardMarkdown(item, {
          wikiPageId: page.id,
          source: (page.sourceFiles || [])[0] || "",
          keywords: page.keywords,
          aliases: page.aliases,
        }),
        "utf8"
      );
      page.generatedSources.push(fname);
      written.push({ file: fname, wikiPageId: page.id, question: item.question });
    }
  }
  return written;
}

async function requestJson(url, { method = "GET", headers = {}, body } = {}) {
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
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
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
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 可选：Gateway LLM 增强结构化（失败则忽略） */
async function tryLlmEnrich(page, gatewayCfg) {
  if (!gatewayCfg?.useLlm || !gatewayCfg.baseUrl || !gatewayCfg.tokenFile) return page;
  let token = "";
  try {
    token = fs.readFileSync(gatewayCfg.tokenFile, "utf8").trim();
  } catch {
    return page;
  }
  const prompt = `请把下面客服知识整理成 JSON（不要 Markdown）：{"title":"","summary":"","aliases":[""],"keywords":[""],"faq":[{"question":"","answer":""}],"category":"faq|pickup|hours|package|aftersale|price"}
资料标题：${page.title}
正文：${page.content.slice(0, 2000)}`;
  try {
    const res = await requestJson(`${gatewayCfg.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: {
        model: gatewayCfg.model || "openclaw",
        temperature: 0.2,
        messages: [
          { role: "system", content: "你是企业知识库架构师。只返回合法 JSON。" },
          { role: "user", content: prompt },
        ],
      },
    });
    const content = res.json?.choices?.[0]?.message?.content || "";
    const jsonText = String(content)
      .replace(/^```json/i, "")
      .replace(/^```/, "")
      .replace(/```$/, "")
      .trim();
    const parsed = JSON.parse(jsonText.match(/\{[\s\S]*\}/)?.[0] || jsonText);
    if (parsed.title) page.title = String(parsed.title);
    if (parsed.summary) page.summary = String(parsed.summary);
    if (Array.isArray(parsed.aliases)) page.aliases = [...new Set([...(page.aliases || []), ...parsed.aliases.map(String)])].slice(0, 16);
    if (Array.isArray(parsed.keywords)) page.keywords = [...new Set([...(page.keywords || []), ...parsed.keywords.map(String)])].slice(0, 40);
    if (Array.isArray(parsed.faq)) {
      const faqMap = new Map([...(page.faq || []), ...parsed.faq.filter((f) => f?.question && f?.answer)].map((f) => [String(f.question).trim(), { question: String(f.question).trim(), answer: String(f.answer).trim() }]));
      page.faq = [...faqMap.values()];
    }
    if (parsed.category) page.category = String(parsed.category);
    page.llmEnriched = true;
  } catch {
    page.llmEnriched = false;
  }
  return page;
}

/**
 * 编译 Wiki 主入口
 * @param {{ root?: string, wiki?: object, gateway?: object }} opts
 */
async function buildWiki(opts = {}) {
  const kbRoot = opts.root || path.join(ROOT, "knowledge");
  const wikiCfg = opts.wiki || {};
  const maxPages = Math.max(1, Number(wikiCfg.maxPages) || 80);
  const maxCardsPerDoc = Math.max(1, Number(wikiCfg.maxCardsPerDoc) || 20);
  const rawDir = path.join(kbRoot, "raw");
  const cardsDir = path.join(kbRoot, "cards");
  const indexDir = path.join(kbRoot, "index");
  fs.mkdirSync(indexDir, { recursive: true });

  const docs = [...readMarkdownDocs(rawDir), ...readMarkdownDocs(cardsDir)];
  let pages = docs.map((d) => compileLocalPage(d, { maxCardsPerDoc }));

  if (wikiCfg.useLlm && opts.gateway) {
    pages = await Promise.all(pages.map((p) => tryLlmEnrich(p, opts.gateway)));
  }

  pages = mergePagesByTitle(pages, maxPages);
  const edges = buildEdges(pages);
  const generated = writeGeneratedCards(kbRoot, pages, {
    autoCardsFromRaw: wikiCfg.autoCardsFromRaw !== false,
    maxCardsPerDoc,
  });

  const payload = {
    version: 1,
    builtAt: new Date().toISOString(),
    mode: wikiCfg.useLlm ? "local+llm" : "local-rules",
    ref: "enterprise-knowledge-llm-wiki + skeleton WikiCompiler",
    pageCount: pages.length,
    edgeCount: edges.length,
    generatedCardCount: generated.length,
    pages,
    edges,
  };
  fs.writeFileSync(path.join(indexDir, "wiki.json"), JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function loadWiki(kbRoot) {
  return loadJson(path.join(kbRoot, "index", "wiki.json"), null);
}

/**
 * 查询命中的 wiki 页 → 关联 source 文件名集合（供检索加权）
 */
function matchWikiBoostSources(query, wikiPayload) {
  const q = String(query || "").trim();
  const boosted = new Set();
  const matchedPages = [];
  if (!q || !wikiPayload?.pages?.length) return { boosted, matchedPages };
  for (const page of wikiPayload.pages) {
    const names = [page.title, ...(page.aliases || []), ...(page.keywords || []).slice(0, 6)].filter(Boolean);
    const hit = names.some((name) => {
      const n = String(name);
      if (n.length < 2) return false;
      return q.includes(n) || n.includes(q) || [...(page.questionVariants || []), ...(page.faq || []).map((f) => f.question)].some((qv) => q.includes(String(qv).slice(0, 12)) || String(qv).includes(q.slice(0, 12)));
    });
    if (!hit) continue;
    matchedPages.push(page.id);
    for (const src of page.sourceFiles || page.sourceIds || []) boosted.add(src);
    for (const src of page.generatedSources || []) boosted.add(src);
    boosted.add(page.id);
  }
  return { boosted, matchedPages };
}

function printHelp() {
  console.log(`Usage:
  node apps/edge-worker/kb-wiki.js
  node apps/edge-worker/kb-wiki.js --config F:/openclawProject/config/cs-runtime.json
`);
}

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.includes("--help") || args.includes("-h")) {
      printHelp();
      process.exit(0);
    }
    const cfgIdx = args.indexOf("--config");
    const configPath = cfgIdx >= 0 ? args[cfgIdx + 1] : DEFAULT_CONFIG;
    const runtime = loadJson(configPath, {});
    const kbRoot = runtime.knowledge?.root || path.join(ROOT, "knowledge");
    const wikiCfg = runtime.knowledge?.wiki || {};
    if (wikiCfg.enabled === false) {
      console.log("[kb-wiki] disabled in config");
      process.exit(0);
    }
    const result = await buildWiki({
      root: kbRoot,
      wiki: wikiCfg,
      gateway: runtime.gateway,
    });
    console.log(
      `[kb-wiki] done pages=${result.pageCount} edges=${result.edgeCount} generatedCards=${result.generatedCardCount} mode=${result.mode}`
    );
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  buildWiki,
  loadWiki,
  matchWikiBoostSources,
  compileLocalPage,
  extractFaq,
};
