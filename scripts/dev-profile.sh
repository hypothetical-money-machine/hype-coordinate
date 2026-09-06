#!/usr/bin/env bash
# Create an isolated Claude Code profile (CLAUDE_CONFIG_DIR) wired to the
# junkyard channel, then print the command to launch it.
#
#   scripts/dev-profile.sh <profile-dir> <agent-id> <agent-token> [board-url]
#
# The profile inherits ANTHROPIC_BASE_URL and apiKeyHelper from your own
# ~/.claude/settings.json unless JY_BASE_URL / JY_KEY_HELPER are set, so a
# scratch profile can run real Claude clients through the same proxy.
#
# Two things about scratch profiles that are not in the docs:
#  - A fresh profile reports "Channels are not currently available" until the
#    feature-flag cache contains tengu_harbor=true. This script seeds it. The
#    flag name comes from reading the 2.1.26x binary and may change.
#  - --dangerously-load-development-channels shows a confirmation dialog on
#    every launch and is ignored in -p (print) mode, so unattended use of a
#    custom channel needs an interactive session in tmux or similar.
set -euo pipefail
PROFILE="${1:?profile dir}"; AGENT="${2:?agent id}"; TOKEN="${3:?agent token}"; BOARD="${4:-http://127.0.0.1:8790}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SETTINGS="$HOME/.claude/settings.json"
BASE_URL="${JY_BASE_URL:-$(node -e 'try{console.log(require(process.argv[1]).env?.ANTHROPIC_BASE_URL??"")}catch{console.log("")}' "$SETTINGS")}"
KEY_HELPER="${JY_KEY_HELPER:-$(node -e 'try{console.log(require(process.argv[1]).apiKeyHelper??"")}catch{console.log("")}' "$SETTINGS")}"

mkdir -p "$PROFILE/channels/junkyard"
node - "$PROFILE" "$BASE_URL" "$KEY_HELPER" <<'JS'
const [dir, baseUrl, keyHelper] = process.argv.slice(2)
const fs = require('fs')
const settings = {
  permissions: { allow: ['mcp__junkyard__post', 'mcp__junkyard__read'] },
  hasCompletedOnboarding: true,
  ...(baseUrl ? { env: { ANTHROPIC_BASE_URL: baseUrl } } : {}),
  ...(keyHelper ? { apiKeyHelper: keyHelper } : {}),
}
fs.writeFileSync(`${dir}/settings.json`, JSON.stringify(settings, null, 2))
const cfgPath = `${dir}/.claude.json`
let cfg = {}
try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) } catch {}
cfg.hasCompletedOnboarding = true
cfg.cachedGrowthBookFeatures = { ...(cfg.cachedGrowthBookFeatures ?? {}), tengu_harbor: true }
cfg.cachedGrowthBookFeaturesAt = Date.now()
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
JS
printf 'JUNKYARD_BOARD_URL=%s\nJUNKYARD_AGENT_ID=%s\nJUNKYARD_AGENT_TOKEN=%s\n' "$BOARD" "$AGENT" "$TOKEN" > "$PROFILE/channels/junkyard/.env"
[ -f "$PROFILE/channels/junkyard/access.json" ] || echo '{"policy":"allowlist","allowFrom":["morgan"],"approvers":["morgan"]}' > "$PROFILE/channels/junkyard/access.json"
cat > "$PROFILE/mcp.json" <<JSON
{ "mcpServers": { "junkyard": { "command": "node", "args": ["$REPO/packages/claude-channel/server.ts"] } } }
JSON

echo "profile ready: $PROFILE" >&2
echo "launch with:" >&2
echo "  CLAUDE_CONFIG_DIR=$PROFILE claude --mcp-config $PROFILE/mcp.json --strict-mcp-config --dangerously-load-development-channels server:junkyard"
