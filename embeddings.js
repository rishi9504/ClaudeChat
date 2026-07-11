require("dotenv").config({ path: __dirname + "/.env" });

const EMBED_DIMS = 1536;
const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

function embeddingsEnabled() {
  return !!process.env.OPENAI_API_KEY;
}

function timeoutMs() {
  return parseInt(process.env.LLM_TIMEOUT_MS || "15000", 10);
}

async function embed(inputs) {
  if (!embeddingsEnabled()) return null;
  const single = typeof inputs === "string";
  const list = single ? [inputs] : Array.isArray(inputs) ? inputs : [];
  if (list.length === 0) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  const base = (process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/embeddings`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_EMBED_MODEL || DEFAULT_MODEL,
        input: list.map((item) => String(item || "").slice(0, 8000)),
      }),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = null;
    }
    if (!res.ok) throw new Error(`Embedding request failed ${res.status}: ${text.slice(0, 500)}`);
    const vectors = (data.data || [])
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((row) => row.embedding);
    return single ? vectors[0] : vectors;
  } finally {
    clearTimeout(timer);
  }
}

async function embedOne(text) {
  const rows = await embed([text]);
  return rows && rows[0] ? rows[0] : null;
}

function toVectorLiteral(vec) {
  return `[${vec.join(",")}]`;
}

module.exports = {
  embed,
  embedOne,
  embeddingsEnabled,
  toVectorLiteral,
  EMBED_DIMS,
};
