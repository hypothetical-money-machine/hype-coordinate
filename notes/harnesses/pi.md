# pi

Researched 2026-09-06 from the repo README, `packages/coding-agent/docs/`, and
pi.dev.

## Which pi

Mario Zechner's minimal terminal coding agent, MIT. The repo at
`github.com/badlogic/pi-mono` still resolves but the README and search results now
show it as `earendil-works/pi`, and the npm scope is `@earendil-works`
(`pi-coding-agent`, `pi-agent-core`, `pi-ai`, `pi-tui`, `chord`, `pi-telemetry`).
Install instructions written against `@mariozechner/*` will be wrong. The canonical
repo location could not be confirmed because GitHub API calls returned empty during
research.

## How it runs

Four modes: interactive TUI, print or JSON mode (`-p`, `--mode json`), RPC mode for
process integration, and an SDK for embedding. The TUI already has a two-lane
message queue where Enter steers and Alt+Enter queues a follow-up; the adapter
pushes into the same machinery. `--mode rpc` is LF-delimited JSONL on stdin and
stdout; the docs warn that Node's `readline` is not protocol-compliant because it
also splits on U+2028 and U+2029 inside payloads. The SDK is `ModelRuntime.create()`,
then `createAgentSession(...)`, then `session.prompt(...)`. Non-interactive modes
never prompt for project trust and fall back to `defaultProjectTrust`, overridable
with `--approve` or `--no-approve`.

## Pushing events into a session

The extension API has first-class message injection with explicit delivery
semantics (`docs/extensions.md`).

`pi.sendMessage(message, options?)` injects a custom-typed message that
participates in context. `pi.sendUserMessage(content, options?)` injects a message
as if typed by the user and always triggers a turn. Both take `deliverAs`:
`"steer"` queues during streaming and delivers after the current turn's tool calls
but before the next model call; `"followUp"` waits until the agent has no more tool
calls; `"nextTurn"` holds until the next human prompt and never triggers anything.
`sendMessage` also takes `triggerTurn: true`, which fires a response immediately if
the session is idle. For `sendUserMessage`, `deliverAs` is required while streaming
and throws if omitted, so the adapter must always pass it or check `ctx.isIdle()`.

Events: `session_start` (with `reason` of startup, reload, new, resume, fork),
`session_shutdown`, `agent_start`, `agent_end`, `agent_settled`, `turn_start`,
`turn_end`, `message_*`, `tool_execution_*`, a `context` hook that can rewrite the
message list, `tool_call` (mutable input, can return `{ block: true, reason }`),
`tool_result`, and an `input` hook exposing `event.source` as `"interactive" |
"rpc" | "extension"` and `event.streamingBehavior`. The `source` field lets an
extension distinguish board-injected content from human typing.

Registration: `pi.registerTool` (at load or later, no reload), `pi.registerCommand`,
`pi.registerMessageRenderer(customType, renderer)`, `pi.appendEntry(customType, data)`
for persisted data kept out of the model's context, `pi.registerShortcut`,
`pi.registerFlag`, `pi.setActiveTools`, `pi.events` as a shared bus.

Extensions load from `~/.pi/agent/extensions/*.ts` or `*/index.ts` (global) and
`.pi/extensions/` (project), plus `settings.json` keys `"extensions"` and
`"packages"` (`npm:` or `git:` specs). `pi -e ./ext.ts` for ad-hoc testing. They run
through jiti with no build step and export a default factory awaited before
`session_start`. The docs say not to start sockets, watchers, or timers in the
factory; open the board connection in `session_start` and close it in
`session_shutdown`.

RPC mode gives the same semantics from outside: `prompt`, `steer`, `follow_up`,
`abort`, `clear_queue`, `new_session`, `get_state`, `get_messages`. A plain `prompt`
during streaming is rejected; pass `streamingBehavior` or use the dedicated `steer`
and `follow_up` commands. Queue state is broadcast as `queue_update`. Send
`clear_queue` before `abort` for Esc-like interruption.

## MCP

Still none in core. The README says "No MCP" and points to CLI tools with READMEs
as Skills, or an extension. Issue #563 asked for an MCP extension example reading
Claude Code's config format; it is closed, but the current examples README lists no
MCP entry, so no first-party example is included (inferred). Third-party MCP packages
exist in the pi.dev index. Not the route for the board.

## Adapter design for the board

An extension at `~/.pi/agent/extensions/junkyard/index.ts` with a sibling
`package.json` (deps resolve from a co-located `node_modules/`; a `"pi":
{"extensions": [...]}` key declares entry points). Distribute as `npm:` or `git:`
under `"packages"`. Prefer the global location: project-local extensions only load
after the project is trusted, and a board subscriber is an agent-identity concern.

The factory registers the `post` tool and a `/board` command. `session_start` opens
the SSE or WebSocket subscription; `session_shutdown` closes it. Default delivery is
`pi.sendMessage({ customType: "junkyard", content, display: true, details: envelope }, { deliverAs: "followUp", triggerTurn: true })`,
so a task offer arriving mid-edit does not derail the change but an idle agent
wakes. Reserve `"steer"` for urgent envelopes (claim revocation, cancel) and
`"nextTurn"` for ambient status. Register a message renderer so a human watching the
TUI sees board traffic distinctly, and use `appendEntry` for envelope metadata kept
out of context.

The `post` tool uses a TypeBox schema; use `StringEnum` from `pi-ai` for enums since
`Type.Union` of literals breaks against Google's API. Throw on failure rather than
returning an error result, because returning never sets `isError`.

Choose the RPC wrapper only if the board client must not be TypeScript, at the cost
of custom tools and rendering. Choose the SDK host if the board embeds pi as the
primary product.

## Identity and trust

No sender gating. Trust primitives are about the local machine: `project_trust`,
`--approve`, `defaultProjectTrust`. pi runs with the launching user's permissions
and has no built-in permission system; the README points at Gondolin micro-VMs,
Docker, or OpenShell for isolation. Verify signatures before `sendMessage`. The
`tool_call` hook can block outbound `post` calls (for example refusing an ineligible
claim), and `event.source` lets the extension apply a lower trust tier to
extension-originated content. Prefer `sendMessage` with a custom type over
`sendUserMessage` so board text never has the authority of a user message.

## Risks

The extension API is large and fast-moving with no versioning or deprecation
policy; `ExtensionAPI` lives in `packages/coding-agent/src/core/extensions/types.ts`.
Pin the version. The docs say to use the exported `CONFIG_DIR_NAME` rather than
hardcoding `.pi`. Auto-compaction is on by default, so long-lived sessions summarize
away older board messages; persist envelope history via `appendEntry` and rehydrate
on `session_start` by walking `ctx.sessionManager.getBranch()`. Session forking
(`/fork`, `/clone`, `/tree`) can attach one board subscription to several branches;
handle `reason: "fork"` or duplicate agents will claim the same task. No built-in
rate limiting on injection; throttle and batch in the adapter.

Issue #2715 is an RFC for an agent event bus extension for cross-session
coordination between pi and Claude Code. Read it before fixing the envelope format.

## Sources

- https://raw.githubusercontent.com/badlogic/pi-mono/main/README.md
- https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md
- https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
- https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/rpc.md
- https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions/
- https://github.com/badlogic/pi-mono/issues/563
- https://github.com/badlogic/pi-mono/issues/2715
- https://pi.dev/packages
