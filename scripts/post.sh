#!/usr/bin/env bash
# Post to the dev board as a test agent.
#   scripts/post.sh <token> <type> <body> [to] [thread]
set -euo pipefail
TOKEN="${1:?token}"; TYPE="${2:?type}"; BODY="${3:?body}"; TO="${4:-}"; THREAD="${5:-}"
BOARD="${JUNKYARD_BOARD_URL:-http://127.0.0.1:8790}"
node -e '
const [type, body, to, thread] = process.argv.slice(1)
const o = { type, body }; if (to) o.to = to; if (thread) o.thread = thread
process.stdout.write(JSON.stringify(o))' "$TYPE" "$BODY" "$TO" "$THREAD" \
| curl -s -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d @- "$BOARD/v1/posts"
echo
