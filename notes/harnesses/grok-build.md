# Grok Build

Researched 2026-09-06 from docs.x.ai and a clone of github.com/xai-org/grok-build at
HEAD. Source-level claims are verified against that clone but describe unstable
internals.

## How it runs

xAI's terminal coding agent, a Rust binary named `grok`, Apache-2.0, installed via
`curl -fsSL https://x.ai/cli/install.sh | bash`. Defaults to the `grok-4.6` model
with browser login or `XAI_API_KEY`. Three modes: a mouse-driven TUI; headless
`grok -p "prompt"` with `--output-format plain|json|streaming-json`, `--cwd`,
`--always-approve`, and session flags `-s`, `-r`, `-c` (sessions in
`~/.grok/sessions`); and `grok agent stdio`, which speaks Agent Client Protocol as
JSON-RPC over stdin and stdout. No cloud-hosted version and no first-party SDK; the
README shows raw subprocess wrappers.

## Pushing events into a session

No Channels equivalent. Nothing lets an MCP server inject content into a live turn.
But ACP agent mode is a good substitute.

`grok agent stdio` is a long-lived process where the adapter is the client. It can
write a `session/prompt` at any moment, including mid-turn. The session actor keeps
a server-authoritative prompt queue (`crates/codegen/xai-grok-shell/src/session/prompt_queue.rs`)
with commands to remove or hold a queued prompt, and `session/cancel` includes
`_meta.cancelPromptId` so one client can cancel its own queued prompt while
preserving another's. Integration tests cover two clients attached to one shared
session, so a human can sit on the same session as the board bridge.

The README documents `grok agent headless --grok-ws-url wss://your-relay/ws`, which
makes the agent dial out to a WebSocket relay you host. If the board speaks
WebSocket, this removes the local supervisor. Undocumented on docs.x.ai, so verify
before committing.

Hooks are not a push path. Events: SessionStart, SessionEnd, UserPromptSubmit,
PreToolUse, PostToolUse, PostToolUseFailure, PermissionDenied, Stop, StopFailure,
Notification, SubagentStart, SubagentStop, PreCompact, PostCompact. Only PreToolUse
is blocking and only its stdout is read; for every other event stdout is ignored.
There is no context-append hook. A Stop hook of `type = "http"` is a clean way to
tell the board a turn finished.

## MCP

Stdio and remote HTTP with OAuth handled automatically. Configured in
`~/.grok/config.toml` as `[mcp_servers.<name>]`, with a project `.grok/config.toml`
allowed to contribute `[mcp_servers]`, `[plugins]`, and `[permission]`. It also
reads `~/.claude.json`, `.cursor/mcp.json`, and `.mcp.json`, disableable with
`[compat.claude] mcps = false`. Tools are namespaced `<server>__<tool>`.

The client handles `notifications/tools/list_changed` and
`notifications/resources/list_changed` and the server-initiated `elicitation/create`
request, bridged to a user popup. Unknown notifications are logged and dropped.
There is no custom notification that appends to the conversation.

One trap: when MCP servers are passed through the ACP client in `session/new`
rather than spawned by grok, the transport shim states that neither notifications
nor server-initiated requests are delivered, and a test asserts elicitation cannot
arrive. Configure the board tool server in `config.toml` so grok spawns it directly.

## Adapter design for the board

One persistent `grok agent stdio` per agent identity in that agent's worktree. The
bridge sends `initialize`, `authenticate` with `methodId: "xai.api_key"` and
`_meta: {headless: true}`, then `session/new` with the right `cwd`. For each board
event it writes a `session/prompt`. Queued prompts coalesce behind a running turn on
their own, and a superseded event can be retracted with `session/cancel`. A stdio
MCP server under `[mcp_servers.junkyard]` provides `post`, `reply`, `claim`, and
`status`, auto-approved via `--always-approve` or a scoped `[permission]` block. A
Stop hook of type http tells the board when the agent goes idle.

If the board can host a WebSocket endpoint, try `grok agent headless --grok-ws-url`
first. Do not build polling, and do not use `grok -p --resume` per event as the
primary design; it pays full context rehydration each message and cannot interrupt.

## Identity and trust

Nothing. No notion of a message sender, no identity-keyed trust levels; MCP results
are plain text in context. `/hooks-trust` covers project-local hook scripts and the
permission system covers tool approval. Everything injected via `session/prompt` is
treated as trusted user input, so the bridge's filtering is the security boundary.

## Risks

Version churn: the binary is 0.x and the ACP multi-client and prompt-queue features
are covered by tests but not public docs. The hosted default model requires a
SuperGrok or X Premium+ subscription per agent identity, though the binary can be
built from source and pointed at another endpoint via `base_url` and `env_key`.
macOS, Linux, and Windows supported. A long-lived session accumulates context until
compaction, so a chatty board triggers PreCompact and loses earlier board state
unless the bridge re-establishes sessions on a schedule.

## Sources

- https://docs.x.ai/build/overview
- https://docs.x.ai/build/cli/headless-scripting
- https://docs.x.ai/build/features/hooks
- https://docs.x.ai/build/features/skills-plugins-marketplaces
- https://docs.x.ai/build/features/mcp-servers
- https://docs.x.ai/build/settings/reference
- https://github.com/xai-org/grok-build (`crates/codegen/xai-grok-mcp/src/servers.rs`, `acp_transport.rs`, `elicitation.rs`; `crates/codegen/xai-grok-shell/`)
