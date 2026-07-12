CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  session_id TEXT UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  cwd TEXT DEFAULT '',
  tags TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  message_count INTEGER DEFAULT 0,
  summary TEXT DEFAULT '',
  summary_updated_at TIMESTAMPTZ,
  source_hash TEXT,
  last_extracted_hash TEXT,
  last_extracted_at TIMESTAMPTZ
);

ALTER TABLE IF EXISTS sessions ADD COLUMN IF NOT EXISTS source_hash TEXT;
ALTER TABLE IF EXISTS sessions ADD COLUMN IF NOT EXISTS last_extracted_hash TEXT;
ALTER TABLE IF EXISTS sessions ADD COLUMN IF NOT EXISTS last_extracted_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  session_ref INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content TEXT NOT NULL,
  has_code BOOLEAN DEFAULT FALSE,
  has_command BOOLEAN DEFAULT FALSE,
  captured_at TIMESTAMPTZ,
  inserted_at TIMESTAMPTZ DEFAULT NOW(),
  seq INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS messages_session_ref_seq_idx ON messages(session_ref, seq);
CREATE INDEX IF NOT EXISTS messages_session_ref_idx ON messages(session_ref);
CREATE INDEX IF NOT EXISTS messages_role_idx ON messages(role);

CREATE TABLE IF NOT EXISTS bookmarks (
  id SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  session_ref INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  note TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bookmarks_session_ref_idx ON bookmarks(session_ref);

CREATE TABLE IF NOT EXISTS repos (
  id SERIAL PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  merkle_root TEXT DEFAULT '',
  file_count INTEGER DEFAULT 0,
  last_indexed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS repo_files (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  hash TEXT NOT NULL,
  lang TEXT DEFAULT '',
  size_bytes INTEGER DEFAULT 0,
  symbols JSONB DEFAULT '[]',
  imports JSONB DEFAULT '[]',
  summary TEXT DEFAULT '',
  learned TEXT DEFAULT '',
  mention_count INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(repo_id, rel_path)
);

CREATE INDEX IF NOT EXISTS repo_files_repo_id_idx ON repo_files(repo_id);

CREATE TABLE IF NOT EXISTS file_mentions (
  id SERIAL PRIMARY KEY,
  repo_file_id INTEGER NOT NULL REFERENCES repo_files(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  session_ref INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT DEFAULT '',
  excerpt TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(repo_file_id, message_id)
);

CREATE INDEX IF NOT EXISTS file_mentions_repo_file_id_idx ON file_mentions(repo_file_id);
CREATE INDEX IF NOT EXISTS file_mentions_session_ref_idx ON file_mentions(session_ref);

CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  root_path TEXT DEFAULT '',
  git_remote TEXT DEFAULT '',
  summary TEXT DEFAULT '',
  summary_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS artifacts (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_ref INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  title TEXT DEFAULT '',
  content TEXT NOT NULL,
  files_touched JSONB DEFAULT '[]',
  embedding VECTOR(1536),
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, content_hash)
);

CREATE INDEX IF NOT EXISTS artifacts_project_id_idx ON artifacts(project_id);
CREATE INDEX IF NOT EXISTS artifacts_type_idx ON artifacts(type);
CREATE INDEX IF NOT EXISTS artifacts_embedding_hnsw_idx ON artifacts USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS extraction_log (
  id SERIAL PRIMARY KEY,
  session_ref INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  artifact_count INTEGER DEFAULT 0,
  model TEXT DEFAULT '',
  extracted_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(session_ref)
);

CREATE TABLE IF NOT EXISTS memory_recall_log (
  id SERIAL PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  query TEXT NOT NULL DEFAULT '',
  files JSONB NOT NULL DEFAULT '[]',
  error_text TEXT NOT NULL DEFAULT '',
  artifact_ids JSONB NOT NULL DEFAULT '[]',
  memory_used BOOLEAN NOT NULL DEFAULT FALSE,
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
