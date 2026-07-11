# claude-chat-history

Store, search, summarize, and reuse Claude Code conversations from a local Postgres database.

## Architecture

The app has three subsystems:

- Ingest and compact: `capture.py` records Claude Code transcripts during PreCompact, while `bulk_import.py` re-scans `~/.claude/projects/**/*.jsonl`.
- Project memory store: `extract.js` distills durable project knowledge into artifacts, embeds them with OpenAI embeddings when available, and stores them in Postgres with pgvector.
- Retrieve and inject: REST routes, `viewer.html`, `session_start_hook.py`, and `mcp-server.js` retrieve memory for browsing, search, hooks, and MCP tools.

## Files

- `server.js`: Express API and static UI server on port 3737.
- `viewer.html`: single-file dark UI for chats, bookmarks, repos, and memory.
- `schema.sql`: idempotent Postgres schema with pgvector.
- `db.js`: shared `pg.Pool`.
- `capture.py`: Claude Code PreCompact hook.
- `session_start_hook.py`: Claude Code SessionStart hook.
- `bulk_import.py`: batch importer for Claude JSONL transcripts.
- `extract.js`, `llm.js`, `embeddings.js`, `projects.js`, `retrieve.js`: project memory pipeline.
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

## Recovery Note

Old conversation rows from a previous Postgres database will not come back automatically. Without a database dump or file transfer, historical data cannot be recreated. If old `~/.claude/projects/**/*.jsonl` transcript files become available on this laptop, run:

```powershell
python bulk_import.py
```

Otherwise, history starts fresh or must be manually re-imported.
