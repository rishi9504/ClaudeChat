require("dotenv").config({ path: __dirname + "/.env" });

const db = require("./db");
const llm = require("./llm");

const MAX_TRANSCRIPT_CHARS = 20000;
const MAX_MSG_CHARS = 900;

function compactContent(content) {
  let value = String(content || "");
  value = value.replace(/\[Tool:\s*([^\]]+)\]\s*[\s\S]*?(?=\n\n|$)/g, "[used tool: $1]");
  value = value.replace(/\[Tool Result:[\s\S]*?\]/g, "[tool result]");
  value = value.replace(/\s+/g, " ").trim();
  if (value.length > MAX_MSG_CHARS) value = `${value.slice(0, MAX_MSG_CHARS - 4)} ...`;
  return value;
}

function buildTranscript(messages) {
  const lines = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    let label = message.role === "assistant" ? "Claude:" : message.role === "system" ? "System:" : "User:";
    const previous = i > 0 ? messages[i - 1] : null;
    if (message.role === "user" && previous && previous.role === "assistant" && previous.content.includes("[Tool: ")) {
      label = "Tool:";
    }
    const content = compactContent(message.content);
    if (content) lines.push(`${label} ${content}`);
  }
  let transcript = lines.join("\n");
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    const first = Math.floor(MAX_TRANSCRIPT_CHARS * 0.6);
    const last = MAX_TRANSCRIPT_CHARS - first;
    transcript = `${transcript.slice(0, first)}\n[... middle of the conversation omitted ...]\n${transcript.slice(-last)}`;
  }
  return transcript;
}

async function getStoredSummary(sessionId) {
  const result = await db.query(
    "SELECT summary, summary_updated_at FROM sessions WHERE id = $1",
    [sessionId]
  );
  if (!result.rows.length) return null;
  return result.rows[0];
}

async function generateSessionSummary(sessionId) {
  if (!llm.llmEnabled()) throw new Error("No LLM provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.");
  const session = await db.query("SELECT * FROM sessions WHERE id = $1", [sessionId]);
  if (!session.rows.length) throw new Error("Session not found");
  const messages = await db.query(
    "SELECT role, content FROM messages WHERE session_ref = $1 ORDER BY inserted_at ASC, id ASC",
    [sessionId]
  );
  if (!messages.rows.length) throw new Error("Session has no messages");

  const transcript = buildTranscript(messages.rows);
  const prompt = [
    "Summarize this Claude Code conversation in markdown with exactly this shape:",
    "**TL;DR** one sentence",
    "",
    "**Key points**",
    "- 3 to 6 bullets",
    "",
    "**Outcome**",
    "1 to 2 sentences, or omit this section if there was no outcome.",
    "",
    transcript,
  ].join("\n");
  const result = await llm.chat(prompt, { maxTokens: 700 });
  const summary = String(result.text || "").trim();
  if (!summary) throw new Error("LLM returned an empty summary");
  await db.query(
    "UPDATE sessions SET summary = $1, summary_updated_at = NOW() WHERE id = $2",
    [summary, sessionId]
  );
  return { summary, model: result.model };
}

module.exports = {
  getStoredSummary,
  generateSessionSummary,
  buildTranscript,
  compactContent,
};
