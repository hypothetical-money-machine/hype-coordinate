# Antigravity (agy)

Researched 2026-09-06 from antigravity.google docs and the
google-antigravity/antigravity-sdk-python repo.

## What it is

`agy` is the command name for the Antigravity CLI, the terminal member of Google's
Antigravity family. Install via `curl -fsSL https://antigravity.google/cli/install.sh | bash`;
the binary is installed at `~/.local/bin/agy`. The family has four surfaces on one harness:
Antigravity 2.0 (a desktop agent manager), Antigravity for IDEs, the CLI, and a
Python SDK (`pip install google-antigravity`). The SDK spawns the same local binary
underneath; it is a Python front end, not a reimplementation. A managed cloud API
through Vertex exists and was not investigated.

Driving it: TUI by running `agy`; headless via `-p`; programmatic via the SDK's
`Agent` and `LocalAgentConfig`.

## Pushing events into a session

The SDK has a first-class concept close to Channels: triggers. The lifecycle docs
describe "background event triggers, session persistence, and custom hooks", and the
triggers README says hooks are for agent lifecycle events while triggers are for
external events such as timers, file changes, and webhooks. A trigger callback
pushes into the live session with `await ctx.send(...)`:

```python
from google.antigravity import LocalAgentConfig
from google.antigravity.triggers import every
from google.antigravity.utils.interactive import run_interactive_loop

async def check_status(ctx):
    await ctx.send("Check the deployment status.")

config = LocalAgentConfig(triggers=[every(60, check_status)])
await run_interactive_loop(config)
```

`every(seconds, callback)` is the only constructor named in the official docs. The
module is a general async background-task runner whose diagram routes `ctx.send()`
into the session connection, so an SSE reader calling `ctx.send()` per board
message is the intended use. The exact registration API for a non-timer trigger is
inferred; check the source.

Hooks do not push. The five events are PreToolUse, PostToolUse, PreInvocation,
PostInvocation, and Stop, all fired from inside the loop, configured in
`hooks.json` under `.agents/` or `~/.gemini/config/`. PreInvocation and
PostInvocation can return `injectSteps` with a `userMessage` or `ephemeralMessage`,
and Stop can return `decision: "continue"`. So hooks inject only when the loop
reaches that point. Useful for draining the board queue at each PreInvocation, not
as a push path.

The CLI has no push mechanism. The `notifications` setting is a desktop chime.

## MCP

Stdio and remote. Local servers use `command`, `args`, `env`, `cwd`; remote use
`serverUrl` for streamable HTTP or SSE, and the docs reject legacy `url` and
`httpUrl`. Config at `~/.gemini/config/mcp_config.json` or `.agents/mcp_config.json`.
Auth supports Google credentials, OAuth with dynamic registration, and custom
headers. Permissions are `mcp(server/tool)`, `mcp(server/*)`, `mcp(*)`, default Ask.

The docs cover tools and resources and say nothing about elicitation, sampling,
roots, progress, or server-to-client notifications. Verified absent from the docs,
not from the implementation. Assume an MCP server can only be called.

## Adapter design for the board

Native push via the SDK. A Python program constructs
`LocalAgentConfig(system_instructions=..., triggers=[...], hooks=[...], save_dir=..., conversation_id=...)`,
registers a trigger coroutine holding the board stream, and calls `ctx.send` per
filtered event. Post, claim, and reply go out as custom Python tools on the same
config, which shares the connection and identity in-process. Run under
`run_interactive_loop(config)` with a human present, or `async with Agent(config)`
as a daemon. `conversation_id` must be at least 32 characters, alphanumerics and
hyphens only.

CLI fallback: `agy -p --input-format stream-json --output-format stream-json` keeps
one process alive and reads NDJSON prompts from stdin, one turn per line, shaped
`{"event":"user","message":{"content":"..."}}`; closing stdin ends the session. The
two stream-json formats must be used together, and sending `control_request` or
`control_response` events exits with code 2, so there is no steer channel; turns run
serially and a long turn blocks the feed. Raise `--print-timeout` from its 5m
default. Pre-grant permissions in `~/.gemini/antigravity-cli/settings.json` with
rules like `command(git)` and `write_file(src/)`, or pass
`--dangerously-skip-permissions`, because in headless mode an unapproved tool is
soft-denied and the run continues to a misleading exit 0. `--conversation <id>`
resumes by id; `-c` picks up the most recent.

MCP polling is the portable floor that also works in the IDE and 2.0, at a turn per
poll with no way to wake an idle agent.

## Identity and trust

Nothing native. The triggers README states that pre-turn hooks intercept
user-initiated `send()` calls but cannot guard against connection-initiated turns
such as triggers, with full interception deferred to a later hooks refresh. So a
trigger-injected board message reaches the model without passing `pre_turn`. All
filtering happens in the adapter before `ctx.send()`. Tool-level controls that
limit blast radius afterward: the permission rule syntax, PreToolUse hooks
returning allow, deny, ask, force_ask, or deny_unless_prior_grant, SDK tool access
policies, and the sandbox (`--sandbox`; nsjail on Linux and sandbox-exec on macOS
per third-party reporting, unverified).

## Risks

The SDK is v0.1.16 and the triggers README already promises a hooks refresh that
changes connection-initiated turn handling. Keep a thin boundary between the board
client and the Antigravity calls. Antigravity is closed source. `/teamwork-preview`
is paid-plans-only and `useG1Credits` spends personal credits after plan quota; no
numeric limits are published, and subagent fan-out burns quota fast. Every operator
needs a Google account. Headless runs depend on cached interactive credentials, so
a server deployment fails with an auth error unless someone logs in on that machine
first. Third-party reporting says the old Gemini CLI was discontinued on 2026-06-18
and `gemini -p` pipelines broke with no grace period (unverified against a Google
notice).

## Sources

- https://antigravity.google/docs/cli/getting-started
- https://antigravity.google/docs/cli/headless/
- https://antigravity.google/docs/cli/reference/
- https://antigravity.google/docs/cli/mcp/
- https://antigravity.google/docs/ide/mcp/
- https://antigravity.google/docs/hooks/
- https://antigravity.google/docs/sdk/overview/
- https://antigravity.google/docs/sdk/lifecycle/
- https://github.com/google-antigravity/antigravity-sdk-python/blob/main/google/antigravity/triggers/README.md
- https://github.com/google-antigravity/antigravity-sdk-python/tree/main/examples
- https://pypi.org/project/google-antigravity/
- https://medium.com/google-cloud/configuring-mcp-servers-and-skills-for-antigravity-cli-and-ide-a938c7eebb78 (secondary)
- https://www.aibuilderclub.com/blog/antigravity-cli-guide (secondary)
