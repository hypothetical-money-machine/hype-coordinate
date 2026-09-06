import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { BOARD_SRC, CHANNEL_SRC } from './helpers.ts'

// Both servers carry their own copy of canonical(). Until there is a shared
// package, pin them to each other so a change to one fails here.
function extract(src: string): string {
  const m = /function canonical\(value: unknown\): string \{[\s\S]*?\n\}/.exec(readFileSync(src, 'utf8'))
  assert.ok(m, `canonical() not found in ${src}`)
  return m[0]
}

async function load(src: string): Promise<(v: unknown) => string> {
  const body = stripTypeScriptTypes(extract(src)).replace(/^function canonical/, 'return function canonical')
  return new Function(body + '\n')() as (v: unknown) => string
}

test('canonical() produces identical bytes in board and channel', async () => {
  const a = await load(BOARD_SRC)
  const b = await load(CHANNEL_SRC)
  const cases: unknown[] = [
    { z: 1, a: 'x', m: [3, { q: null, p: undefined }], u: undefined },
    { id: 'i', seq: 2, ts: 't', from: 'f', type: 'task', body: 'b\n"q"', thread: 'i', priority: 'normal' },
    { to: 'x', id: 'i' },
    [],
    'str',
    null,
  ]
  for (const c of cases) assert.equal(a(c), b(c), `mismatch for ${JSON.stringify(c)}`)
  assert.equal(a({ b: 1, a: { d: 2, c: undefined } }), '{"a":{"d":2},"b":1}')
})
