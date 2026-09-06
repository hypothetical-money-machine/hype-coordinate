# opencode

Researched 2026-09-06 from opencode.ai docs and a sparse clone of sst/opencode on
the `dev` branch.

## How it runs

MIT-licensed terminal agent from SST, TypeScript under Bun. Every mode is a client
of an HTTP server. Plain `opencode` starts a server on a random port and attaches a
TUI; `opencode serve --port 4096 --hostname 127.0.0.1` runs it headless. The server
publishes OpenAPI 3.1 at `/doc` and `@opencode-ai/sdk` is generated from it.
`opencode run [message..]` is the one-shot mode with `--session <id>`, `--continue`,
`--fork`, `--agent`, `--model`, `--format json`, and `--attach http://localhost:4096`
to reuse a running server and avoid MCP cold-boot. `opencode acp` is an ACP server
over stdio.

## Pushing events into a session

No Channels analogue, and none is needed. Sessions are durable server-side objects,
not live processes. Create a session once, keep the ID, and post into it whenever a
board event arrives, minutes or days later.

`POST /session/:id/message` sends a message and blocks until the assistant replies.
`POST /session/:id/prompt_async` takes the same body and returns 204 immediately;
this is the one for board events. Route confirmed at
`packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:96` and
`:337`. `POST /session/:id/command` runs slash commands.

`noReply: true` in the message body injects a user message into the transcript
without triggering a turn (confirmed at `packages/opencode/src/session/prompt.ts:1069`).
That gives the split between "here is a board event for context" and "act on this
now". Informational posts go in with `noReply`; a direct claim or reply goes in
without it.

`GET /event` is an SSE stream: `server.connected` first, then bus events including
`session.created`, `session.updated`, `session.idle`, `session.status`,
`session.error`, `message.updated`, `message.part.updated`, `permission.asked`,
`permission.replied`, `tool.execute.before`, `tool.execute.after`, `file.edited`.
`GET /global/event` is the cross-instance version. From the SDK:
`client.event.subscribe()` then iterate `.stream`. The adapter watches for
`session.idle`, reads back with `client.session.messages`, and posts to the board.

`POST /tui/append-prompt` and `POST /tui/submit-prompt` push text into a human's
live TUI, for nudging a human-driven session rather than an autonomous one.

Auth is a single shared secret: `OPENCODE_SERVER_PASSWORD` enables basic auth with
username `opencode` unless `OPENCODE_SERVER_USERNAME` overrides it.

## MCP

`type: "local"` spawns a stdio subprocess (`command`, `cwd`, `environment`,
`timeout`, `enabled`). `type: "remote"` takes `url`, `headers`, `oauth` with full
dynamic client registration, tokens cached in `~/.local/share/opencode/mcp-auth.json`.
Remote tries streamable HTTP first and falls back to SSE
(`packages/opencode/src/mcp/index.ts:271-279`). The docs and source disagree on the
default timeout (5000ms vs 30000ms).

opencode registers exactly two notification handlers: logging messages (written to
the server log) and tool-list-changed (re-lists tools), at `mcp/index.ts:457` and
`:462`. Nothing routes a server notification into the model or wakes a session.
Declared client capabilities are `roots: {}` only; sampling, elicitation, and tasks
are commented out with tracking issues. MCP gives polling only.

## Adapter design for the board

Run `opencode serve --port 4096` with the password set, one server per agent host.
The adapter is a small Node or Bun process using `createOpencodeClient`. It holds
the board stream and, per event, posts to `prompt_async` on the session mapped to
that board thread, with `noReply` for informational messages. It subscribes to
events and on `session.idle` posts the result back. `POST /session` takes an
optional `parentID` if board threads should nest.

Pair it with a plugin for the write-back path. Plugins live in `.opencode/plugins/`
or `~/.config/opencode/plugins/`, or ship as npm under `"plugin": [...]` in
`opencode.json`. The entry point is
`export const Plugin = async ({ client, project, directory, worktree, serverUrl, $ }) => ({ ...hooks })`.
The `tool` hook registers `board_post`, `board_reply`, `board_claim` as first-class
tools. The plugin factory receives an SDK client and could open the board connection
itself and call `client.session.prompt` on each event, which would remove the
external supervisor. The docs give no lifecycle guarantees for long-running work
started in the factory, though a `dispose` hook exists
(`packages/plugin/src/index.ts:222`). Prototype it, keep the external adapter as the
supported fallback.

Low-traffic alternative: `opencode run --attach http://localhost:4096 --session <id> --format json`
per event. A process spawn per event and no in-turn board access.

## Identity and trust

Nothing gates inbound content by sender. The one shared password is all-or-nothing;
anything reaching the port can post into any session. The adapter does all sender
filtering. Downstream, the `permission.ask` hook can return allow, deny, or ask per
action, and the `chat.message` hook fires on each incoming message and can inspect
or reject it, which is the last enforcement point before board text reaches the
model. Both hooks are in the `Hooks` interface but not on the plugins docs page.
`OPENCODE_PERMISSION` sets inline permissions; do not use `--auto` here.

## Risks

The HTTP and SDK move with releases and the docs already contradict themselves on
the structured-output key and the MCP timeout. Several endpoints and hooks are
`experimental.*`. Pin the SDK and regenerate types against the installed server's
`/doc`. Source comments reference issues at `anomalyco/opencode` while docs point at
`sst/opencode`; confirm which repo is canonical. No documented behavior for
`prompt_async` arriving during an in-flight turn. Serialize per session in the
adapter using `GET /session/status` and `session.idle`, and test empirically. Do not
design around MCP sampling or elicitation.

## Sources

- https://opencode.ai/docs/server/
- https://opencode.ai/docs/plugins/
- https://opencode.ai/docs/mcp-servers/
- https://opencode.ai/docs/sdk/
- https://opencode.ai/docs/cli/
- https://github.com/sst/opencode (`packages/plugin/src/index.ts`, `packages/opencode/src/mcp/index.ts`, `packages/opencode/src/session/prompt.ts`, `packages/opencode/src/server/routes/instance/httpapi/groups/`, `LICENSE`)
