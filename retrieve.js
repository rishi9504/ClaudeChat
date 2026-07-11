require("dotenv").config({ path: __dirname + "/.env" });

const db = require("./db");
const projects = require("./projects");
const embeddings = require("./embeddings");

const TYPE_ORDER = ["decision", "convention", "gotcha", "fact", "solved_problem", "todo"];

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

module.exports = {
  getProjectSummary,
  searchMemory,
  buildContextBlock,
  resolveProject,
};
