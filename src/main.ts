import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './config.ts'
import { enforceRetention, frameBytes } from './memory/segments.ts'
import { ALL_CHANNELS } from './senses/channels.ts'
import { Store } from './memory/store.ts'
import { Narrator, type Wake } from './mind/narrator.ts'
import { chat } from './mind/llm.ts'
import { ask, CHANNEL_SCHEMA, renderFocus, SYSTEM } from './mind/prompt.ts'
import type { CoreEvent, SelfModel } from './core/types.ts'

const cfg = loadConfig()
mkdirSync(cfg.dataDir, { recursive: true })

const idPath = join(cfg.dataDir, 'identity.json')
const identity = existsSync(idPath)
  ? (JSON.parse(readFileSync(idPath, 'utf8')) as { instanceId: string; birthWall: number })
  : { instanceId: crypto.randomUUID(), birthWall: Date.now() / 1000 }
writeFileSync(idPath, JSON.stringify(identity))

const store = new Store(join(cfg.dataDir, 'mind.db'))
const worker = new Worker(new URL('./core/worker.ts', import.meta.url))
const sense = (channel: string, value: number) => worker.postMessage({ type: 'reading', channel, value })
let thinking = 0
const thought = (delta: number) => {
  thinking = Math.max(0, thinking + delta)
  sense('mind.active', thinking)
}
const narratorSense = (channel: string, value: number) => (channel === 'mind.active' ? thought(value ? 1 : -1) : sense(channel, value))
const narrator = cfg.llmUrl && cfg.narrator ? new Narrator(cfg.llmUrl, store, narratorSense) : null

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a)
const ticksDir = join(cfg.dataDir, 'ticks')
const size = (p: string) => (existsSync(p) ? statSync(p).size : 0)
const frameSize = frameBytes(ALL_CHANNELS.length)
const dbSize = () => size(join(cfg.dataDir, 'mind.db'))
const storage = () => {
  const closed = existsSync(ticksDir)
    ? [...new Bun.Glob('*.bin.zst').scanSync(ticksDir)].filter((f) => !existsSync(join(ticksDir, f.replace('.bin.zst', '.ds')))).sort()
    : []
  const last = closed.at(-1)
  let ratio: number | null = null
  if (last) {
    const m = JSON.parse(readFileSync(join(ticksDir, last.replace('.bin.zst', '.json')), 'utf8')) as { rawBytes?: number; zstBytes?: number }
    ratio = m.rawBytes ? m.zstBytes! / m.rawBytes : null
  }
  const raw = cfg.tickHz * frameSize * 86400
  const elapsed = Date.now() / 1000 - startWall
  const db = elapsed > 0 ? ((dbSize() - startDb) / elapsed) * 86400 : 0
  return { rawMBd: raw / 1e6, compressedMBd: ratio === null ? null : (raw * ratio) / 1e6, ratio, dbMBd: db / 1e6, walMB: size(join(cfg.dataDir, 'mind.db-wal')) / 1e6 }
}
const fmtStorage = (x: ReturnType<typeof storage>) =>
  `ticks raw ${x.rawMBd.toFixed(1)} MB/day, compressed ${x.compressedMBd === null ? 'n/a' : `${x.compressedMBd.toFixed(1)} MB/day (ratio ${x.ratio!.toFixed(3)})`}, db +${x.dbMBd.toFixed(1)} MB/day, wal ${x.walMB.toFixed(1)} MB`
const startDb = dbSize()
const startWall = Date.now() / 1000
let segment = ''

const pending = new Map<number, (s: { self: SelfModel; recent: CoreEvent[]; tWall: number }) => void>()
let snapId = 0
const snapshot = () =>
  new Promise<{ self: SelfModel; recent: CoreEvent[]; tWall: number }>((resolve) => {
    const id = ++snapId
    pending.set(id, resolve)
    worker.postMessage({ type: 'snapshot', id })
  })

const askPort = Number(process.env.CV1_ASK_PORT ?? 8093)
if (askPort && cfg.llmUrl) {
  Bun.serve({
    hostname: '127.0.0.1',
    port: askPort,
    fetch: async (req) => {
      const u = new URL(req.url)
      if (u.pathname === '/inject' && req.method === 'POST') {
        const channel = u.searchParams.get('channel') ?? ''
        const value = Number(u.searchParams.get('value'))
        if (!channel.startsWith('test.') || !Number.isFinite(value)) return new Response('bad channel or value', { status: 400 })
        sense(channel, value)
        return new Response('ok')
      }
      if (u.pathname !== '/ask') return new Response('not found', { status: 404 })
      const channel = u.searchParams.get('channel') ?? ''
      const windowS = Number(u.searchParams.get('window') ?? 90)
      thought(1)
      const snap = await snapshot()
      const prompt = ask(renderFocus('S', snap.self, snap.recent, channel, snap.tWall, windowS),
        `What happened to channel ${channel} during the last ${windowS} seconds? List each change of ${channel} in "changes"; seconds_ago is when the change began. Return an empty list if it did not change beyond its normal noise.`)
      const r = await chat({ url: cfg.llmUrl, system: SYSTEM, user: prompt, schema: CHANNEL_SCHEMA, temperature: 0, maxTokens: 300 })
        .catch((e: Error) => e)
        .finally(() => thought(-1))
      if (r instanceof Error) return Response.json({ error: r.message }, { status: 502 })
      return Response.json({ tWall: snap.tWall, report: r.json, prompt })
    },
  })
}

worker.onmessage = (ev: MessageEvent) => {
  const m = ev.data
  if (m.type === 'snapshot') {
    pending.get(m.id)?.(m)
    pending.delete(m.id)
  }
  if (m.type === 'wake') narrator?.wake(m as Wake)
  if (m.type === 'continuity') log('continuity', JSON.stringify(m.continuity))
  if (m.type === 'stats') {
    segment = m.segment
    log(`ticks=${m.ticks} overruns=${m.overruns} missed=${m.missed} tick_ms p50=${m.p50.toFixed(3)} p99=${m.p99.toFixed(3)} max=${m.max.toFixed(3)}`)
    if (m.ticks % (cfg.tickHz * 600) < cfg.tickHz * 10) log(`storage: ${fmtStorage(chore(storage))}`)
  }
  if (m.type === 'stopped') {
    worker.terminate()
    store.close()
    process.exit(0)
  }
}
worker.onerror = (e) => {
  log('worker error', e.message)
  process.exit(1)
}
worker.postMessage({ type: 'init', cfg, identity })

let expected = performance.now() + 500
setInterval(() => {
  const now = performance.now()
  sense('self.main_lag_ms', Math.max(0, now - expected))
  expected = now + 500
}, 500)

let chores = 0
const chore = <T>(fn: () => T): T => {
  sense('self.housekeeping', ++chores)
  try {
    return fn()
  } finally {
    sense('self.housekeeping', --chores)
  }
}

const retention = () => chore(() => {
  const r = enforceRetention(ticksDir, {
    currentKey: segment, fullDays: cfg.retentionFullDays, downsampledDays: cfg.retentionDownsampledDays,
    nowWall: Date.now() / 1000, tickHz: cfg.tickHz,
  })
  const now = Date.now() / 1000
  const ev = store.db.query('DELETE FROM events WHERE t_wall < ?').run(now - cfg.retentionDownsampledDays * 86400).changes
  const th = store.db.query('UPDATE thoughts SET prompt = NULL WHERE prompt IS NOT NULL AND t_start < ?').run(now - cfg.retentionFullDays * 86400).changes
  if (r.compressed.length || r.downsampled.length || r.deleted.length || ev || th) log('retention', JSON.stringify({ ...r, eventsDeleted: ev, promptsDropped: th }))
  if (process.env.CV1_HOUSEKEEPING_S) log(`storage: ${fmtStorage(storage())}`)
})
setTimeout(retention, 5000)
setInterval(retention, cfg.housekeepingEveryS * 1000)

setTimeout(() => {
  const st = storage()
  store.db.query('INSERT INTO runs (t_start, t_end, info) VALUES (?,?,?)').run(startWall, Date.now() / 1000, JSON.stringify({ storageFirstHour: st }))
  log(`first-hour storage: ${fmtStorage(st)}`)
}, 60 * 60 * 1000)

const shutdown = () => worker.postMessage({ type: 'stop' })
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
log(`started instance=${identity.instanceId.slice(0, 8)} mode=${cfg.mode} tick=${cfg.tickHz}Hz narrator=${narrator ? 'on' : 'off'}`)
