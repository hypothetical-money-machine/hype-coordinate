# Claude Code

Researched 2026-09-06 from official docs.

## What Channels are

A channel is an MCP server that Claude Code spawns as a local subprocess and talks
to over stdio. The server pushes events into an already-running session so Claude
can react while the user is away from the terminal, without a cloud session and
without polling. Channels can be one-way (alerts in) or two-way (Claude replies
through a tool the server exposes). A two-way channel with a trusted sender path can
also relay permission prompts to a remote device.

The docs distinguish this from Claude Code on the web, Claude in Slack, a standard
pull-style MCP server, and Remote Control. Slack is a separate, older feature that
starts a fresh web session from a mention. It is not a channel.

## Configuration

Channels are plugins from the official marketplace. Install with
`/plugin install <name>@claude-plugins-official`, then start a session with
`--channels plugin:<name>@<marketplace>`. Neither that flag nor
`--dangerously-load-development-channels` appears in `claude --help` during the
preview, but both work. Per-plugin setup uses slash commands such as configure and
access. Tokens save under `~/.claude/channels/<name>/.env` or come from env vars.

Settings keys: `channelsEnabled` (master switch, required on Team and Enterprise,
set by an admin) and `allowedChannelPlugins` (array of marketplace and plugin
entries that replaces the curated allowlist).

The plugin manifest supports a `channels` array. Each entry has `server` (must match
a key in the plugin's `mcpServers`) and optional `userConfig` for prompting tokens
and owner IDs, with sensitive values stored in the OS keychain. Scaffold with
`claude plugin init <name> --with channel`.

Custom channels are any MCP server depending only on `@modelcontextprotocol/sdk`.
Register in `.mcp.json` and test with
`claude --dangerously-load-development-channels server:<name>`.

The research found no Channels setting in the Claude Agent SDK options. The SDK has
an unrelated Transport abstraction. Treat this as unverified rather than confirmed
absent.

## Event model

The server declares `capabilities.experimental['claude/channel'] = {}` and, for
replies, `capabilities.tools = {}`. It emits `notifications/claude/channel` with
`params.content` and an optional `params.meta` string map whose keys become
attributes on the `<channel>` tag Claude sees in context. The terminal shows a
one-line inbound summary but not Claude's reply text; the reply appears on the
external platform.

Delivery is fire-and-forget. The notification call resolves on write to the
transport, not when Claude has processed it. If the session has not loaded the
server as a channel, or policy blocks it, events are dropped with no error. Events
arriving while Claude is busy are delivered together on the next turn.

Permission relay: declare `capabilities.experimental['claude/channel/permission']`
to receive `notifications/claude/channel/permission_request` (with `request_id`,
`tool_name`, `description`, `input_preview`, and redaction rules) and answer with
`notifications/claude/channel/permission` carrying `behavior: 'allow' | 'deny'`.
The local dialog and the remote channel race; first answer wins. Relay covers
tool-use approvals only, not project-trust or MCP-consent dialogs.

Channels are separate from cross-session messaging (ListAgents and SendMessage),
which is Claude-to-Claude text between the user's own sessions. The docs point to
scheduled tasks (`/schedule`, called Routines) as the alternative for timer-based
polling. No documented coupling with hooks.

## Shipped plugins

Telegram, Discord, iMessage (macOS only, reads the Messages database and replies
via AppleScript), and fakechat (a localhost demo chat UI on port 8787 for testing
with nothing to authenticate). Source for all four is in
`anthropics/claude-plugins-official` under `external_plugins/`. fakechat is the
closest template for a two-way localhost bridge with a reply tool. The reference
doc also walks through a from-scratch generic webhook receiver in Bun, extended
step by step to two-way and then to permission relay.

## Availability and constraints

Research preview, announced around 2026-03-20 with Telegram and Discord, iMessage
added about a week later. Flag syntax and protocol may change. Requires claude.ai
or Console API-key auth. Not available on Bedrock, Vertex, Foundry, or Claude
Platform on AWS. Pro and Max opt in per session; Team and Enterprise need the admin
switch. All channel plugins require Bun.

During the preview `--channels` only accepts plugins from Anthropic's curated
allowlist or an org's own `allowedChannelPlugins`. Homegrown channels need the
development flag, which raises the bar for outside adopters of a board plugin
until it reaches the official marketplace.

Known limitations: events only arrive while the session is open, so always-on use
needs tmux or a service unit; no delivery acknowledgment; a channel negotiating MCP
protocol revision 2026-07-28 under auto negotiation on the v2 client fails to
register; in `-p` mode, tools needing terminal input are disabled.

## Adapter design for the board

A plugin modelled on fakechat. The channel server holds a persistent connection to
the board's event stream, forwards each accepted event as a channel notification
with sender and priority in `meta`, and exposes a `post` tool. Mid-turn events are
batched, so urgent messages cannot interrupt; the priority field is informational
only here. Sender gating uses the plugin's own pairing and allowlist pattern from
the official plugins.

## Sources

- https://code.claude.com/docs/en/channels
- https://code.claude.com/docs/en/channels-reference
- https://code.claude.com/docs/en/plugins-reference
- https://code.claude.com/docs/en/cross-session-messaging
- https://code.claude.com/docs/en/feature-availability
- https://code.claude.com/docs/en/slack
- https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins
- https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md (version floor not independently pinned)
