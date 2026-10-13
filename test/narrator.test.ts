import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CoreEvent, SelfModel } from '../src/core/types.ts'
import { Store } from '../src/memory/store.ts'
import { Narrator } from '../src/mind/narrator.ts'

test('efference copy stays balanced when a thought is interrupted', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      await Bun.sleep(300)
      if (req.signal.aborted) return new Response('aborted', { status: 499 })
      return Response.json({
        choices: [{ message: { content: '{"changes":[],"still":false,"still_for_s":null,"gap_s":null,"confidence":0.5,"note":""}' }, logprobs: { content: [{ logprob: -0.1 }] } }],
        usage: { completion_tokens: 1 },
      })
    },
  })
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'cv1-n-')), 'm.db'))
  let active = 0
  const narrator = new Narrator(`http://127.0.0.1:${server.port}`, store, (c, v) => {
    if (c === 'mind.active') active += v ? 1 : -1
  })
  const self: SelfModel = { instanceId: 'x', birthWall: 0, uptimeS: 1, tick: 1, mode: 'full', still: false, stillForS: 0, lastGapS: 0, body: {} }
  const ev = (salience: number): CoreEvent => ({ id: `e${salience}`, tick: 1, tWall: 1, kind: 'change', salience, decision: 'wake', rule: 'R6' })
  narrator.wake({ events: [ev(10)], self, recent: [] })
  await Bun.sleep(50)
  narrator.wake({ events: [ev(30)], self, recent: [] })
  await Bun.sleep(800)
  expect(active).toBe(0)
  const rows = store.db.query('SELECT status, interrupt_ms FROM thoughts ORDER BY id').all() as { status: string; interrupt_ms: number | null }[]
  expect(rows.map((r) => r.status).sort()).toEqual(['done', 'interrupted'])
  expect(rows.find((r) => r.status === 'interrupted')!.interrupt_ms).toBeLessThan(100)
  server.stop(true)
  store.close()
})
