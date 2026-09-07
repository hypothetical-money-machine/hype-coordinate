import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
export const BOARD_SRC = join(ROOT, 'packages/board-server/server.ts')
export const CHANNEL_SRC = join(ROOT, 'packages/claude-channel/server.ts')

export const AGENTS = { morgan: 'tok-morgan', approver: 'tok-approver', stranger: 'tok-stranger', 'claude-a': 'tok-claude-a', 'claude-b': 'tok-claude-b' }

export async function freePort(): Promise<number> {
  return new Promise(resolve => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

export type Board = { url: string; proc: ChildProcess; log: string[]; stop(): void }

export async function startBoard(extraEnv: Record<string, string> = {}): Promise<Board> {
  const port = await freePort()
  const log: string[] = []
  const proc = spawn('node', [BOARD_SRC], {
    env: { ...process.env, JUNKYARD_AGENTS: JSON.stringify(AGENTS), JUNKYARD_PORT: String(port), JUNKYARD_DB: ':memory:', ...extraEnv },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  proc.stderr!.on('data', d => log.push(...String(d).split('\n').filter(Boolean)))
  const url = `http://127.0.0.1:${port}`
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${url}/v1/health`)).ok) break
    } catch {}
    await sleep(50)
  }
  return { url, proc, log, stop: () => proc.kill() }
}

export function post(board: Board, token: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${board.url}/v1/posts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function list(board: Board, token: string | null, query = ''): Promise<{ status: number; posts: Array<Record<string, unknown>> }> {
  const res = await fetch(`${board.url}/v1/posts${query}`, token ? { headers: { authorization: `Bearer ${token}` } } : {})
  const body = res.ok ? ((await res.json()) as { posts: Array<Record<string, unknown>> }) : { posts: [] }
  return { status: res.status, posts: body.posts }
}

export type Channel = {
  proc: ChildProcess
  stateDir: string
  log: string[]
  notifications: Array<{ method: string; params: Record<string, unknown> }>
  send(msg: Record<string, unknown>): void
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }>
  waitFor(pred: () => boolean, ms?: number): Promise<void>
  stop(): void
}

export function makeStateDir(access: Record<string, unknown> = { policy: 'allowlist', allowFrom: ['morgan'] }): string {
  const dir = mkdtempSync(join(tmpdir(), 'jy-state-'))
  writeFileSync(join(dir, 'access.json'), JSON.stringify(access))
  return dir
}

export async function startChannel(board: Board, agent: keyof typeof AGENTS, stateDir: string, extraEnv: Record<string, string> = {}): Promise<Channel> {
  const proc = spawn('node', [CHANNEL_SRC], {
    env: {
      ...process.env,
      JUNKYARD_STATE_DIR: stateDir,
      JUNKYARD_BOARD_URL: board.url,
      JUNKYARD_AGENT_ID: agent,
      JUNKYARD_AGENT_TOKEN: AGENTS[agent],
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const log: string[] = []
  const notifications: Channel['notifications'] = []
  const replies = new Map<number, (v: unknown) => void>()
  let nextId = 1
  let buf = ''
  proc.stderr!.on('data', d => log.push(...String(d).split('\n').filter(Boolean)))
  proc.stdout!.on('data', d => {
    buf += d
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown }
      if (msg.method) notifications.push({ method: msg.method, params: msg.params ?? {} })
      else if (msg.id !== undefined) replies.get(msg.id)?.(msg.result)
    }
  })
  const send = (msg: Record<string, unknown>) => proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<unknown>(resolve => {
      const id = nextId++
      replies.set(id, resolve)
      send({ id, method, params })
    })
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
  send({ method: 'notifications/initialized' })
  const waitFor = async (pred: () => boolean, ms = 3000) => {
    const end = Date.now() + ms
    while (!pred()) {
      if (Date.now() > end) throw new Error(`timed out waiting; log:\n${log.join('\n')}`)
      await sleep(25)
    }
  }
  await waitFor(() => log.some(l => l.includes('subscribed to')))
  return {
    proc,
    stateDir,
    log,
    notifications,
    send,
    async call(name, args) {
      const r = (await request('tools/call', { name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean }
      return { text: r.content[0].text, isError: r.isError }
    },
    waitFor,
    stop: () => proc.kill(),
  }
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
