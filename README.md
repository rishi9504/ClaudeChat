# claude-chat-history

Store, search, summarize, and reuse Claude Code conversations from a local Postgres database.

## Architecture

The app has three subsystems:

- Ingest and compact: `capture.py` records Claude Code transcripts during PreCompact, while `bulk_import.py` re-scans `~/.claude/projects/**/*.jsonl`.
- Project memory store: `extract.js` distills durable project knowledge into artifacts, embeds them with OpenAI embeddings when available, and stores them in Postgres with pgvector.
- Retrieve and inject: REST routes, `viewer.html`, `session_start_hook.py`, and `mcp-server.js` retrieve memory for browsing, task-specific recall, search, hooks, and MCP tools.

## Files

- `server.js`: Express API and static UI server on port 3737.
- `viewer.html`: single-file dark UI for chats, bookmarks, repos, and memory.
- `schema.sql`: idempotent Postgres schema with pgvector.
- `db.js`: shared `pg.Pool`.
- `capture.py`: Claude Code PreCompact hook.
- `session_start_hook.py`: Claude Code SessionStart hook.
- `bulk_import.py`: batch importer for Claude JSONL transcripts.
- `extract.js`, `llm.js`, `embeddings.js`, `projects.js`, `retrieve.js`: project memory pipeline.
- `recall_scoring.js`, `recall_request.js`: deterministic task recall scoring and request normalization.
- `session_summary.js`: cached per-conversation summaries.
- `manifest.js`, `summarize.js`, `enrich.js`: repo indexing and file mention enrichment.
- `backup.js`, `restore.js`: JSON snapshots of sessions, messages, and bookmarks only.
- `reconcile_projects.js`: maintenance script for re-keying artifacts after project identity improves.
- `mcp-server.js`: stdio MCP server exposing project-memory tools.

## Prerequisites

- Node.js 18 or newer.
- Python 3 with `psycopg2-binary` installed globally or in your venv.
- PostgreSQL 16+ with the `vector` extension available.
- Optional: `OPENAI_API_KEY` for embeddings and OpenAI chat, or `ANTHROPIC_API_KEY` for chat distillation.

## Setup

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Copy and edit environment values:

   ```powershell
   Copy-Item .env.example .env
   ```

   Set the Postgres credentials for this laptop. Add `OPENAI_API_KEY` if you want embeddings and project memory search.

3. Create the database and apply the schema:

   ```sql
   CREATE DATABASE claude_chats;
   \c claude_chats
   CREATE EXTENSION IF NOT EXISTS vector;
   ```

   ```powershell
   npm run setup
   ```

4. Start the app:

   ```powershell
   npm start
   ```

   Open `http://localhost:3737`.

5. Register Claude Code hooks in `~/.claude/settings.json`:

   ```json
   {
     "hooks": {
       "PreCompact": [
         {
           "matcher": "",
           "hooks": [
             {
               "type": "command",
               "command": "python C:\\GithubRepos\\ClaudeChat\\capture.py"
             }
           ]
         }
       ],
       "SessionStart": [
         {
           "matcher": "",
           "hooks": [
             {
               "type": "command",
               "command": "python C:\\GithubRepos\\ClaudeChat\\session_start_hook.py"
             }
           ]
         }
       ]
     }
   }
   ```

6. Optionally register the MCP server:

   ```json
   {
     "mcpServers": {
       "project-memory": {
         "command": "node",
         "args": ["C:\\GithubRepos\\ClaudeChat\\mcp-server.js"]
       }
     }
   }
   ```

## Extraction Freshness

Imported transcripts and PreCompact captures compute `sessions.source_hash` from normalized ordered messages and store stable message `seq` values. Extraction no longer depends only on `extraction_log`; a session is skipped only when:

```text
source_hash is present and source_hash == last_extracted_hash
```

When extraction runs for a changed or forced session, artifacts from that same `session_ref` are deleted and recreated from the current transcript. Artifacts from other sessions are left alone. Successful extraction updates `last_extracted_hash` and `last_extracted_at`.

## Task Recall API

Use `POST /api/memory/recall` before investigating a non-trivial coding task:

```json
{
  "project": "C:\\GithubRepos\\ClaudeChat",
  "query": "The session-start hook is returning stale memory",
  "files": ["session_start_hook.py", "retrieve.js"],
  "error": "",
  "branch": "main",
  "commit": "",
  "maxTokens": 700,
  "maxArtifacts": 5
}
```

The response returns a compact markdown context pack and selected memories when relevance is strong enough:

```json
{
  "memoryUsed": true,
  "context": "## Relevant project memory\n...",
  "estimatedTokens": 318,
  "memories": []
}
```

Recall combines vector candidates when OpenAI embeddings are configured with keyword candidates, then applies deterministic boosts for lexical matches, active-file overlap, memory type, and recency. Todos are excluded unless the task explicitly asks about pending work.

## MCP Tools

The MCP server keeps the existing tools:

- `get_project_summary`
- `search_memory`
- `get_project_context`
- `list_projects`

It also exposes `recall_task_context`, which accepts `project`, `task`, optional `files`, optional `error`, and `maxTokens`. Use it before changing existing behavior, debugging errors, revisiting architecture, or editing files that may have historical decisions.

## SessionStart Hook

`session_start_hook.py` no longer injects a broad artifact list. It injects only a short project-memory note plus the project summary when available, and tells the agent to call `recall_task_context` or `search_memory` once the actual task is known.

## Recall Telemetry

Every REST or MCP task recall writes a row to `memory_recall_log` with the project id, query, active files, error text, selected artifact ids, memory-used flag, estimated tokens, mode, and timestamp. The log intentionally does not store API keys, environment variables, or credentials.

## Example Agent Flow

1. SessionStart injects a short memory-service note.
2. The user gives a coding task.
3. The agent calls `recall_task_context` with the task text, active files, and error text.
4. The agent reads the compact context pack and proceeds with implementation.
5. The agent can call `search_memory` for deeper historical investigation when the compact pack is insufficient.

## Tests

Run:

```powershell
npm test
```

The tests use built-in Node and Python test runners and do not require OpenAI, Anthropic, or a live Postgres database.

## Recovery Note

Old conversation rows from a previous Postgres database will not come back automatically. Without a database dump or file transfer, historical data cannot be recreated. If old `~/.claude/projects/**/*.jsonl` transcript files become available on this laptop, run:

```powershell
python bulk_import.py
```

Otherwise, history starts fresh or must be manually re-imported.
