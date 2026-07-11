require("dotenv").config({ path: __dirname + "/.env" });

const DEFAULT_ANTHROPIC_MODEL = "claude-3-5-haiku-latest";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

function timeoutMs() {
  return parseInt(process.env.LLM_TIMEOUT_MS || "30000", 10);
}

function resolveProvider() {
  const forced = (process.env.LLM_PROVIDER || "").trim().toLowerCase();
  if (forced) {
    if (forced === "anthropic" && process.env.ANTHROPIC_API_KEY) return "anthropic";
    if (forced === "openai" && process.env.OPENAI_API_KEY) return "openai";
    return null;
  }
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  return null;
}

function llmEnabled() {
  return resolveProvider() !== null;
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
    if (!res.ok) {
      throw new Error(`LLM request failed ${res.status}: ${text.slice(0, 500)}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropic(prompt, { system, maxTokens = 2000 } = {}) {
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  };
  if (system) body.system = system;

  const data = await postJson("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  const text = Array.isArray(data && data.content)
    ? data.content.map((part) => part && part.text ? part.text : "").join("")
    : "";
  return { text, model: data.model || model };
}

async function callOpenAI(prompt, { system, maxTokens = 2000, json = false } = {}) {
  const model = process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
  const base = (process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL).replace(/\/$/, "");
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const body = {
    model,
    max_tokens: maxTokens,
    messages,
  };
  if (json) body.response_format = { type: "json_object" };

  const data = await postJson(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  return {
    text: data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content || ""
      : "",
    model: data.model || model,
  };
}

async function chat(prompt, opts = {}) {
  const provider = resolveProvider();
  if (!provider) throw new Error("No LLM provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.");
  if (provider === "anthropic") return callAnthropic(prompt, opts);
  return callOpenAI(prompt, opts);
}

function stripFence(text) {
  let value = String(text || "").trim();
  value = value.replace(/^```(?:json)?\s*/i, "");
  value = value.replace(/\s*```$/i, "");
  return value.trim();
}

function findJsonBlock(text) {
  const value = String(text || "");
  const starts = [];
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "{" || value[i] === "[") starts.push(i);
  }
  for (const start of starts) {
    const open = value[start];
    const close = open === "{" ? "}" : "]";
    const stack = [];
    let inString = false;
    let escape = false;
    for (let i = start; i < value.length; i += 1) {
      const ch = value[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === "\"") inString = false;
        continue;
      }
      if (ch === "\"") {
        inString = true;
      } else if (ch === "{" || ch === "[") {
        stack.push(ch);
      } else if (ch === "}" || ch === "]") {
        const expected = stack[stack.length - 1] === "{" ? "}" : "]";
        if (ch !== expected) break;
        stack.pop();
        if (stack.length === 0 && ch === close) return value.slice(start, i + 1);
      }
    }
  }
  return null;
}

function parseJsonLoose(text) {
  const stripped = stripFence(text);
  try {
    return JSON.parse(stripped);
  } catch (_) {
    const block = findJsonBlock(stripped);
    if (!block) return null;
    try {
      return JSON.parse(block);
    } catch (__) {
      return null;
    }
  }
}

module.exports = {
  chat,
  llmEnabled,
  resolveProvider,
  parseJsonLoose,
};
