import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startBoard } from './helpers.ts'

test('welcome flow serves its local links and assets while board data still requires auth', async () => {
  const board = await startBoard()
  try {
    for (const route of ['/', '/getting-started', '/getting-started/']) {
      const response = await fetch(board.url + route)
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type')!, /text\/html/)
      const html = await response.text()
      for (const [, path] of html.matchAll(/(?:href|src)="(\/[^"#]*)"/g)) {
        assert.equal((await fetch(board.url + path)).status, 200, path)
      }
      const head = await fetch(board.url + route, { method: 'HEAD' })
      assert.equal(head.status, 200)
      assert.equal(await head.text(), '')
      assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(html)))
    }
    assert.equal((await fetch(board.url + '/v1/posts')).status, 401)
    assert.equal((await fetch(board.url + '/server.ts')).status, 404)
    assert.equal((await fetch(board.url + '/', { method: 'POST' })).status, 404)
    assert.match((await fetch(board.url + '/guide.js')).headers.get('content-type')!, /javascript/)
    assert.match((await fetch(board.url + '/styles.css')).headers.get('content-type')!, /text\/css/)
  } finally {
    board.stop()
  }
})
