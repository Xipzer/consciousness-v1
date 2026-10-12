import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './config.ts'
import { enforceRetention } from './memory/segments.ts'
import { Store } from './memory/store.ts'
import { Narrator, type Wake } from './mind/narrator.ts'

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
const narrator = cfg.llmUrl && cfg.narrator ? new Narrator(cfg.llmUrl, store, sense) : null

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a)
const ticksDir = join(cfg.dataDir, 'ticks')
const dirBytes = () => {
  let b = 0
  for (const f of existsSync(ticksDir) ? new Bun.Glob('*').scanSync(ticksDir) : []) b += statSync(join(ticksDir, f)).size
  for (const f of ['mind.db', 'mind.db-wal']) if (existsSync(join(cfg.dataDir, f))) b += statSync(join(cfg.dataDir, f)).size
  return b
}
const startBytes = dirBytes()
const startWall = Date.now() / 1000
let segment = ''

worker.onmessage = (ev: MessageEvent) => {
  const m = ev.data
  if (m.type === 'wake') narrator?.wake(m as Wake)
  if (m.type === 'continuity') log('continuity', JSON.stringify(m.continuity))
  if (m.type === 'stats') {
    segment = m.segment
    const elapsed = Date.now() / 1000 - startWall
    const perDay = ((dirBytes() - startBytes) / elapsed) * 86400
    log(`ticks=${m.ticks} overruns=${m.overruns} missed=${m.missed} tick_ms p50=${m.p50.toFixed(3)} p99=${m.p99.toFixed(3)} max=${m.max.toFixed(3)} bytes/day≈${(perDay / 1e6).toFixed(1)}MB`)
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

const retention = () => {
  const r = enforceRetention(ticksDir, {
    currentKey: segment, fullDays: cfg.retentionFullDays, downsampledDays: cfg.retentionDownsampledDays,
    nowWall: Date.now() / 1000, tickHz: cfg.tickHz,
  })
  if (r.compressed.length || r.downsampled.length || r.deleted.length) log('retention', JSON.stringify(r))
}
setTimeout(retention, 5000)
setInterval(retention, 10 * 60 * 1000)

setTimeout(() => {
  const elapsed = Date.now() / 1000 - startWall
  const perDay = ((dirBytes() - startBytes) / elapsed) * 86400
  store.db.query('INSERT INTO runs (t_start, t_end, info) VALUES (?,?,?)').run(startWall, Date.now() / 1000, JSON.stringify({ bytesPerDayFirstHour: perDay }))
  log(`first-hour storage: ${(perDay / 1e6).toFixed(1)} MB/day (uncompressed current segment + db)`)
}, 60 * 60 * 1000)

const shutdown = () => worker.postMessage({ type: 'stop' })
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
log(`started instance=${identity.instanceId.slice(0, 8)} mode=${cfg.mode} tick=${cfg.tickHz}Hz narrator=${narrator ? 'on' : 'off'}`)
