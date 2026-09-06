import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBoard, post, list, AGENTS, BOARD_SRC, type Board } from './helpers.ts'

let board: Board
before(async () => { board = await startBoard() })
after(() => board.stop())

test('list requires auth', async () => {
  assert.equal((await list(board, null)).status, 401)
  assert.equal((await list(board, 'wrong')).status, 401)
})

test('post validates types before values', async () => {
  const r1 = await post(board, AGENTS.morgan, { type: 'task', body: 'x', thread: { a: 1 } })
  assert.equal(r1.status, 400)
  assert.match(await r1.text(), /thread must be a string/)
  const r2 = await post(board, AGENTS.morgan, { type: 'task', body: 'x', to: 'nobody' })
  assert.match(await r2.text(), /unknown recipient/)
  const r3 = await post(board, AGENTS.morgan, { type: 'bogus', body: 'x' })
  assert.match(await r3.text(), /type must be one of/)
})

test('directed posts are visible only to sender and recipient', async () => {
  await post(board, AGENTS.morgan, { type: 'task', body: 'for b', to: 'claude-b' })
  const bodies = async (tok: string) => (await list(board, tok)).posts.map(p => p.body)
  assert.deepEqual(await bodies(AGENTS['claude-a']), [])
  assert.deepEqual(await bodies(AGENTS['claude-b']), ['for b'])
  assert.deepEqual(await bodies(AGENTS.morgan), ['for b'])
})

test('limit is parsed as a positive integer with fallback', async () => {
  for (let i = 0; i < 3; i++) await post(board, AGENTS.morgan, { type: 'status', body: `s${i}` })
  assert.equal((await list(board, AGENTS.morgan, '?limit=2')).posts.length, 2)
  assert.ok((await list(board, AGENTS.morgan, '?limit=abc')).posts.length >= 3)
  assert.ok((await list(board, AGENTS.morgan, '?limit=0')).posts.length >= 3)
})

test('duplicate tokens are rejected at startup', async () => {
  const proc = spawn('node', [BOARD_SRC], {
    env: { ...process.env, JUNKYARD_AGENTS: JSON.stringify({ a: 'same', b: 'same' }), JUNKYARD_PORT: '0' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let err = ''
  proc.stderr!.on('data', d => (err += d))
  const code = await new Promise<number | null>(r => proc.on('exit', r))
  assert.equal(code, 2)
  assert.match(err, /share a token/)
})

test('history is capped and unknown cursor replays a bounded tail', async () => {
  const small = await startBoard({ JUNKYARD_MAX_POSTS: '5' })
  try {
    for (let i = 0; i < 8; i++) await post(small, AGENTS.morgan, { type: 'status', body: `p${i}` })
    const seen = (await list(small, AGENTS.morgan, '?limit=100')).posts.map(p => p.body)
    assert.deepEqual(seen, ['p3', 'p4', 'p5', 'p6', 'p7'])

    const res = await fetch(`${small.url}/v1/events`, { headers: { authorization: `Bearer ${AGENTS['claude-a']}`, 'last-event-id': 'gone' } })
    const reader = res.body!.getReader()
    let text = ''
    const deadline = Date.now() + 1000
    while (Date.now() < deadline && !text.includes('p7')) {
      const { value, done } = await Promise.race([reader.read(), new Promise<{ value: undefined; done: true }>(r => setTimeout(() => r({ value: undefined, done: true }), 200))])
      if (done) break
      text += new TextDecoder().decode(value)
    }
    reader.cancel()
    const replayed = [...text.matchAll(/"body":"(p\d)"/g)].map(m => m[1])
    assert.deepEqual(replayed, ['p3', 'p4', 'p5', 'p6', 'p7'])
    assert.ok(small.log.some(l => l.includes('unknown cursor')))
  } finally {
    small.stop()
  }
})

test('a dead subscriber is dropped without affecting others', async () => {
  const dead = await fetch(`${board.url}/v1/events`, { headers: { authorization: `Bearer ${AGENTS['claude-a']}` } })
  await dead.body!.cancel()
  const live = await fetch(`${board.url}/v1/events`, { headers: { authorization: `Bearer ${AGENTS['claude-b']}` } })
  const reader = live.body!.getReader()
  await post(board, AGENTS.morgan, { type: 'status', body: 'still delivered' })
  let text = ''
  const deadline = Date.now() + 2000
  while (Date.now() < deadline && !text.includes('still delivered')) {
    const { value } = await reader.read()
    text += new TextDecoder().decode(value)
  }
  reader.cancel()
  assert.match(text, /still delivered/)
  const health = (await (await fetch(`${board.url}/v1/health`)).json()) as { subscribers: number }
  assert.ok(health.subscribers <= 1, `expected dead subscriber gone, saw ${health.subscribers}`)
})

test('posts and cursors survive a board restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'junkyard-db-'))
  const db = join(dir, 'board.sqlite')
  try {
    const first = await startBoard({ JUNKYARD_DB: db })
    const a = (await (await post(first, AGENTS.morgan, { type: 'task', body: 'before restart' })).json()) as { id: string }
    const b = (await (await post(first, AGENTS.morgan, { type: 'task', body: 'also before' })).json()) as { id: string }
    first.stop()
    await new Promise(r => first.proc.on('exit', r))

    const second = await startBoard({ JUNKYARD_DB: db })
    try {
      const all = await list(second, AGENTS.morgan)
      assert.deepEqual(all.posts.map(p => p.id), [a.id, b.id])

      // A known cursor replays exactly what follows it, not the bounded tail.
      const c = (await (await post(second, AGENTS.morgan, { type: 'task', body: 'after restart' })).json()) as { id: string; seq: number }
      assert.equal(c.seq, 3, 'sequence continues from the stored posts')
      const res = await fetch(`${second.url}/v1/events`, {
        headers: { authorization: `Bearer ${AGENTS['claude-a']}`, 'last-event-id': a.id },
      })
      const reader = res.body!.getReader()
      let text = ''
      while (!text.includes(c.id)) text += new TextDecoder().decode((await reader.read()).value)
      await reader.cancel()
      const ids = [...text.matchAll(/^id: (.+)$/gm)].map(m => m[1])
      assert.deepEqual(ids, [b.id, c.id])
      assert.ok(!second.log.some(l => l.includes('unknown cursor')))
    } finally {
      second.stop()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
