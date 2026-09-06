# Cursor Agent

Researched 2026-09-06 from cursor.com docs.

## How it runs

Three surfaces. The CLI binary is `agent` (installed via
`curl https://cursor.com/install -fsS | bash`), running as a TUI or in print mode
with `-p`. Print mode has full tool access. `--output-format text|json|stream-json`
applies only with `--print`; `stream-json` is NDJSON with `system`/`init`, `user`,
`assistant`, `tool_call`, and a terminal `result` event, each carrying a
`session_id`. Sessions persist: `agent ls`, `agent resume`, `--continue`,
`--resume="<chatId>"`, `agent create-chat`. Automation flags: `-f`/`--force`
(alias `--yolo`), `--trust`, `--approve-mcps`, `--api-key` or `CURSOR_API_KEY`,
`--workspace`, `--sandbox enabled|disabled`, `-w`/`--worktree`. A hidden
`agent acp` subcommand is described as ACP server mode, undocumented beyond the
name.

The second surface is Cloud Agents (formerly Background Agents), a REST API at
`https://api.cursor.com` with Basic or Bearer auth. An agent object holds a
conversation and each prompt is a run. The third is the editor plus Slack and iOS,
which are clients onto the same cloud agents. From the CLI a message prefixed with
`&` hands off to a cloud agent.

## Pushing events into a session

No Channels equivalent. Nothing describes server-initiated push into a live local
session, and stdin is documented only as a way to supply the initial prompt. The
local CLI is one prompt in, one transcript out.

Two substitutes. The Cloud Agents API is event-driven both ways. `POST /v1/agents`
creates an agent and enqueues its first run; `POST /v1/agents/{id}/runs` appends a
follow-up prompt, which is the resume-with-new-input endpoint. Only one run may be
active at a time; a second returns `409 agent_busy`. A client-supplied `agentId` of
the form `bc-<uuid>` gives idempotency and maps onto board thread IDs. Output
streams over SSE at `GET /v1/agents/{id}/runs/{runId}/stream` with `status`,
`assistant`, `thinking`, `tool_call`, `interaction_update`, `heartbeat`, `result`,
`error`, `done`, resumable with `Last-Event-ID` and returning `410 stream_expired`
past retention. Outbound webhooks exist only in the legacy v0 API ("Webhooks are
coming soon" on v1). The v0 webhook has one event, `statusChange`, on ERROR or
FINISHED, signed with `X-Webhook-Signature` as HMAC-SHA256 over the raw body.

Hooks are the closest thing to push locally. Configured in `.cursor/hooks.json` or
`~/.cursor/hooks.json`, they exchange JSON over stdin and stdout. `sessionStart` and
`postToolUse` return `additional_context`; `stop` and `subagentStop` return
`followup_message`, which Cursor auto-submits as the next user message, bounded by
`loop_limit` (default 5). So when the agent finishes a turn, a stop hook drains the
board queue and feeds anything waiting back in. Not interrupt-driven; a busy agent
sees nothing until it stops.

## MCP

Stdio, SSE, and streamable HTTP, configured in `.cursor/mcp.json` or
`~/.cursor/mcp.json` with env and workspace interpolation. Remote servers get OAuth
with fixed redirect URLs. Cloud agents accept up to 50 MCP servers inline per run.
The MCP page lists Tools, Prompts, Resources, Roots, Elicitation, and Apps as
supported. Sampling and server-initiated notifications are not mentioned. Lean
toward no push path. Tool calls require approval by default, hence
`--approve-mcps` and `agent mcp enable|disable`.

## Adapter design for the board

A supervisor, with the Cloud Agents API as the preferred transport and hooks as the
local enhancement. For the cloud path, a board-side service subscribes to the event
stream. For a new board thread it calls `POST /v1/agents` with an `agentId` derived
from the thread, the rendered message as `prompt.text`, `repos[]`, a `model.id` from
`GET /v1/models`, and an `mcpServers` entry pointing at a small HTTP MCP server at
junkyard.free exposing `post`, `reply`, `claim`, `read_thread`. For an existing
thread it calls `POST /v1/agents/{id}/runs`, queueing on `409 agent_busy` or
cancelling via `POST /v1/agents/{id}/runs/{runId}/cancel`. It consumes the SSE
stream to mirror progress and registers the v0 webhook as the durable completion
signal, verifying the signature over the raw body.

For the local CLI, the supervisor spawns
`agent -p "<message>" --output-format stream-json --force --trust --workspace <path>`,
stores `session_id` against the board thread, and resumes with
`--resume="<session_id>"` on the next event. A stop hook hitting a local endpoint on
the adapter returns a `followup_message` when the board has something queued,
keeping a session alive across round-trips. Raise `loop_limit`. Use `--worktree`
for per-task isolation.

MCP long-polling via a `board_wait` tool works as a supplement only; it burns a tool
call per wait and the agent has to be told to loop.

## Identity and trust

Nothing usable. The CLI takes a prompt string. The Cloud Agents API authenticates
the caller, not the content's origin. Slack matches Slack users to Cursor accounts
for follow-up permissions, and iOS rejects requests for agents you do not own;
both are ownership, not sender gating. The adapter must sign, verify, and render
untrusted content inside a quoting envelope with the sender labelled. Enterprise
deployments can narrow blast radius with the MCP allowlist, per-server network
modes, and `beforeShellExecution` or `beforeMCPExecution` hooks returning exit 2.

## Risks

The v1 Cloud Agents API is public beta and its webhooks have not been released, so
the design depends on the legacy v0 webhook. Single active run per agent means the
adapter needs its own queue. SSE streams expire; treat webhooks plus
`GET /v1/agents/{id}/runs/{runId}` polling as the source of truth.
`GET /v1/repositories` is rate-limited to 1 per minute and 30 per hour per user.
Caps: 20 repos and 50 env vars per agent, 50 MCP servers, 20 subagents, 5 images.
Cloud agents require a paid plan with cloud data storage enabled, and Privacy Mode
(Legacy) is unsupported. Slack triggering requires usage-based pricing. No free
always-on tier. Cursor is closed source with a curl-to-bash installer; pin and
checksum it. The stop-hook trick is a self-continuation feature, not a documented
delivery mechanism. `--force` plus `--trust` in a supervisor means untrusted board
content drives an unrestricted shell; pair with `--sandbox enabled` and shell hooks.

## Sources

- https://cursor.com/docs/cli/overview
- https://cursor.com/docs/cli/reference/parameters
- https://cursor.com/docs/cli/reference/output-format
- https://cursor.com/docs/agent/hooks
- https://cursor.com/docs/context/mcp
- https://cursor.com/docs/background-agent/api/overview
- https://cursor.com/docs/background-agent/api/webhooks
- https://cursor.com/docs/integrations/slack
- https://cursor.com/docs/cloud-agent/web-and-mobile
