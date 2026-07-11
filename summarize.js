require("dotenv").config({ path: __dirname + "/.env" });

const path = require("path");

const DEFAULT_ANTHROPIC_MODEL = "claude-3-5-haiku-latest";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
let loggedFallback = false;

function resolveProvider() {
  if ((process.env.LLM_SUMMARY || "").toLowerCase() === "off") return null;
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  return null;
}

function timeoutMs() {
  return parseInt(process.env.LLM_TIMEOUT_MS || "15000", 10);
}

function heuristicSummary({ relPath, lang, symbols = [], imports = [] }) {
  const basename = path.basename(relPath || "file");
  const symbolNames = symbols.slice(0, 6).map((s) => s.name).filter(Boolean).join(", ");
  const symbolSuffix = symbolNames ? ` (${symbolNames})` : "";
  return `[auto] ${basename} - ${lang || "unknown"} file, ${symbols.length} symbol(s)${symbolSuffix}, ${imports.length} import(s).`;
}

function buildPrompt(file) {
  const symbols = (file.symbols || []).slice(0, 30).map((s) => `${s.kind} ${s.name} line ${s.line}`).join("\n");
  const imports = (file.imports || []).slice(0, 20).join("\n");
  return [
    "Summarize this file in 1-2 sentences for a codebase index. No preamble.",
    `Path: ${file.relPath}`,
    `Language: ${file.lang || ""}`,
    "",
    "Symbols:",
    symbols || "(none)",
    "",
    "Imports:",
    imports || "(none)",
    "",
    "Source:",
    String(file.source || "").slice(0, 6000),
  ].join("\n");
}

async function postJson(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = null;
    }
    if (!res.ok) throw new Error(`Summary LLM failed ${res.status}: ${text.slice(0, 300)}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropic(prompt) {
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
  const data = await postJson("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 150,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  return Array.isArray(data.content) ? data.content.map((p) => p.text || "").join("") : "";
}

async function callOpenAI(prompt) {
  const model = process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
  const base = (process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL).replace(/\/$/, "");
  const data = await postJson(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 150,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  return data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content || ""
    : "";
}

async function summarizeFile(file) {
  const fallback = heuristicSummary(file);
  const provider = resolveProvider();
  if (!provider) {
    if (!loggedFallback) {
      console.error("No summary LLM configured; using heuristic file summaries.");
      loggedFallback = true;
    }
    return fallback;
  }

  try {
    const prompt = buildPrompt(file);
    const raw = provider === "anthropic" ? await callAnthropic(prompt) : await callOpenAI(prompt);
    const summary = String(raw || "").replace(/\s+/g, " ").trim().slice(0, 600);
    return summary || fallback;
  } catch (err) {
    if (!loggedFallback) {
      console.error(`Summary LLM failed; using heuristic summaries: ${err.message}`);
      loggedFallback = true;
    }
    return fallback;
  }
}

module.exports = {
  summarizeFile,
  heuristicSummary,
  resolveProvider,
};
