import json
import os
import re
import sys
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
            return "\n".join(block_text(item) for item in content if block_text(item)).strip()
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


def parse_transcript(path):
    messages = []
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for raw in handle:
            if not raw.strip():
                continue
            try:
                row = json.loads(raw)
            except Exception:
                continue
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
    return messages


def save_session(payload, messages):
    session_id = payload.get("session_id")
    cwd = payload.get("cwd") or ""
    name = f"{Path(cwd).name or 'unknown'} - {datetime.now():%b %d %H:%M}"
    conn = db_connect()
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO sessions(session_id, name, cwd, message_count, updated_at)
                    VALUES(%s,%s,%s,%s,NOW())
                    ON CONFLICT(session_id) DO UPDATE SET
                      updated_at = NOW(),
                      name = EXCLUDED.name,
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
    finally:
        conn.close()


def main():
    load_env()
    try:
        payload = json.load(sys.stdin)
        transcript_path = payload.get("transcript_path")
        if not transcript_path or not Path(transcript_path).exists():
            return 0
        messages = parse_transcript(transcript_path)
        if messages:
            save_session(payload, messages)
    except Exception as exc:
        print(f"capture.py error: {exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
