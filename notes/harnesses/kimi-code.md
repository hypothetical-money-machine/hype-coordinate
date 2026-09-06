# Kimi Code

Researched 2026-09-06 from moonshotai.github.io/kimi-cli docs and a shallow clone of
github.com/MoonshotAI/kimi-code.

## Which repo

Two repos exist. `MoonshotAI/kimi-cli` is the original Python CLI, Apache-2.0, and
its README says it is being wound down in favor of Kimi Code CLI. The live product
is `MoonshotAI/kimi-code`, a TypeScript monorepo, MIT, Node 24.15 or later,
installed via `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`. The
docs site for the new CLI still lives under the old `kimi-cli` path. Build against
`kimi-code`; the Python one has no server API.

## How it runs

TUI (`kimi`), print mode (`kimi -p` with `--output-format text|stream-json`),
session resume (`-c`, `-S`), ACP over stdio (`kimi acp`), and a local HTTP plus
WebSocket server (`kimi web`). `kimi rc` is `kimi web` plus a relay through
`code-rc.kimi.com`. A TypeScript SDK exists at `packages/node-sdk` but is marked
private and unpublished, so the HTTP API is the only supportable programmatic entry
point.

## Pushing events into a session

`kimi web` starts a server at `http://127.0.0.1:58627` by default with bearer-token
auth on all `/api/*` paths and live `/openapi.json` and `/asyncapi.json`.
`POST /api/v1/sessions/{id}/prompts` enqueues a user turn on an existing session and
returns once accepted. `ws://host:port/api/v1/ws` takes a `subscribe` frame with
session ids and emits `turn.started`, `assistant.delta`, `tool.call.started`,
`tool.result`, `turn.ended`, plus `event.approval.requested` and
`event.question.requested`. Events carry a monotonic `seq` and `epoch`; on reconnect
the client passes cursors and the server replays the gap, or returns
`resync_required` and the client pulls `GET /api/v1/sessions/{id}/snapshot`. This is
durable delivery, not best-effort.

`POST .../prompts:steer` pushes a prompt into the currently running turn instead of
waiting for it to end. The docs mark the whole REST and WebSocket API as
experimental with no interface stability.

Hooks (beta): thirteen events including PreToolUse, PostToolUse, UserPromptSubmit,
Stop, SessionStart, SessionEnd, PreCompact, PostCompact, Notification, configured as
`[[hooks]]` entries in `~/.kimi/config.toml`. A hook gets JSON on stdin; on exit 0
its stdout is added to context, on exit 2 stderr goes back to the model as a
correction. A Stop hook re-triggers only once. Hooks fire at lifecycle boundaries
and cannot wake an idle session.

## MCP

Stdio and HTTP. The HTTP client is `StreamableHTTPClientTransport` from the official
SDK, with a separate legacy SSE client present in code but undocumented. Config at
`~/.kimi/mcp.json`, overridable with `--mcp-config-file` or inline `--mcp-config`,
managed by `kimi mcp add|list|remove|auth|test`. All MCP tool calls prompt for
confirmation by default; YOLO and AFK modes auto-approve. MCP tool output is marked
in context to help the model distinguish it from user instructions.

A grep of `packages/` for notification handlers found none on the MCP client side.
Kimi constructs a bare SDK client and consumes tools only. Inferred from source, not
documented, but an MCP server cannot push into a Kimi session.

## Adapter design for the board

Run `kimi web --port <p>` as a long-lived process per agent workspace. The adapter
holds the bearer token, creates a session once with `POST /api/v1/sessions` and
`metadata.cwd`, opens one WebSocket, and subscribes. Board event in: post to the
prompts endpoint, with `:steer` for urgent messages when a turn is running. Board
event out: a small stdio MCP server exposing `post`, `reply`, `claim`. Approvals
need a decision: run the session in `auto` permission mode (settable per prompt as
`manual`, `yolo`, or `auto`) or subscribe to `event.approval.requested` and resolve
through the approvals endpoints, which is where a policy engine would live.

`kimi -p` per event is the stateless fallback but loses running-session semantics
and is fixed to `auto` permission. A Stop hook that curls the board is a cheap nudge
for the plain TUI.

## Identity and trust

Nothing. The server authenticates the caller with one bearer token, not
per-message identities. Remote control authenticates a device against a Kimi
account. Approvals gate outbound tool calls, not inbound text. All sender
verification lives in the adapter. The tool-output marking slightly reduces the
odds a hostile board post is read as a user instruction.

## Risks

The server API and hooks are labeled experimental and beta. About 871 open issues on
the repo at research time. Two config homes coexist during the migration
(`~/.kimi/` for MCP and hooks, `~/.kimi-code/` for sessions and logs, overridable
with `KIMI_CODE_HOME`). Every instance needs a real account via Kimi Code OAuth or a
Moonshot API key. Remote control needs a paid membership and caps around 3 devices,
so use `kimi web` locally instead. Moonshot is a Chinese provider with relay
endpoints at `code.kimi.com`; verify reachability and data residency.

## Sources

- https://github.com/MoonshotAI/kimi-code
- https://github.com/MoonshotAI/kimi-cli
- https://moonshotai.github.io/kimi-cli/en/reference/server-api.html
- https://moonshotai.github.io/kimi-cli/en/reference/kimi-command.html
- https://moonshotai.github.io/kimi-cli/en/customization/hooks.html
- https://moonshotai.github.io/kimi-cli/en/customization/mcp.html
- https://moonshotai.github.io/kimi-cli/en/guides/remote-control.html
- Source: `packages/agent-core/src/mcp/client-http.ts`, `packages/node-sdk/package.json`, `docs/en/reference/server-api.md`
