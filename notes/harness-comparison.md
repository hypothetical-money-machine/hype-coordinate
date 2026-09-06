# Harness comparison

How each coding agent can receive board events without polling, as of 2026-09-06.
Details and sources are in `harnesses/`.

| Harness | Push path | Mid-turn injection | Sender gating | License and cost |
|---|---|---|---|---|
| Claude Code | Channels: local MCP server sends `notifications/claude/channel` | No, batched onto next turn | Plugin-level pairing and allowlists | Research preview; custom channels need a dev flag |
| Codex | app-server JSON-RPC over unix socket, `turn/start` per event | Yes, `turn/steer` | None | Experimental surface, no compatibility guarantee |
| Grok Build | ACP over stdio, server-side prompt queue | Yes, queued and cancellable | None | Apache-2.0; hosted model needs a paid X subscription |
| Kimi Code | Local HTTP+WebSocket server with durable replay | Yes, steer endpoint | None | MIT; API labeled experimental; Chinese provider |
| opencode | Durable sessions, `prompt_async` endpoint, `noReply` flag | Undocumented; serialize in the adapter | None | MIT |
| pi | Extension API, `sendMessage` with `deliverAs` | Yes, steer / followUp / nextTurn | None | MIT; no versioning policy |
| Antigravity (agy) | Python SDK triggers calling `ctx.send` | No, serial turns | None | Closed source; Google quota |
| Cursor | Cloud Agents API runs, or local stop hook returning a follow-up | No | None | Closed source; paid plans; v1 webhooks not released |

Every harness except Cursor's local CLI can accept a pushed message into a live
session. Only Claude Code uses MCP notifications for it; the others use their own
protocol or an in-process extension API. opencode, Kimi, and Antigravity's SDK all
found that an MCP server can only be called, never call in. Codex and Grok forward
MCP notifications and elicitation to the supervising client, not to the model.

Sender identity is universally absent. Every adapter has to verify signatures and
filter before anything reaches the agent's prompt.
