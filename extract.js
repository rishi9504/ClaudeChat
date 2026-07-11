require("dotenv").config({ path: __dirname + "/.env" });

const crypto = require("crypto");
const db = require("./db");
const llm = require("./llm");
const embeddings = require("./embeddings");
const projects = require("./projects");

const TYPES = new Set(["decision", "fact", "solved_problem", "convention", "todo", "gotcha"]);
const CHUNK_CHARS = 14000;
const MAX_CHUNKS = 8;
const MAX_ARTIFACTS_PER_CHUNK = 12;

const SYSTEM_PROMPT = [
  "Distill durable, reusable project knowledge from Claude Code conversations.",
  "Keep only decisions, facts, conventions, gotchas, todos, and solved problems that will matter in future work.",
  "Ignore chit-chat, temporary debugging noise, and facts that are only useful for the current moment.",
  "Each artifact must be self-contained and understandable without the transcript.",
].join(" ");

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function chunkTranscript(messages) {
  const chunks = [];
  let current = "";
  for (const message of messages) {
    const line = `${String(message.role || "user").toUpperCase()}: ${message.content || ""}\n\n`;
    if (current && current.length + line.length > CHUNK_CHARS) {
      chunks.push(current);
      current = "";
      if (chunks.length >= MAX_CHUNKS) break;
    }
    if (line.length > CHUNK_CHARS) {
      chunks.push(line.slice(0, CHUNK_CHARS));
      if (chunks.length >= MAX_CHUNKS) break;
    } else {
      current += line;
    }
  }
  if (current && chunks.length < MAX_CHUNKS) chunks.push(current);
  return chunks.slice(0, MAX_CHUNKS);
}

function artifactPrompt(chunk) {
  return [
    "Return strict JSON in this shape:",
    "{\"artifacts\":[{\"type\":\"decision|fact|solved_problem|convention|todo|gotcha\",\"title\":\"<=80 chars\",\"content\":\"1-3 sentences\",\"files_touched\":[\"path\"]}]}",
    `Return at most ${MAX_ARTIFACTS_PER_CHUNK} artifacts. Return {"artifacts":[]} if nothing durable qualifies.`,
    "",
    "Conversation excerpt:",
    chunk,
  ].join("\n");
}

function cleanArtifact(raw) {
  const type = TYPES.has(raw && raw.type) ? raw.type : "fact";
  const title = String(raw && raw.title || "").replace(/\s+/g, " ").trim().slice(0, 200);
  const content = String(raw && raw.content || "").replace(/\s+/g, " ").trim().slice(0, 2000);
  const files = Array.isArray(raw && raw.files_touched) ? raw.files_touched : [];
  const files_touched = files
    .map((file) => String(file || "").trim())
    .filter(Boolean)
    .slice(0, 20);
  if (!content) return null;
  return { type, title, content, files_touched };
}

async function extractFromSession(session, { force = false } = {}) {
  const sessionRef = session.id;
  if (!force) {
    const existing = await db.query("SELECT id FROM extraction_log WHERE session_ref = $1", [sessionRef]);
    if (existing.rows.length) return { sessionId: sessionRef, skipped: true, inserted: 0, projectId: null };
  }

  const project = await projects.getOrCreateProject(session.cwd);
  if (!project) return { sessionId: sessionRef, skipped: true, inserted: 0, projectId: null };

  const messages = await db.query(
    "SELECT role, content FROM messages WHERE session_ref = $1 ORDER BY inserted_at ASC, id ASC",
    [sessionRef]
  );
  if (!messages.rows.length) return { sessionId: sessionRef, skipped: true, inserted: 0, projectId: project.id };

  const chunks = chunkTranscript(messages.rows);
  const artifacts = [];
  let model = process.env.ANTHROPIC_MODEL || process.env.OPENAI_MODEL || "llm";

  for (const chunk of chunks) {
    try {
      const result = await llm.chat(artifactPrompt(chunk), {
        system: SYSTEM_PROMPT,
        json: true,
        maxTokens: 1500,
      });
      if (result.model) model = result.model;
      const parsed = llm.parseJsonLoose(result.text);
      const rows = parsed && Array.isArray(parsed.artifacts) ? parsed.artifacts : [];
      for (const row of rows.slice(0, MAX_ARTIFACTS_PER_CHUNK)) {
        const artifact = cleanArtifact(row);
        if (artifact) artifacts.push(artifact);
      }
    } catch (err) {
      console.error(`Extraction chunk failed for session ${sessionRef}:`, err.message);
    }
  }

  const byHash = new Map();
  for (const artifact of artifacts) {
    const contentHash = sha256(`${project.id}|${artifact.type}|${artifact.content.trim().toLowerCase()}`);
    if (!byHash.has(contentHash)) byHash.set(contentHash, { ...artifact, content_hash: contentHash });
  }
  const deduped = Array.from(byHash.values());

  let vectors = null;
  if (deduped.length && embeddings.embeddingsEnabled()) {
    try {
      vectors = await embeddings.embed(deduped.map((a) => `[${a.type}] ${a.title}\n${a.content}`));
    } catch (err) {
      console.error("Artifact embedding failed; continuing without vectors:", err.message);
      vectors = null;
    }
  }

  const client = await db.connect();
  let inserted = 0;
  try {
    await client.query("BEGIN");
    for (let i = 0; i < deduped.length; i += 1) {
      const artifact = deduped[i];
      const vector = vectors && vectors[i] ? embeddings.toVectorLiteral(vectors[i]) : null;
      const result = await client.query(
        `INSERT INTO artifacts(project_id, session_ref, type, title, content, files_touched, embedding, content_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7::vector,$8)
         ON CONFLICT(project_id, content_hash) DO NOTHING
         RETURNING id`,
        [
          project.id,
          sessionRef,
          artifact.type,
          artifact.title,
          artifact.content,
          JSON.stringify(artifact.files_touched),
          vector,
          artifact.content_hash,
        ]
      );
      inserted += result.rowCount;
    }
    await client.query(
      `INSERT INTO extraction_log(session_ref, project_id, artifact_count, model, extracted_at)
       VALUES($1,$2,$3,$4,NOW())
       ON CONFLICT(session_ref) DO UPDATE SET
         project_id = EXCLUDED.project_id,
         artifact_count = EXCLUDED.artifact_count,
         model = EXCLUDED.model,
         extracted_at = NOW()`,
      [sessionRef, project.id, inserted, model]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return { sessionId: sessionRef, skipped: false, inserted, projectId: project.id };
}

async function regenerateProjectSummary(projectId) {
  const rows = await db.query(
    `SELECT type, title, content, files_touched
     FROM artifacts
     WHERE project_id = $1
     ORDER BY CASE type
       WHEN 'decision' THEN 1
       WHEN 'convention' THEN 2
       WHEN 'fact' THEN 3
       WHEN 'solved_problem' THEN 4
       WHEN 'gotcha' THEN 5
       WHEN 'todo' THEN 6
       ELSE 9
     END, created_at DESC
     LIMIT 60`,
    [projectId]
  );
  if (!rows.rows.length) return null;

  const digest = rows.rows.map((row) => {
    const title = row.title ? `${row.title}: ` : "";
    const files = Array.isArray(row.files_touched) && row.files_touched.length
      ? ` (${row.files_touched.slice(0, 5).join(", ")})`
      : "";
    return `- [${row.type}] ${title}${row.content}${files}`;
  }).join("\n");
  const prompt = [
    "Create a concise project context card in markdown bullets, at most 200 words.",
    "Focus on durable decisions, conventions, facts, solved problems, gotchas, and todos.",
    "",
    digest,
  ].join("\n");
  const result = await llm.chat(prompt, { maxTokens: 500 });
  const summary = String(result.text || "").trim();
  if (!summary) throw new Error("LLM returned an empty project summary");
  await db.query(
    "UPDATE projects SET summary = $1, summary_updated_at = NOW() WHERE id = $2",
    [summary, projectId]
  );
  return { projectId, summary, model: result.model };
}

async function extractAll({ force = false, sessionId = null } = {}) {
  if (!llm.llmEnabled()) throw new Error("No LLM provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.");
  let rows;
  if (sessionId) {
    rows = await db.query("SELECT * FROM sessions WHERE id = $1", [sessionId]);
  } else if (force) {
    rows = await db.query("SELECT * FROM sessions ORDER BY updated_at DESC");
  } else {
    rows = await db.query(
      `SELECT s.*
       FROM sessions s
       LEFT JOIN extraction_log e ON e.session_ref = s.id
       WHERE e.id IS NULL
       ORDER BY s.updated_at DESC`
    );
  }

  let processed = 0;
  let totalInserted = 0;
  const touched = new Set();
  const errors = [];
  for (const session of rows.rows) {
    try {
      const result = await extractFromSession(session, { force });
      processed += 1;
      totalInserted += result.inserted || 0;
      if (result.projectId) touched.add(result.projectId);
    } catch (err) {
      errors.push({ sessionId: session.id, error: err.message });
      console.error(`Extraction failed for session ${session.id}:`, err.message);
    }
  }

  for (const projectId of touched) {
    try {
      await regenerateProjectSummary(projectId);
    } catch (err) {
      errors.push({ projectId, error: err.message });
      console.error(`Project summary failed for ${projectId}:`, err.message);
    }
  }

  return {
    processed,
    totalInserted,
    projects: Array.from(touched),
    errors,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const sessionIndex = args.indexOf("--session");
  const sessionId = sessionIndex >= 0 ? parseInt(args[sessionIndex + 1], 10) : null;
  const result = await extractAll({ force, sessionId });
  console.log(JSON.stringify(result, null, 2));
  await db.end();
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error(err.message);
    await db.end();
    process.exit(1);
  });
}

module.exports = {
  extractAll,
  extractFromSession,
  regenerateProjectSummary,
};
