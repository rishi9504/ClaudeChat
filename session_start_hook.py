import json
import os
import sys
import urllib.parse
import urllib.request


def estimate_tokens(text):
    return max(1, (len(text or "") + 3) // 4)


def trim_to_tokens(text, max_tokens):
    value = text or ""
    max_chars = max_tokens * 4
    if len(value) <= max_chars:
        return value
    return value[: max(0, max_chars - 4)].rstrip() + " ..."


def build_project_memory_text(summary="", max_tokens=300):
    lines = [
        "## Project memory",
        "",
        "A persistent project-memory service is available.",
        "",
        "Before investigating a non-trivial task, use `recall_task_context` with the task description, active files and error text. Use `search_memory` for deeper historical investigation.",
    ]
    summary = (summary or "").strip()
    if summary:
        lines.extend(["", trim_to_tokens(summary, max_tokens - estimate_tokens("\n".join(lines)))])
    return trim_to_tokens("\n".join(lines), max_tokens)


def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        cwd = payload.get("cwd") or os.getcwd()
        base = os.environ.get("MEMORY_SERVER_URL", "http://localhost:3737").rstrip("/")
        url = f"{base}/api/projects/{urllib.parse.quote(cwd, safe='')}/summary"
        with urllib.request.urlopen(url, timeout=3) as response:
            data = json.loads(response.read().decode("utf-8"))
        text = build_project_memory_text(data.get("summary") or "")
        if text:
            print(
                json.dumps(
                    {
                        "hookSpecificOutput": {
                            "hookEventName": "SessionStart",
                            "additionalContext": text,
                        }
                    }
                )
            )
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
