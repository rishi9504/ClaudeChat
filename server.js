require("dotenv").config({ path: __dirname + "/.env" });

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const express = require("express");
const db = require("./db");
const manifest = require("./manifest");
const enrich = require("./enrich");
const retrieve = require("./retrieve");
const extract = require("./extract");
const sessionSummary = require("./session_summary");

const app = express();
const PORT = 3737;
let syncRunning = false;

app.use(express.json({ limit: "25mb" }));
app.use(express.static(__dirname));

function asyncRoute(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error(err);
      res.status(500).json({ error: err.message });
    });
  };
}

function detectHasCode(content) {
  return /```/.test(String(content || ""));
}

function detectHasCommand(content) {
  const value = String(content || "");
  return /^\s*[$>]\s/m.test(value) || /`[^`]+`/.test(value);
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function runSyncJob() {
  if (syncRunning) return { skipped: true };
  syncRunning = true;
  try {
    await runProcess("python3", ["bulk_import.py"]);
    await runProcess("node", ["backup.js"]);
    return { ok: true };
  } finally {
    syncRunning = false;
  }
}

const syncIntervalMinutes = parseInt(process.env.SYNC_INTERVAL_MINUTES || "60", 10);
if (syncIntervalMinutes > 0) {
  setTimeout(() => {
    runSyncJob().catch((err) => console.error("Auto-sync failed:", err.message));
  }, 5000);
  setInterval(() => {
    runSyncJob().catch((err) => console.error("Auto-sync failed:", err.message));
  }, syncIntervalMinutes * 60 * 1000);
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "viewer.html"));
});

app.get("/api/sessions", asyncRoute(async (req, res) => {
  const rows = await db.query(
    `SELECT s.*, COUNT(m.id)::int AS message_count, MAX(m.inserted_at) AS last_message
     FROM sessions s
     LEFT JOIN messages m ON m.session_ref = s.id
     GROUP BY s.id
     ORDER BY s.updated_at DESC`
  );
  res.json(rows.rows);
}));

app.post("/api/sessions", asyncRoute(async (req, res) => {
  const { name, tags = "", notes = "" } = req.body || {};
  if (!String(name || "").trim()) return res.status(400).json({ error: "name is required" });
  const row = await db.query(
    "INSERT INTO sessions(name, tags, notes) VALUES($1,$2,$3) RETURNING *",
    [String(name).trim(), tags, notes]
  );
  res.json(row.rows[0]);
}));

app.put("/api/sessions/:id", asyncRoute(async (req, res) => {
  const row = await db.query(
    `UPDATE sessions
     SET name = COALESCE($1, name),
         tags = COALESCE($2, tags),
         notes = COALESCE($3, notes),
         updated_at = NOW()
     WHERE id = $4
     RETURNING *`,
    [req.body.name ?? null, req.body.tags ?? null, req.body.notes ?? null, req.params.id]
  );
  if (!row.rows.length) return res.status(404).json({ error: "Session not found" });
  res.json(row.rows[0]);
}));

app.delete("/api/sessions/:id", asyncRoute(async (req, res) => {
  await db.query("DELETE FROM sessions WHERE id = $1", [req.params.id]);
  res.json({ success: true });
}));

app.get("/api/sessions/:id/messages", asyncRoute(async (req, res) => {
  const rows = await db.query(
    `SELECT m.id, s.session_id, m.role, m.content, m.has_code, m.has_command,
            COALESCE(m.captured_at, m.inserted_at) AS timestamp,
            (b.id IS NOT NULL) AS is_bookmarked,
            b.note AS bookmark_note,
            b.id AS bookmark_id
     FROM messages m
     JOIN sessions s ON s.id = m.session_ref
     LEFT JOIN LATERAL (
       SELECT * FROM bookmarks b
       WHERE b.message_id = m.id
       ORDER BY b.created_at DESC, b.id DESC
       LIMIT 1
     ) b ON true
     WHERE m.session_ref = $1
     ORDER BY m.inserted_at ASC, m.id ASC`,
    [req.params.id]
  );
  res.json(rows.rows);
}));

app.post("/api/sessions/:id/messages", asyncRoute(async (req, res) => {
  const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const message of messages) {
      await client.query(
        `INSERT INTO messages(session_ref, role, content, has_code, has_command)
         VALUES($1,$2,$3,$4,$5)`,
        [
          req.params.id,
          message.role || "user",
          message.content || "",
          detectHasCode(message.content),
          detectHasCommand(message.content),
        ]
      );
    }
    await client.query(
      `UPDATE sessions
       SET updated_at = NOW(),
           message_count = (SELECT COUNT(*) FROM messages WHERE session_ref = $1)
       WHERE id = $1`,
      [req.params.id]
    );
    await client.query("COMMIT");
    res.json({ success: true, count: messages.length });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}));

app.get("/api/sessions/:id/summary", asyncRoute(async (req, res) => {
  const row = await sessionSummary.getStoredSummary(req.params.id);
  if (!row) return res.status(404).json({ error: "Session not found" });
  res.json(row);
}));

app.post("/api/sessions/:id/summary", asyncRoute(async (req, res) => {
  const force = !!(req.body && req.body.force);
  const stored = await sessionSummary.getStoredSummary(req.params.id);
  if (!stored) return res.status(404).json({ error: "Session not found" });
  if (stored.summary && !force) return res.json(stored);
  try {
    const result = await sessionSummary.generateSessionSummary(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.post("/api/import", asyncRoute(async (req, res) => {
  const { sessionName, conversation, tags = "" } = req.body || {};
  if (!String(sessionName || "").trim()) return res.status(400).json({ error: "sessionName is required" });
  if (!Array.isArray(conversation)) return res.status(400).json({ error: "conversation must be an array" });
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const session = await client.query(
      "INSERT INTO sessions(name, tags, message_count) VALUES($1,$2,$3) RETURNING *",
      [sessionName.trim(), tags, conversation.length]
    );
    for (const message of conversation) {
      const content = message.content || "";
      await client.query(
        `INSERT INTO messages(session_ref, role, content, has_code, has_command)
         VALUES($1,$2,$3,$4,$5)`,
        [
          session.rows[0].id,
          message.role || "user",
          content,
          detectHasCode(content),
          /`[^`]+`/.test(String(content)),
        ]
      );
    }
    await client.query("COMMIT");
    res.json({ session: session.rows[0], count: conversation.length });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}));

app.post("/api/bookmarks", asyncRoute(async (req, res) => {
  const { messageId, sessionId, note = "" } = req.body || {};
  const row = await db.query(
    "INSERT INTO bookmarks(message_id, session_ref, note) VALUES($1,$2,$3) RETURNING id",
    [messageId, sessionId, note]
  );
  res.json({ id: row.rows[0].id });
}));

app.delete("/api/bookmarks/:id", asyncRoute(async (req, res) => {
  await db.query("DELETE FROM bookmarks WHERE id = $1", [req.params.id]);
  res.json({ success: true });
}));

app.get("/api/bookmarks", asyncRoute(async (req, res) => {
  const rows = await db.query(
    `SELECT b.*, m.role, m.content, s.name AS session_name
     FROM bookmarks b
     JOIN messages m ON m.id = b.message_id
     JOIN sessions s ON s.id = b.session_ref
     ORDER BY b.created_at DESC`
  );
  res.json(rows.rows);
}));

app.get("/api/search", asyncRoute(async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json([]);
  const params = [`%${q}%`];
  let scope = "";
  if (req.query.sessionId) {
    params.push(req.query.sessionId);
    scope = ` AND m.session_ref = $${params.length}`;
  }
  const rows = await db.query(
    `SELECT m.*, s.name AS session_name
     FROM messages m
     JOIN sessions s ON s.id = m.session_ref
     WHERE m.content ILIKE $1${scope}
     ORDER BY m.inserted_at DESC
     LIMIT 50`,
    params
  );
  res.json(rows.rows);
}));

app.get("/api/sessions/:id/export", asyncRoute(async (req, res) => {
  const session = await db.query("SELECT * FROM sessions WHERE id = $1", [req.params.id]);
  if (!session.rows.length) return res.status(404).json({ error: "Session not found" });
  const messages = await db.query(
    "SELECT * FROM messages WHERE session_ref = $1 ORDER BY inserted_at ASC, id ASC",
    [req.params.id]
  );
  res.json({ session: session.rows[0], messages: messages.rows });
}));

app.get("/api/repos", asyncRoute(async (req, res) => {
  const rows = await db.query("SELECT * FROM repos ORDER BY last_indexed_at DESC NULLS LAST, name ASC");
  res.json(rows.rows);
}));

function discoverRepos(base) {
  const skip = new Set(["node_modules", ".git", "Library", ".Trash", ".npm", ".cache", "go", ".cargo"]);
  const repos = [];
  const stack = [{ dir: base, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    if (entries.some((entry) => entry.isDirectory() && entry.name === ".git")) {
      repos.push({ path: dir, name: path.basename(dir) });
      continue;
    }
    if (depth >= 3) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (skip.has(entry.name) || (entry.name.startsWith(".") && entry.name !== ".")) continue;
      stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return repos.sort((a, b) => a.path.localeCompare(b.path));
}

app.get("/api/repos/discover", asyncRoute(async (req, res) => {
  const base = req.query.base ? path.resolve(String(req.query.base)) : os.homedir();
  if (!base || !fs.existsSync(base)) return res.status(400).json({ error: "base path missing or not found" });
  res.json({ base, repos: discoverRepos(base) });
}));

app.post("/api/repos/index", asyncRoute(async (req, res) => {
  const repoPath = req.body && req.body.path;
  if (!repoPath || !fs.existsSync(repoPath)) return res.status(400).json({ error: "path is required and must exist" });
  const result = await manifest.buildManifest(repoPath);
  const enriched = await enrich.enrichRepo(result.repoId);
  res.json({ ...result, ...enriched });
}));

app.get("/api/repos/:id/files", asyncRoute(async (req, res) => {
  const rows = await db.query(
    `SELECT id, repo_id, rel_path, hash, lang, size_bytes, summary, learned, mention_count, updated_at,
            jsonb_array_length(symbols) AS symbol_count,
            jsonb_array_length(imports) AS import_count
     FROM repo_files
     WHERE repo_id = $1
     ORDER BY rel_path ASC`,
    [req.params.id]
  );
  res.json(rows.rows);
}));

app.get("/api/repos/:id/files/:fileId", asyncRoute(async (req, res) => {
  const file = await db.query(
    "SELECT * FROM repo_files WHERE repo_id = $1 AND id = $2",
    [req.params.id, req.params.fileId]
  );
  if (!file.rows.length) return res.status(404).json({ error: "File not found" });
  const mentions = await db.query(
    `SELECT fm.*, s.name AS session_name, m.content AS message_content
     FROM file_mentions fm
     LEFT JOIN sessions s ON s.id = fm.session_ref
     LEFT JOIN messages m ON m.id = fm.message_id
     WHERE fm.repo_file_id = $1
     ORDER BY fm.created_at DESC
     LIMIT 25`,
    [req.params.fileId]
  );
  res.json({ file: file.rows[0], mentions: mentions.rows });
}));

app.delete("/api/repos/:id", asyncRoute(async (req, res) => {
  await db.query("DELETE FROM repos WHERE id = $1", [req.params.id]);
  res.json({ success: true });
}));

app.get("/api/projects", asyncRoute(async (req, res) => {
  const rows = await db.query(
    `SELECT p.*, COUNT(a.id)::int AS artifact_count
     FROM projects p
     LEFT JOIN artifacts a ON a.project_id = p.id
     GROUP BY p.id
     ORDER BY artifact_count DESC, p.name ASC`
  );
  res.json(rows.rows);
}));

app.get("/api/projects/:key/summary", asyncRoute(async (req, res) => {
  const summary = await retrieve.getProjectSummary(decodeURIComponent(req.params.key));
  if (!summary) return res.status(404).json({ error: "Project not found" });
  res.json(summary);
}));

app.get("/api/projects/:key/artifacts", asyncRoute(async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  const params = [key];
  let typeFilter = "";
  if (req.query.type) {
    params.push(req.query.type);
    typeFilter = ` AND type = $${params.length}`;
  }
  const rows = await db.query(
    `SELECT a.*
     FROM artifacts a
     JOIN projects p ON p.id = a.project_id
     WHERE (p.key = $1 OR p.name = $1 OR p.root_path = $1)${typeFilter}
     ORDER BY a.created_at DESC
     LIMIT 500`,
    params
  );
  res.json(rows.rows);
}));

app.get("/api/memory/search", asyncRoute(async (req, res) => {
  const project = String(req.query.project || "").trim();
  const q = String(req.query.q || "").trim();
  if (!project || !q) return res.status(400).json({ error: "project and q are required" });
  const types = req.query.type ? String(req.query.type).split(",").map((s) => s.trim()).filter(Boolean) : null;
  const result = await retrieve.searchMemory(project, q, req.query.k || 8, types);
  res.json(result);
}));

app.get("/api/memory/artifacts", asyncRoute(async (req, res) => {
  const projectKey = String(req.query.project || "").trim();
  if (!projectKey) return res.status(400).json({ error: "project is required" });
  const project = await retrieve.resolveProject(projectKey);
  if (!project) return res.status(404).json({ error: "Project not found" });
  const params = [project.id];
  let typeFilter = "";
  if (req.query.type) {
    params.push(req.query.type);
    typeFilter = ` AND type = $${params.length}`;
  }
  const counts = await db.query(
    "SELECT type, COUNT(*)::int AS count FROM artifacts WHERE project_id = $1 GROUP BY type",
    [project.id]
  );
  const rows = await db.query(
    `SELECT *
     FROM artifacts
     WHERE project_id = $1${typeFilter}
     ORDER BY CASE type
       WHEN 'decision' THEN 1
       WHEN 'convention' THEN 2
       WHEN 'fact' THEN 3
       WHEN 'solved_problem' THEN 4
       WHEN 'gotcha' THEN 5
       WHEN 'todo' THEN 6
       ELSE 9
     END, created_at DESC
     LIMIT 1000`,
    params
  );
  const countMap = {};
  for (const row of counts.rows) countMap[row.type] = row.count;
  res.json({ project, counts: countMap, artifacts: rows.rows });
}));

app.get("/api/memory/context", asyncRoute(async (req, res) => {
  const project = String(req.query.project || "").trim();
  if (!project) return res.status(400).json({ error: "project is required" });
  const result = await retrieve.buildContextBlock(project, { maxArtifacts: req.query.max || 12 });
  if (!result) return res.status(404).json({ error: "Project not found" });
  res.json(result);
}));

app.post("/api/memory/extract", asyncRoute(async (req, res) => {
  try {
    const result = await extract.extractAll({
      sessionId: req.body && req.body.sessionId ? parseInt(req.body.sessionId, 10) : null,
      force: !!(req.body && req.body.force),
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.post("/api/projects/:id/summary", asyncRoute(async (req, res) => {
  try {
    const result = await extract.regenerateProjectSummary(req.params.id);
    res.json(result || { summary: "", message: "No artifacts found" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.post("/api/sync", asyncRoute(async (req, res) => {
  const result = await runSyncJob();
  res.json(result);
}));

app.listen(PORT, () => {
  console.log(`claude-chat-history listening on http://localhost:${PORT}`);
});
