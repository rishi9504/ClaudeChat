require("dotenv").config({ path: __dirname + "/.env" });

const path = require("path");
const db = require("./db");

const GENERIC_BASENAMES = new Set([
  "index", "main", "app", "utils", "util", "types", "config", "constants",
  "helpers", "test", "tests", "setup", "init", "__init__", "mod", "lib",
  "server", "client", "db", "schema", "models", "routes", "api",
]);

function termsForFile(relPath) {
  const terms = [relPath];
  const parsed = path.parse(relPath);
  if (parsed.name.length >= 6 && !GENERIC_BASENAMES.has(parsed.name)) terms.push(parsed.name);
  return Array.from(new Set(terms));
}

function excerpt(content, term) {
  const value = String(content || "").replace(/\s+/g, " ");
  const idx = value.toLowerCase().indexOf(String(term).toLowerCase());
  if (idx < 0) return value.slice(0, 360);
  const start = Math.max(0, idx - 160);
  const end = Math.min(value.length, idx + term.length + 200);
  return value.slice(start, end).trim();
}

async function enrichRepo(repoId) {
  const files = await db.query("SELECT id, rel_path FROM repo_files WHERE repo_id = $1 ORDER BY rel_path", [repoId]);
  let mentions = 0;
  let filesEnriched = 0;

  for (const file of files.rows) {
    const found = new Map();
    for (const term of termsForFile(file.rel_path)) {
      const rows = await db.query(
        `SELECT id, session_ref, role, content, inserted_at
         FROM messages
         WHERE content ILIKE $1
         ORDER BY inserted_at DESC
         LIMIT 25`,
        [`%${term}%`]
      );
      for (const row of rows.rows) {
        if (!found.has(row.id)) {
          found.set(row.id, {
            ...row,
            excerpt: excerpt(row.content, term),
          });
        }
      }
    }

    const top = Array.from(found.values()).slice(0, 25);
    for (const hit of top) {
      await db.query(
        `INSERT INTO file_mentions(repo_file_id, message_id, session_ref, role, excerpt)
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(repo_file_id, message_id) DO UPDATE SET
           excerpt = EXCLUDED.excerpt,
           role = EXCLUDED.role,
           session_ref = EXCLUDED.session_ref`,
        [file.id, hit.id, hit.session_ref, hit.role || "", hit.excerpt]
      );
      mentions += 1;
    }

    const learned = top.slice(0, 3).map((hit) => `(${hit.role}) ${hit.excerpt}`).join("\n- ").slice(0, 1500);
    await db.query(
      "UPDATE repo_files SET learned = $1, mention_count = $2, updated_at = NOW() WHERE id = $3",
      [learned, top.length, file.id]
    );
    filesEnriched += 1;
  }

  return { filesEnriched, mentions };
}

module.exports = {
  enrichRepo,
};
