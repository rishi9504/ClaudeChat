import json
import os
import sys
import urllib.parse
import urllib.request


def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        cwd = payload.get("cwd") or os.getcwd()
        base = os.environ.get("MEMORY_SERVER_URL", "http://localhost:3737").rstrip("/")
        url = f"{base}/api/memory/context?project={urllib.parse.quote(cwd)}"
        with urllib.request.urlopen(url, timeout=3) as response:
            data = json.loads(response.read().decode("utf-8"))
        text = data.get("text") or ""
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
