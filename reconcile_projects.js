require("dotenv").config({ path: __dirname + "/.env" });

const db = require("./db");
const projects = require("./projects");

async function reconcile() {
  const sessions = await db.query(
    `SELECT DISTINCT s.id, s.cwd
     FROM sessions s
     WHERE s.id IN (
       SELECT session_ref FROM artifacts WHERE session_ref IS NOT NULL
       UNION
       SELECT session_ref FROM extraction_log
     )
     ORDER BY s.id`
  );

  const cwdCache = new Map();
  let sessionsChecked = 0;
  let artifactsMoved = 0;
  let artifactsDeduped = 0;
  let logsMoved = 0;

  for (const session of sessions.rows) {
    if (!session.cwd) continue;
    sessionsChecked += 1;
    let project = cwdCache.get(session.cwd);
    if (!project) {
      project = await projects.getOrCreateProject(session.cwd);
      cwdCache.set(session.cwd, project);
    }
    if (!project) continue;

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const deduped = await client.query(
        `DELETE FROM artifacts a
         WHERE a.session_ref = $1
           AND a.project_id <> $2
           AND EXISTS (
             SELECT 1 FROM artifacts b
             WHERE b.project_id = $2 AND b.content_hash = a.content_hash
           )`,
        [session.id, project.id]
      );
      artifactsDeduped += deduped.rowCount;

      const moved = await client.query(
        "UPDATE artifacts SET project_id = $1 WHERE session_ref = $2 AND project_id <> $1",
        [project.id, session.id]
      );
      artifactsMoved += moved.rowCount;

      const log = await client.query(
        "UPDATE extraction_log SET project_id = $1 WHERE session_ref = $2 AND project_id IS DISTINCT FROM $1",
        [project.id, session.id]
      );
      logsMoved += log.rowCount;
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  const orphaned = await db.query(
    `DELETE FROM projects p
     WHERE NOT EXISTS (SELECT 1 FROM artifacts a WHERE a.project_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM extraction_log e WHERE e.project_id = p.id)
     RETURNING key`
  );

  const summary = await db.query(
    `SELECT p.id, p.key, p.name,
            COUNT(DISTINCT a.id)::int AS artifact_count,
            COUNT(DISTINCT a.session_ref)::int AS session_count
     FROM projects p
     LEFT JOIN artifacts a ON a.project_id = p.id
     GROUP BY p.id
     ORDER BY artifact_count DESC, p.name ASC`
  );

  return {
    sessionsChecked,
    artifactsMoved,
    artifactsDeduped,
    logsMoved,
    orphanedProjects: orphaned.rows.map((row) => row.key),
    projects: summary.rows,
  };
}

if (require.main === module) {
  reconcile().then(async (result) => {
    console.log(JSON.stringify(result, null, 2));
    await db.end();
  }).catch(async (err) => {
    console.error(err.message);
    await db.end();
    process.exit(1);
  });
}

module.exports = reconcile;
