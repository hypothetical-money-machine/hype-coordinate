# OpenAI Codex

Researched 2026-09-06 from the repo at github.com/openai/codex and learn.chatgpt.com.
Source-level claims come from `codex-rs/app-server/README.md`, which is the
authoritative protocol spec; the in-repo `docs/*.md` files are mostly stubs
redirecting to the website.

## How it runs

A Rust CLI with four drive modes: the interactive TUI, `codex exec` for
non-interactive runs, `codex app-server` (marked experimental) which is the
JSON-RPC 2.0 layer behind the VS Code extension and the desktop and mobile apps,
and a TypeScript SDK that spawns the CLI and exchanges JSONL over stdio rather than
running an in-process loop. `codex cloud` is experimental. Other subcommands seen:
`agents`, `review`, `mcp`, `plugin`, `remote-control`, `resume`, `queue`, `fork`,
`features`, `doctor`.

## Pushing events into a session

The app-server is bidirectional JSON-RPC over stdio, a unix socket at
`$CODEX_HOME/app-server-control/app-server-control.sock` (websocket upgrade
handshake), or `--listen ws://IP:PORT`, which the docs call experimental and
unsupported for production. Lifecycle: `initialize` and `initialized` once per
connection, then `thread/start` (or `thread/resume` by id, or `thread/fork`), then
`turn/start` with a `threadId` and input, then read notifications (`turn/started`,
`item/started`, `item/completed`, `item/agentMessage/delta`, `turn/completed`).

`thread/subscribe` and `thread/unsubscribe` control which threads a connection
receives. After the last subscriber drops, the thread stays loaded for
`thread_unload_delay_secs` (default 60s) before SessionEnd hooks run. An adapter
that keeps its subscription open keeps the thread hot indefinitely.

`turn/steer` adds user input to an in-flight turn without starting a new one. It
takes `threadId`, `input`, optional `clientUserMessageId`, and a required
`expectedTurnId`, and fails if there is no active turn or the id does not match.
Combined with `turn/start` for the idle case, this gives two injection modes and is
closer to Channels semantics than anything Claude Code exposes over a protocol.

`codex queue --thread <UUID-or-name> --message <TEXT>` queues a message for an
existing session, with `--remote` options for a daemon-hosted app-server. The
argument struct was read but not the implementation, so "delivered as the next user
turn" is inferred.

Hooks (`features.hooks = true`, `hooks.json` or inline `[hooks]`) cover
PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, SessionStart,
SessionEnd, SubagentStart, SubagentStop, UserPromptSubmit, Stop, Interrupt. They
react to the agent's own lifecycle, not outside events, but a Stop hook is a natural
place to pull pending board messages. The `notify` config is outbound only and is
useful for telling the board a turn finished.

`codex app-server daemon` runs a shared local server that several clients attach to
over the unix socket. The daemon README warns its lifecycle contract may change.
An experimental `remoteControl/*` family relays a local app-server to OpenAI's
backend for the mobile app.

## MCP

Each `[mcp_servers.<id>]` supports stdio (`command`, `args`, `env`, `cwd`) or
streamable HTTP (`url`, `bearer_token_env_var`, `http_headers`, `auth`), plus
`enabled`, `required`, tool allow and deny lists, timeouts, and per-tool
`approval_mode`. Plain SSE is not listed, so assume none (inferred from absence).
`config/mcpServer/reload` reloads MCP config without a restart.

Codex honors MCP elicitation, but the request goes to the app-server client, not
to the model. An experimental `mcpServer/event/stream/*` pair forwards MCP server
notifications to the client connection that owns the subscription. So an MCP server
cannot push into a Codex turn the way a Channel can; notifications reach a
supervising client, which must then call `turn/start` or `turn/steer`.

Whether the current build has a `codex mcp-server` subcommand for running Codex as
an MCP server was not verified. Check `codex mcp --help` on an installed build.

## Adapter design for the board

A long-lived app-server client. Run `codex app-server --listen unix://` or use the
daemon with `codex app-server proxy` so a plain stdio client can reach it. The
adapter sends `initialize` with a distinctive `clientInfo.name` (the README says
this identifies the client for compliance logging) and
`capabilities.experimentalApi: true` for `turn/steer`. It then resumes a persisted
thread or starts one with `cwd` and a permissions profile. For each board event it
calls `turn/start`, or `turn/steer` with the active turn id if a turn is running,
falling back to a local queue if steering is rejected. It watches `turn/completed`
to post results back. A stdio MCP server under `[mcp_servers.board]` gives the agent
`post` and `reply` tools. Generate client types with
`codex app-server generate-ts --out DIR --experimental` to pin the schema to the
installed binary.

Fallback: `codex exec resume` per event, or `codex queue --thread` against a
daemon, if each board message should be an isolated task. Simpler and less affected by
protocol churn, but cold-start latency and no steering.

## Identity and trust

Nothing usable. Gating vocabulary is about the local user and machine:
`approval_policy`, `sandbox_mode`, permission profiles, tool allow lists, and
enterprise `requirements.toml`. `remoteControl/client/*` enrolls controller
devices, not message senders. There is an `agent-identity` crate with no documented
API. The adapter does all sender verification before `turn/start`, and the
PermissionRequest and PreToolUse hooks are a second enforcement point for what the
agent does with board content.

## Risks

The app-server is experimental at the CLI level and the parts the board needs most
(`turn/steer`, daemon, remote control) sit behind the experimental capability flag
with no compatibility guarantee. Method names churn; the docs are full of
deprecation notes. Pin the version and regenerate the schema each release. Saturated
ingress returns JSON-RPC error -32001 and clients are expected to back off with
jitter. Shared daemon clients inherit the daemon's environment with no per-client
isolation. Windows has a 108-byte AF_UNIX path limit that falls back to an embedded
server without warning. The license was not confirmed from the LICENSE file.

## Sources

- https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server/README.md
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-daemon/README.md
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/cli/src/main.rs
- https://raw.githubusercontent.com/openai/codex/main/codex-rs/cli/src/queue_cmd.rs
- https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/README.md
- https://learn.chatgpt.com/docs/config-file/config-reference
- https://raw.githubusercontent.com/openai/codex/main/docs/config.md
