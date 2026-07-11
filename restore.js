require("dotenv").config({ path: __dirname + "/.env" });

const fs = require("fs/promises");
const path = require("path");
const db = require("./db");

async function restoreFile(client, filePath) {
  const data = JSON.parse(await fs.readFile(filePath, "utf8"));
  const session = data.session || {};
  let sessionRef;

  if (session.session_id) {
    const row = await client.query(
      `INSERT INTO sessions(session_id, name, cwd, tags, notes, created_at, updated_at, message_count, summary, summary_updated_at, source_hash)
       VALUES($1,$2,$3,$4,$5,COALESCE($6,NOW()),COALESCE($7,NOW()),$8,$9,$10,$11)
       ON CONFLICT(session_id) DO UPDATE SET
         name = EXCLUDED.name,
         cwd = EXCLUDED.cwd,
         tags = EXCLUDED.tags,
         notes = EXCLUDED.notes,
         updated_at = EXCLUDED.updated_at,
         message_count = EXCLUDED.message_count,
         summary = EXCLUDED.summary,
         summary_updated_at = EXCLUDED.summary_updated_at,
         source_hash = EXCLUDED.source_hash
       RETURNING id`,
      [
        session.session_id,
        session.name || "",
        session.cwd || "",
        session.tags || "",
        session.notes || "",
        session.created_at || null,
        session.updated_at || null,
        session.message_count || 0,
        session.summary || "",
        session.summary_updated_at || null,
        session.source_hash || null,
      ]
    );
    sessionRef = row.rows[0].id;
  } else {
    const row = await client.query(
      `INSERT INTO sessions(name, cwd, tags, notes, created_at, updated_at, message_count, summary, summary_updated_at, source_hash)
       VALUES($1,$2,$3,$4,COALESCE($5,NOW()),COALESCE($6,NOW()),$7,$8,$9,$10)
       RETURNING id`,
      [
        session.name || "",
        session.cwd || "",
        session.tags || "",
        session.notes || "",
        session.created_at || null,
        session.updated_at || null,
        session.message_count || 0,
        session.summary || "",
        session.summary_updated_at || null,
        session.source_hash || null,
      ]
    );
    sessionRef = row.rows[0].id;
  }

  await client.query("DELETE FROM messages WHERE session_ref = $1", [sessionRef]);
  const idMap = new Map();
  for (const message of data.messages || []) {
    const row = await client.query(
      `INSERT INTO messages(session_ref, role, content, has_code, has_command, captured_at, inserted_at, seq)
       VALUES($1,$2,$3,$4,$5,$6,COALESCE($7,NOW()),$8)
       RETURNING id`,
      [
        sessionRef,
        message.role,
        message.content || "",
        !!message.has_code,
        !!message.has_command,
        message.captured_at || null,
        message.inserted_at || null,
        message.seq || null,
      ]
    );
    idMap.set(message.id, row.rows[0].id);
  }

  for (const bookmark of data.bookmarks || []) {
    const newMessageId = idMap.get(bookmark.message_id);
    if (!newMessageId) continue;
    await client.query(
      `INSERT INTO bookmarks(message_id, session_ref, note, created_at)
       VALUES($1,$2,$3,COALESCE($4,NOW()))`,
      [newMessageId, sessionRef, bookmark.note || "", bookmark.created_at || null]
    );
  }
}

async function restore() {
  const sessionsDir = path.join(__dirname, "backups", "sessions");
  const files = await fs.readdir(sessionsDir);
  let restored = 0;
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await restoreFile(client, path.join(sessionsDir, file));
      await client.query("COMMIT");
      restored += 1;
      console.log(`ok ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`ERROR ${file}: ${err.message}`);
    } finally {
      client.release();
    }
  }
  return restored;
}

if (require.main === module) {
  restore().then(async (count) => {
    console.log(`Restored ${count} session file(s).`);
    await db.end();
  }).catch(async (err) => {
    console.error(err.message);
    await db.end();
    process.exit(1);
  });
}

module.exports = restore;
