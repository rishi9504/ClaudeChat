require("dotenv").config({ path: __dirname + "/.env" });

const fs = require("fs/promises");
const path = require("path");
const db = require("./db");

function safeFileName(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 160) || "session";
}

async function backup() {
  const root = path.join(__dirname, "backups");
  const sessionsDir = path.join(root, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });

  const sessions = await db.query("SELECT * FROM sessions ORDER BY id ASC");
  const manifest = {
    exported_at: new Date().toISOString(),
    session_count: sessions.rows.length,
    sessions: [],
    total_messages: 0,
  };

  for (const session of sessions.rows) {
    const messages = await db.query(
      "SELECT * FROM messages WHERE session_ref = $1 ORDER BY inserted_at ASC, id ASC",
      [session.id]
    );
    const bookmarks = await db.query(
      "SELECT * FROM bookmarks WHERE session_ref = $1 ORDER BY created_at ASC, id ASC",
      [session.id]
    );
    const fileBase = session.session_id ? safeFileName(session.session_id) : `id-${session.id}`;
    const file = `${fileBase}.json`;
    await fs.writeFile(
      path.join(sessionsDir, file),
      JSON.stringify({ session, messages: messages.rows, bookmarks: bookmarks.rows }, null, 2)
    );
    manifest.sessions.push({
      file,
      id: session.id,
      session_id: session.session_id,
      name: session.name,
      message_count: messages.rows.length,
      bookmark_count: bookmarks.rows.length,
    });
    manifest.total_messages += messages.rows.length;
  }

  await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2));

  if (process.env.BACKUP_S3_BUCKET) {
    // S3 upload intentionally left as a future extension point.
  }

  return manifest;
}

async function main() {
  const manifest = await backup();
  console.log(`Backed up ${manifest.session_count} sessions and ${manifest.total_messages} messages.`);
  await db.end();
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error(err.message);
    await db.end();
    process.exit(1);
  });
}

module.exports = backup;
