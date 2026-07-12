require("dotenv").config({ path: __dirname + "/.env" });

const db = require("./db");
const projects = require("./projects");
const embeddings = require("./embeddings");
const recallScoring = require("./recall_scoring");

const TYPE_ORDER = ["decision", "convention", "gotcha", "fact", "solved_problem", "todo"];
const RECALL_TYPES = ["solved_problem", "gotcha", "decision", "convention", "fact"];

async function resolveProject(cwdOrKey) {
  if (!cwdOrKey) return null;
  const found = await projects.findProject(cwdOrKey);
  if (found) return found;
  const result = await db.query(
    "SELECT * FROM projects WHERE key = $1 OR name = $1 OR root_path = $1 LIMIT 1",
    [cwdOrKey]
  );
  return result.rows[0] || null;
}

async function getProjectSummary(cwdOrKey) {
  const project = await resolveProject(cwdOrKey);
  if (!project) return null;
  const counts = await db.query("SELECT COUNT(*)::int AS count FROM artifacts WHERE project_id = $1", [project.id]);
  return {
    project: {
      id: project.id,
      name: project.name,
      key: project.key,
      root_path: project.root_path,
    },
    summary: project.summary || "",
    summary_updated_at: project.summary_updated_at,
    artifact_count: counts.rows[0] ? counts.rows[0].count : 0,
  };
}

function typeClause(types, startIndex) {
  if (!types || !types.length) return { sql: "", params: [] };
  return { sql: ` AND type = ANY($${startIndex})`, params: [types] };
}

async function searchMemory(cwdOrKey, query, k = 8, types = null) {
  const project = await resolveProject(cwdOrKey);
  const limit = Math.max(1, Math.min(parseInt(k || 8, 10), 50));
  const normalizedTypes = Array.isArray(types) && types.length ? types : null;
  if (!project) {
    return { mode: "none", project: null, artifacts: [], error: "Project not found" };
  }

  if (embeddings.embeddingsEnabled()) {
    try {
      const vector = await embeddings.embedOne(query);
      if (vector) {
        const type = typeClause(normalizedTypes, 4);
        const rows = await db.query(
          `SELECT id, type, title, content, files_touched, created_at,
                  1 - (embedding <=> $2::vector) AS score
           FROM artifacts
           WHERE project_id = $1 AND embedding IS NOT NULL${type.sql}
           ORDER BY embedding <=> $2::vector
           LIMIT $3`,
          [project.id, embeddings.toVectorLiteral(vector), limit, ...type.params]
        );
        if (rows.rows.length) {
          return {
            mode: "vector",
            project: { id: project.id, name: project.name, key: project.key, root_path: project.root_path },
            artifacts: rows.rows,
          };
        }
      }
    } catch (err) {
      console.error("Vector memory search failed, falling back to keyword:", err.message);
    }
  }

  const type = typeClause(normalizedTypes, 4);
  const rows = await db.query(
    `SELECT id, type, title, content, files_touched, created_at, NULL::float AS score
     FROM artifacts
     WHERE project_id = $1
       AND (title ILIKE $2 OR content ILIKE $2)${type.sql}
     ORDER BY created_at DESC
     LIMIT $3`,
    [project.id, `%${query}%`, limit, ...type.params]
  );
  return {
    mode: "keyword",
    project: { id: project.id, name: project.name, key: project.key, root_path: project.root_path },
    artifacts: rows.rows,
  };
}

async function buildContextBlock(cwdOrKey, { maxArtifacts = 12 } = {}) {
  const project = await resolveProject(cwdOrKey);
  if (!project) return null;
  const limit = Math.max(1, Math.min(parseInt(maxArtifacts || 12, 10), 40));
  const rows = await db.query(
    `SELECT type, title, content, files_touched, created_at
     FROM artifacts
     WHERE project_id = $1
     ORDER BY CASE type
       WHEN 'decision' THEN 1
       WHEN 'convention' THEN 2
       WHEN 'gotcha' THEN 3
       WHEN 'fact' THEN 4
       WHEN 'solved_problem' THEN 5
       WHEN 'todo' THEN 6
       ELSE 9
     END, created_at DESC
     LIMIT $2`,
    [project.id, limit]
  );

  const lines = [`# Project memory - ${project.name || project.key}`];
  if (project.summary) {
    lines.push("", project.summary.trim());
  }
  if (rows.rows.length) {
    lines.push("", "## Key artifacts");
    for (const row of rows.rows) {
      const files = Array.isArray(row.files_touched) && row.files_touched.length
        ? ` [${row.files_touched.slice(0, 5).join(", ")}]`
        : "";
      const title = row.title ? ` - ${row.title}:` : "";
      lines.push(`- **${row.type}**${title} ${row.content}${files}`);
    }
  }
  lines.push("", "Use the project memory search tool for more context when needed.");
  return {
    project: { id: project.id, name: project.name },
    text: lines.join("\n"),
    artifact_count: rows.rows.length,
  };
}

async function fetchVectorRecallCandidates(projectId, combinedQuery, allowedTypes, limit) {
  if (!embeddings.embeddingsEnabled()) return { rows: [], used: false };
  try {
    const vector = await embeddings.embedOne(combinedQuery);
    if (!vector) return { rows: [], used: false };
    const rows = await db.query(
      `SELECT id, type, title, content, files_touched, created_at,
              1 - (embedding <=> $2::vector) AS vector_score
       FROM artifacts
       WHERE project_id = $1
         AND embedding IS NOT NULL
         AND type = ANY($4)
       ORDER BY embedding <=> $2::vector
       LIMIT $3`,
      [projectId, embeddings.toVectorLiteral(vector), limit, allowedTypes]
    );
    return { rows: rows.rows, used: true };
  } catch (err) {
    console.error("Task recall vector search failed:", err.message);
    return { rows: [], used: false };
  }
}

async function fetchKeywordRecallCandidates(projectId, combinedQuery, files, allowedTypes, limit) {
  const terms = recallScoring.tokenize(`${combinedQuery}\n${(files || []).join("\n")}`)
    .map((term) => term.slice(0, 120))
    .filter(Boolean)
    .slice(0, 20);
  if (!terms.length) return [];

  const params = [projectId, allowedTypes, limit];
  const clauses = [];
  for (const term of terms) {
    params.push(`%${term}%`);
    const idx = params.length;
    clauses.push(`(title ILIKE $${idx} OR content ILIKE $${idx} OR files_touched::text ILIKE $${idx})`);
  }
  const rows = await db.query(
    `SELECT id, type, title, content, files_touched, created_at, NULL::float AS vector_score
     FROM artifacts
     WHERE project_id = $1
       AND type = ANY($2)
       AND (${clauses.join(" OR ")})
     ORDER BY created_at DESC
     LIMIT $3`,
    params
  );
  return rows.rows;
}

function redactSensitive(text) {
  return String(text || "")
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/g, "[redacted-api-key]")
    .replace(/\b([A-Za-z0-9_]*?(?:api[_-]?key|token|password|passwd|secret)[A-Za-z0-9_]*?\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s,;]+)/gi, "$1[redacted]")
    .replace(/\b(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted]");
}

async function logMemoryRecall(project, input, result) {
  try {
    await db.query(
      `INSERT INTO memory_recall_log(project_id, query, files, error_text, artifact_ids, memory_used, estimated_tokens, mode)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        project ? project.id : null,
        redactSensitive(input.query).slice(0, 6000),
        JSON.stringify((input.files || []).slice(0, 30)),
        redactSensitive(input.error).slice(0, 6000),
        JSON.stringify((result.memories || []).map((memory) => memory.id).filter((id) => id != null)),
        !!result.memoryUsed,
        result.estimatedTokens || 0,
        result.mode || "",
      ]
    );
  } catch (err) {
    console.error("Could not write memory recall telemetry:", err.message);
  }
}

async function recallTaskContext({
  project,
  query = "",
  files = [],
  error = "",
  branch = "",
  commit = "",
  maxTokens = 700,
  maxArtifacts = 5,
} = {}) {
  const resolved = await resolveProject(project);
  const input = {
    query,
    files: Array.isArray(files) ? files : [],
    error,
    branch,
    commit,
  };
  if (!resolved) {
    const missing = {
      memoryUsed: false,
      project: null,
      context: "",
      memories: [],
      estimatedTokens: 0,
      mode: "none",
      error: "Project not found",
    };
    await logMemoryRecall(null, input, missing);
    return missing;
  }

  const combinedQuery = recallScoring.buildCombinedQuery(input);
  const includeTodos = recallScoring.wantsTodos(`${query}\n${error}`);
  const allowedTypes = includeTodos ? [...RECALL_TYPES, "todo"] : RECALL_TYPES;
  const limit = Math.max(40, Math.min(120, recallScoring.clampInt(maxArtifacts, 1, 12, 5) * 10));

  const vector = await fetchVectorRecallCandidates(resolved.id, combinedQuery, allowedTypes, limit);
  const keywordRows = await fetchKeywordRecallCandidates(resolved.id, combinedQuery, input.files, allowedTypes, limit);
  const modeParts = [];
  if (vector.used) modeParts.push("vector");
  if (keywordRows.length) modeParts.push("keyword");
  const mode = modeParts.join("+") || "none";

  const selected = recallScoring.selectRecallArtifacts([...vector.rows, ...keywordRows], input, {
    maxArtifacts: recallScoring.clampInt(maxArtifacts, 1, 12, 5),
  });
  const rendered = recallScoring.buildRecallContext(selected, {
    maxTokens: recallScoring.clampInt(maxTokens, 100, 2000, 700),
  });
  const memories = rendered.memories.map((memory) => ({
    id: memory.id,
    type: memory.type,
    title: memory.title || "",
    content: memory.content || "",
    files_touched: Array.isArray(memory.files_touched) ? memory.files_touched : [],
    score: memory.score,
  }));
  const result = {
    memoryUsed: !!rendered.context,
    project: {
      id: resolved.id,
      name: resolved.name,
      key: resolved.key,
      root_path: resolved.root_path,
    },
    context: rendered.context,
    memories,
    estimatedTokens: rendered.estimatedTokens,
    mode,
  };
  if (!result.memoryUsed) {
    result.context = "";
    result.memories = [];
    result.estimatedTokens = 0;
  }
  await logMemoryRecall(resolved, input, result);
  return result;
}

module.exports = {
  getProjectSummary,
  searchMemory,
  buildContextBlock,
  resolveProject,
  recallTaskContext,
  logMemoryRecall,
  redactSensitive,
};
