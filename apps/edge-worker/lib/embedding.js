/**
 * @file apps/edge-worker/lib/embedding.js
 * @module Embedding Provider（对齐 customer-ai-platform-skeleton）
 * @description
 *   镜像骨架 `services/rag-service/src/providers/embedding.ts`：
 *   - OpenAI 兼容 POST {baseUrl}/embeddings
 *   - 显式 dimensions、encoding_format=float
 *   - 批量 ≤8、单条截断 8000、超时 15s、失败重试
 *   - 未配置 key 时走 Mock（离线可跑，语义质量有限）
 *
 * @see F:\customer-ai-platform-skeleton\customer-ai-platform-skeleton\services\rag-service\src\providers\embedding.ts
 */

const crypto = require("crypto");

/**
 * @typedef {object} EmbeddingConfig
 * @property {boolean} [enabled]
 * @property {string} [baseUrl]  如 https://dashscope.aliyuncs.com/compatible-mode/v1
 * @property {string} [apiKey]
 * @property {string} [model]    如 text-embedding-v4
 * @property {number} [dimensions] 默认 1536，须与索引维度一致
 */

function isConfigured(cfg = {}) {
  const key = String(cfg.apiKey || "").trim();
  if (!key) return false;
  if (/^your_|^replace-me|xxx|changeme/i.test(key)) return false;
  return Boolean(cfg.baseUrl && cfg.model);
}

/** 余弦相似度 */
function cosineSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const den = Math.sqrt(na) * Math.sqrt(nb);
  return den ? dot / den : 0;
}

/** Mock：中文双字哈希向量（与骨架 MockEmbeddingProvider 同思路） */
async function mockEmbedText(text, dim) {
  const vector = Array.from({ length: dim }, () => 0);
  const clean = String(text || "")
    .toLowerCase()
    .replace(/\s+/g, "");
  for (let index = 0; index < clean.length; index += 1) {
    const token = clean.slice(index, index + 2) || clean[index];
    const hash = crypto.createHash("sha256").update(token, "utf8").digest();
    vector[hash.readUInt32BE(0) % dim] += hash[4] % 2 === 0 ? 1 : -1;
  }
  const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
  return norm ? vector.map((item) => item / norm) : vector;
}

async function retry(task, times = 2) {
  let lastError;
  for (let attempt = 0; attempt <= times; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * 调用 OpenAI 兼容 Embedding API。
 * @param {string[]} texts
 * @param {EmbeddingConfig} cfg
 * @returns {Promise<number[][]>}
 */
async function requestEmbeddings(texts, cfg) {
  const dim = cfg.dimensions || 1536;
  const clipped = texts.map((t) => String(t || "").slice(0, 8000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${String(cfg.baseUrl).replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        input: clipped.length === 1 ? clipped[0] : clipped,
        dimensions: dim,
        encoding_format: "float",
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Embedding 请求失败：${response.status} ${await response.text()}`);
    }
    const json = await response.json();
    const rows = Array.isArray(json.data)
      ? [...json.data].sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
      : [];
    return clipped.map((_, index) => rows[index]?.embedding ?? []);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 创建 Embedding 客户端。
 * @param {EmbeddingConfig} cfg
 */
function createEmbeddingProvider(cfg = {}) {
  const dim = cfg.dimensions || 1536;
  const configured = isConfigured(cfg);

  return {
    configured,
    dimensions: dim,
    async embedText(text) {
      const [v] = await this.embedTexts([text]);
      return v || [];
    },
    async embedTexts(texts) {
      if (!texts.length) return [];
      if (!configured) {
        return Promise.all(texts.map((t) => mockEmbedText(t, dim)));
      }
      if (texts.length <= 8) return retry(() => requestEmbeddings(texts, cfg));
      const results = [];
      for (let start = 0; start < texts.length; start += 8) {
        results.push(...(await retry(() => requestEmbeddings(texts.slice(start, start + 8), cfg))));
      }
      return results;
    },
  };
}

/** 入库拼接：title + 问法 + 答案 + keywords（对齐骨架 KnowledgeCard embed 文本） */
function buildEmbedDocument({ title, questions, answer, keywords }) {
  return [title, ...(questions || []), answer, ...(keywords || [])].filter(Boolean).join("\n");
}

module.exports = {
  createEmbeddingProvider,
  cosineSimilarity,
  isConfigured,
  buildEmbedDocument,
  mockEmbedText,
};
