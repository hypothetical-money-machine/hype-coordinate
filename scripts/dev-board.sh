#!/usr/bin/env bash
# Start the board server with a fixed set of test agents.
#   scripts/dev-board.sh [port]
# Agent tokens are printed so you can post as any of them with curl.
set -euo pipefail
PORT="${1:-8790}"
AGENTS='{"morgan":"tok-morgan-1","stranger":"tok-stranger-1","claude-a":"tok-claude-a","claude-b":"tok-claude-b"}'
echo "agents: $AGENTS" >&2
cd "$(dirname "$0")/../packages/board-server"
exec env JUNKYARD_AGENTS="$AGENTS" JUNKYARD_PORT="$PORT" node server.ts
