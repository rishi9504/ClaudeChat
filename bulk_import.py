import json
import os
import re
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

import psycopg2


def load_env():
    env_path = Path(__file__).with_name(".env")
    if not env_path.exists():
        return
    for raw in env_path.read_text(errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key.strip(), value)


def db_connect():
    return psycopg2.connect(
        host=os.environ.get("PG_HOST", "localhost"),
        port=int(os.environ.get("PG_PORT", "5432")),
        dbname=os.environ.get("PG_DB", "claude_chats"),
        user=os.environ.get("PG_USER", "postgres"),
        password=os.environ.get("PG_PASSWORD", "postgres"),
    )


def block_text(block):
    if isinstance(block, str):
        return block
    if not isinstance(block, dict):
        return ""
    kind = block.get("type")
    if kind == "text":
        return block.get("text") or ""
    if kind == "tool_use":
        name = block.get("name") or "tool"
        return f"[Tool: {name}]\n{json.dumps(block.get('input') or {}, ensure_ascii=False)}"
    if kind == "tool_result":
        content = block.get("content")
        if isinstance(content, list):
            return "\n".join(part for part in (block_text(item) for item in content) if part).strip()
        if isinstance(content, str):
            return content
        return "[Tool Result]"
    return ""


def flatten_content(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(part for part in (block_text(item) for item in content) if part).strip()
    return ""


def dir_to_cwd(dirname):
    value = Path(dirname).name.lstrip("-").replace("-", "/")
    return "/" + value if value else ""


def parse_transcript(path):
    messages = []
    cwds = Counter()
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for raw in handle:
            raw = raw.replace("\x00", "")
            if not raw.strip():
                continue
            try:
                row = json.loads(raw)
            except Exception:
                continue
            cwd = row.get("cwd") or (row.get("message") or {}).get("cwd")
            if cwd:
                cwds[str(cwd)] += 1
            if row.get("type") not in ("user", "assistant"):
                continue
            message = row.get("message") or {}
            role = message.get("role") or row.get("type")
            if role not in ("user", "assistant", "system"):
                role = row.get("type")
            content = flatten_content(message.get("content")).strip()
            if not content:
                continue
            messages.append(
                {
                    "role": role,
                    "content": content,
                    "captured_at": row.get("timestamp"),
                    "has_code": bool(re.search(r"```", content)),
                    "has_command": bool(re.search(r"^\s*[$>]\s", content, re.MULTILINE)),
                }
            )
    real_cwd = cwds.most_common(1)[0][0] if cwds else dir_to_cwd(path.parent)
    return messages, real_cwd


def is_subagent(path):
    return "subagents" in [part.lower() for part in path.parts]


def save_file(conn, path, messages, cwd):
    session_id = path.stem
    project_dir = path.parent.name
    mtime = datetime.fromtimestamp(path.stat().st_mtime)
    name = f"{Path(cwd).name or project_dir} - {mtime:%b %d %H:%M}"
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO sessions(session_id, name, cwd, message_count, updated_at)
            VALUES(%s,%s,%s,%s,NOW())
            ON CONFLICT(session_id) DO UPDATE SET
              updated_at = NOW(),
              name = EXCLUDED.name,
              cwd = EXCLUDED.cwd,
              message_count = EXCLUDED.message_count
            RETURNING id
            """,
            (session_id, name, cwd, len(messages)),
        )
        session_ref = cur.fetchone()[0]
        cur.execute("DELETE FROM messages WHERE session_ref = %s", (session_ref,))
        for message in messages:
            cur.execute(
                """
                INSERT INTO messages(session_ref, role, content, has_code, has_command, captured_at)
                VALUES(%s,%s,%s,%s,%s,%s)
                """,
                (
                    session_ref,
                    message["role"],
                    message["content"],
                    message["has_code"],
                    message["has_command"],
                    message["captured_at"],
                ),
            )


def main():
    load_env()
    projects_dir = Path.home() / ".claude" / "projects"
    if not projects_dir.exists():
        print(f"Projects dir not found: {projects_dir}", file=sys.stderr)
        return 1

    conn = db_connect()
    sessions = 0
    messages_total = 0
    skipped = 0
    try:
        for file_path in sorted(projects_dir.rglob("*.jsonl")):
            if is_subagent(file_path):
                skipped += 1
                print(f"skip {file_path}")
                continue
            try:
                messages, cwd = parse_transcript(file_path)
                if not messages:
                    skipped += 1
                    print(f"skip {file_path}")
                    continue
                with conn:
                    save_file(conn, file_path, messages, cwd)
                sessions += 1
                messages_total += len(messages)
                print(f"ok {file_path} ({len(messages)} messages)")
            except Exception as exc:
                conn.rollback()
                print(f"ERROR {file_path}: {exc}", file=sys.stderr)
        print(f"Done. {sessions} sessions, {messages_total} messages imported. {skipped} files skipped.")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
