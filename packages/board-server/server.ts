#!/usr/bin/env node
/**
 * Minimal in-memory board server.
 *
 * Exists so the adapters have something to run against. The post schema and
 * the auth model are provisional; see notes/design-notes.md.
 *
 *   POST /v1/posts            Bearer <agent token>. Body: {type, body, thread?, to?, priority?}
 *   GET  /v1/posts            Bearer <agent token>. ?since=<post id> &thread=<id> &limit=<n>
 *                             Returns only posts the caller may see (public, or addressed to them).
 *   GET  /v1/events           Bearer <agent token>. SSE stream of posts, each signed for the subscriber.
 *   GET  /v1/health
 *
 * Agents come from JUNKYARD_AGENTS, a JSON object of {agentId: token}, or
 * from the file named by JUNKYARD_AGENTS_FILE.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'

const PORT = Number(process.env.JUNKYARD_PORT ?? 8790)
const HOST = process.env.JUNKYARD_HOST ?? '127.0.0.1'

export type PostType = 'task' | 'offer' | 'claim' | 'status' | 'reply'
export type Priority = 'interrupt' | 'normal' | 'ambient'
export type Post = {
  id: string
  seq: number
  ts: string
  from: string
  type: PostType
  body: string
  thread: string
  to?: string
  priority: Priority
}

const POST_TYPES = new Set<string>(['task', 'offer', 'claim', 'status', 'reply'])
const PRIORITIES = new Set<string>(['interrupt', 'normal', 'ambient'])
const MAX_BODY = 16 * 1024
const MAX_POSTS = Number(process.env.JUNKYARD_MAX_POSTS ?? 10_000)

function loadAgents(): Map<string, string> {
  const raw = process.env.JUNKYARD_AGENTS_FILE
    ? readFileSync(process.env.JUNKYARD_AGENTS_FILE, 'utf8')
    : process.env.JUNKYARD_AGENTS
  if (!raw) {
    process.stderr.write('board: no agents configured; set JUNKYARD_AGENTS or JUNKYARD_AGENTS_FILE\n')
    process.exit(2)
  }
  const obj = JSON.parse(raw) as Record<string, string>
  return new Map(Object.entries(obj))
}

const agents = loadAgents()
const tokenToAgent = new Map<string, string>()
for (const [id, tok] of agents) {
  const other = tokenToAgent.get(tok)
  if (other !== undefined) {
    process.stderr.write(`board: agents "${other}" and "${id}" share a token; tokens must be unique\n`)
    process.exit(2)
  }
  tokenToAgent.set(tok, id)
}

const posts: Post[] = []
let seq = 0

type Subscriber = { agent: string; token: string; res: ServerResponse }
const subscribers = new Set<Subscriber>()

/** Stable JSON: sorted keys, no whitespace. Adapters must produce the same bytes. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const keys = Object.keys(value as object).sort()
  return `{${keys
    .filter(k => (value as Record<string, unknown>)[k] !== undefined)
    .map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
    .join(',')}}`
}

function sign(token: string, post: Post): string {
  return createHmac('sha256', token).update(canonical(post)).digest('hex')
}

type Caller = { agent: string; token: string }

function authenticate(req: IncomingMessage): Caller | null {
  const h = req.headers.authorization ?? ''
  const m = /^Bearer\s+(\S+)$/i.exec(h)
  if (!m) return null
  const presented = Buffer.from(m[1])
  for (const [tok, agent] of tokenToAgent) {
    const known = Buffer.from(tok)
    if (known.length === presented.length && timingSafeEqual(known, presented)) return { agent, token: tok }
  }
  return null
}

/** The one rule for who may see a post: not the author, and public or addressed to them. */
function visibleTo(post: Post, agent: string): boolean {
  if (post.from === agent) return false
  if (post.to && post.to !== agent) return false
  return true
}

function frame(post: Post, token: string): string {
  return `id: ${post.id}\nevent: post\ndata: ${JSON.stringify({ post, sig: sign(token, post) })}\n\n`
}

function parseLimit(raw: string | null, fallback: number, max: number): number {
  const n = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(n, max)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) })
  res.end(data)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function dropSubscriber(sub: Subscriber, why: string): void {
  if (!subscribers.delete(sub)) return
  process.stderr.write(`board: dropped ${sub.agent}: ${why} (${subscribers.size} live)\n`)
  sub.res.destroy()
}

/** Write one frame; a subscriber that errors or has stopped draining is dropped, not waited on. */
function send(sub: Subscriber, data: string): void {
  if (sub.res.destroyed || sub.res.writableEnded) return dropSubscriber(sub, 'connection closed')
  if (sub.res.writableLength > MAX_BACKLOG) return dropSubscriber(sub, 'not reading')
  try {
    sub.res.write(data)
  } catch (err) {
    dropSubscriber(sub, `write failed: ${err instanceof Error ? err.message : err}`)
  }
}

const MAX_BACKLOG = 1024 * 1024
const REPLAY_UNKNOWN = 50

function deliver(post: Post): void {
  for (const sub of [...subscribers]) {
    if (!visibleTo(post, sub.agent)) continue
    send(sub, frame(post, sub.token))
  }
}

function handlePostCreate(req: IncomingMessage, res: ServerResponse): void {
  const caller = authenticate(req)
  if (!caller) return json(res, 401, { error: 'unauthorized' })
  const agent = caller.agent
  readBody(req)
    .then(raw => {
      let input: Record<string, unknown>
      try {
        input = JSON.parse(raw) as Record<string, unknown>
      } catch {
        return json(res, 400, { error: 'invalid json' })
      }
      // Type checks first, then value checks.
      for (const k of ['type', 'body', 'thread', 'to', 'priority'] as const) {
        if (input[k] !== undefined && typeof input[k] !== 'string') return json(res, 400, { error: `${k} must be a string` })
      }
      const type = (input.type as string | undefined) ?? ''
      const body = (input.body as string | undefined) ?? ''
      const priority = (input.priority as string | undefined) ?? 'normal'
      if (!POST_TYPES.has(type)) return json(res, 400, { error: `type must be one of ${[...POST_TYPES].join(', ')}` })
      if (!body.trim()) return json(res, 400, { error: 'body is required' })
      if (!PRIORITIES.has(priority)) return json(res, 400, { error: `priority must be one of ${[...PRIORITIES].join(', ')}` })
      if (input.to !== undefined && !agents.has(input.to as string)) return json(res, 400, { error: 'unknown recipient' })

      const id = randomUUID()
      const thread = (input.thread as string | undefined) ?? id
      const post: Post = {
        id,
        seq: ++seq,
        ts: new Date().toISOString(),
        from: agent,
        type: type as PostType,
        body,
        thread,
        priority: priority as Priority,
      }
      if (input.to !== undefined) post.to = input.to as string
      posts.push(post)
      if (posts.length > MAX_POSTS) posts.splice(0, posts.length - MAX_POSTS)
      process.stderr.write(`board: post ${post.seq} from ${agent} (${post.type}${post.to ? ` to ${post.to}` : ''})\n`)
      deliver(post)
      json(res, 201, post)
    })
    .catch(err => {
      const msg = err instanceof Error ? err.message : String(err)
      if (res.headersSent || res.destroyed) return
      json(res, msg === 'body too large' ? 413 : 400, { error: msg })
    })
}

function handlePostList(req: IncomingMessage, url: URL, res: ServerResponse): void {
  const caller = authenticate(req)
  if (!caller) return json(res, 401, { error: 'unauthorized' })
  const since = url.searchParams.get('since')
  const thread = url.searchParams.get('thread')
  const limit = parseLimit(url.searchParams.get('limit'), 50, 500)
  let start = 0
  if (since) {
    const idx = posts.findIndex(p => p.id === since)
    start = idx >= 0 ? idx + 1 : 0
  }
  // The caller's own posts are included here (unlike the stream) so it can read back what it wrote.
  let out = posts.slice(start).filter(p => p.from === caller.agent || visibleTo(p, caller.agent))
  if (thread) out = out.filter(p => p.thread === thread)
  json(res, 200, { posts: out.slice(-limit) })
}

function handleEvents(req: IncomingMessage, res: ServerResponse): void {
  const caller = authenticate(req)
  if (!caller) return json(res, 401, { error: 'unauthorized' })
  const { agent, token } = caller
  res.on('error', err => process.stderr.write(`board: stream error for ${agent}: ${err.message}\n`))
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  res.write(': connected\n\n')

  const sub: Subscriber = { agent, token, res }

  // Replay anything after the client's cursor before going live. A cursor the
  // board no longer has (unknown, or evicted by MAX_POSTS) replays only the
  // last REPLAY_UNKNOWN posts rather than the whole history.
  const last = req.headers['last-event-id']
  if (typeof last === 'string' && last) {
    const idx = posts.findIndex(p => p.id === last)
    const from = idx >= 0 ? idx + 1 : Math.max(0, posts.length - REPLAY_UNKNOWN)
    if (idx < 0) process.stderr.write(`board: ${agent} resumed from unknown cursor; replaying last ${posts.length - from}\n`)
    for (const post of posts.slice(from)) {
      if (visibleTo(post, agent)) send(sub, frame(post, token))
    }
    if (!subscribers.has(sub) && sub.res.destroyed) return
  }

  subscribers.add(sub)
  process.stderr.write(`board: ${agent} subscribed (${subscribers.size} live)\n`)
  const ping = setInterval(() => send(sub, ': ping\n\n'), 15_000)
  req.on('close', () => {
    clearInterval(ping)
    if (subscribers.delete(sub)) process.stderr.write(`board: ${agent} disconnected (${subscribers.size} live)\n`)
  })
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const route = `${req.method} ${url.pathname}`
  if (route === 'GET /v1/health') return json(res, 200, { ok: true, posts: posts.length, subscribers: subscribers.size })
  if (route === 'POST /v1/posts') return handlePostCreate(req, res)
  if (route === 'GET /v1/posts') return handlePostList(req, url, res)
  if (route === 'GET /v1/events') return handleEvents(req, res)
  json(res, 404, { error: 'not found' })
})

process.on('uncaughtException', err => process.stderr.write(`board: uncaught exception: ${err.stack ?? err}\n`))
process.on('unhandledRejection', err => process.stderr.write(`board: unhandled rejection: ${err}\n`))

server.listen(PORT, HOST, () => {
  process.stderr.write(`board: listening on http://${HOST}:${PORT} with ${agents.size} agent(s)\n`)
})
