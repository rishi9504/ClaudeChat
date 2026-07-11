require("dotenv").config({ path: __dirname + "/.env" });

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const db = require("./db");

function safeGit(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
  } catch (_) {
    return "";
  }
}

function normalizeRemote(url) {
  let value = String(url || "").trim();
  value = value.replace(/^git@/i, "");
  value = value.replace(/^ssh:\/\//i, "");
  value = value.replace(/^https?:\/\//i, "");
  value = value.replace(":", "/");
  value = value.replace(/\.git$/i, "");
  value = value.replace(/\/+$/g, "");
  return value.toLowerCase();
}

function resolveProjectIdentity(cwd) {
  if (!cwd) return null;
  const absolute = path.resolve(String(cwd));
  let rootPath = absolute;
  let gitRemote = "";

  if (fs.existsSync(absolute)) {
    const gitRoot = safeGit(["rev-parse", "--show-toplevel"], absolute);
    rootPath = gitRoot || absolute;
    gitRemote = normalizeRemote(safeGit(["config", "--get", "remote.origin.url"], rootPath));
  }

  const key = gitRemote || path.resolve(rootPath);
  const name = path.basename(rootPath) || key;
  return {
    key,
    name,
    root_path: path.resolve(rootPath),
    git_remote: gitRemote,
  };
}

async function upsertProject(identity) {
  if (!identity) return null;
  const result = await db.query(
    `INSERT INTO projects(key, name, root_path, git_remote)
     VALUES($1,$2,$3,$4)
     ON CONFLICT(key) DO UPDATE SET
       name = COALESCE(NULLIF(EXCLUDED.name,''), projects.name),
       root_path = COALESCE(NULLIF(EXCLUDED.root_path,''), projects.root_path),
       git_remote = COALESCE(NULLIF(EXCLUDED.git_remote,''), projects.git_remote)
     RETURNING *`,
    [identity.key, identity.name || "", identity.root_path || "", identity.git_remote || ""]
  );
  return result.rows[0] || null;
}

async function getOrCreateProject(cwd) {
  return upsertProject(resolveProjectIdentity(cwd));
}

async function findProject(cwd) {
  if (!cwd) return null;
  const identity = resolveProjectIdentity(cwd);
  const key = identity ? identity.key : String(cwd);
  const gitRemote = identity ? identity.git_remote : "";
  const rootPath = identity ? identity.root_path : String(cwd);
  const result = await db.query(
    `SELECT * FROM projects
     WHERE key = $1 OR (git_remote = $2 AND $2 <> '') OR root_path = $3
     LIMIT 1`,
    [key, gitRemote, rootPath]
  );
  return result.rows[0] || null;
}

module.exports = {
  resolveProjectIdentity,
  upsertProject,
  getOrCreateProject,
  findProject,
  normalizeRemote,
};
