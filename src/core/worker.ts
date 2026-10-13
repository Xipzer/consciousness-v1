declare var self: Worker

import { join } from 'node:path'
import type { Config } from '../config.ts'
import { startBrainSensor, startGpuSensor, startProcSensors } from '../senses/body.ts'
import { ALL_CHANNELS } from '../senses/channels.ts'
import { SegmentWriter } from '../memory/segments.ts'
import { Store } from '../memory/store.ts'
import { assessContinuity } from './continuity.ts'
import { Core } from './core.ts'
import type { Latest } from './types.ts'

export type ToWorker =
  | { type: 'init'; cfg: Config; identity: { instanceId: string; birthWall: number } }
  | { type: 'reading'; channel: string; value: number }
  | { type: 'stop' }
  | { type: 'snapshot'; id: number }
  | { type: 'pulse'; channel: string }

const wallNow = () => Date.now() / 1000
const monoNow = () => performance.now() / 1000

const latest: Latest = new Map()

const run = (cfg: Config, identity: { instanceId: string; birthWall: number }) => {
  const core = new Core(ALL_CHANNELS, cfg, identity)
  const store = new Store(join(cfg.dataDir, 'mind.db'))
  const writer = new SegmentWriter(join(cfg.dataDir, 'ticks'), ALL_CHANNELS.map((c) => c.name))
  const priorChain = store.chain()
  const stops = [startProcSensors(latest), startGpuSensor(latest), cfg.llmUrl ? startBrainSensor(latest, cfg.llmUrl) : () => {}]

  const period = 1 / cfg.tickHz
  const t0 = monoNow()
  let k = 0
  let lastMs = 0
  let overruns = 0
  let missed = 0
  let durations: number[] = []
  let lastChain = t0
  let lastFlush = t0
  let continuityDone = false
  let stopped = false

  const loop = () => {
    if (stopped) return
    const start = monoNow()
    latest.set('self.tick_ms', { value: lastMs, t: start })
    const out = core.step(latest, start, wallNow())
    if (out.events.length) store.insertEvents(out.events)
    writer.push(out, lastMs)
    if (out.wake) self.postMessage({ type: 'wake', events: out.wake, self: core.selfModel(out.tWall), recent: core.recent.slice(-40) })
    if (start - lastFlush >= 1) {
      writer.flush()
      lastFlush = start
    }
    if (start - lastChain >= cfg.chainEveryS) {
      store.appendLink({ tWall: out.tWall, tick: out.tick, kind: 'tick', slow: core.slowVector(), raw: core.rawVector(), sigma: core.sigmaVector() })
      lastChain = start
    }
    if (!continuityDone && start - t0 >= 15) {
      continuityDone = true
      const c = assessContinuity(priorChain, out.tWall, core.slowVector(), core.rawVector(), ALL_CHANNELS, start - t0)
      store.db.query('INSERT INTO runs (t_start, info) VALUES (?, ?)').run(out.tWall, JSON.stringify({ continuity: c, mode: cfg.mode, tickHz: cfg.tickHz }))
      self.postMessage({ type: 'continuity', continuity: c })
    }

    const end = monoNow()
    lastMs = (end - start) * 1000
    durations.push(lastMs)
    if (lastMs > period * 1000) overruns++
    if (durations.length >= cfg.tickHz * 10) {
      const sorted = [...durations].sort((a, b) => a - b)
      self.postMessage({
        type: 'stats', ticks: out.tick, overruns, missed, p50: sorted[sorted.length >> 1], p99: sorted[Math.floor(sorted.length * 0.99)],
        max: sorted[sorted.length - 1], segment: writer.currentKey,
      })
      durations = []
    }
    k++
    let next = t0 + k * period
    if (end > next + period) {
      const skip = Math.floor((end - next) / period)
      missed += skip
      k += skip
      next = t0 + k * period
    }
    setTimeout(loop, Math.max(0, (next - monoNow()) * 1000))
  }
  setTimeout(loop, 0)

  pulse = (channel: string) => core.pulse(channel, monoNow())
  snapshot = (id: number) => {
    const w = wallNow()
    self.postMessage({ type: 'snapshot', id, self: core.selfModel(w), recent: core.recent.slice(), tWall: w })
  }

  return () => {
    stopped = true
    stops.forEach((s) => s())
    store.appendLink({ tWall: wallNow(), tick: core.selfModel(wallNow()).tick, kind: 'shutdown', slow: core.slowVector(), raw: core.rawVector(), sigma: core.sigmaVector() })
    writer.flush()
    store.close()
  }
}

let stop: (() => void) | null = null
let snapshot: ((id: number) => void) | null = null
let pulse: ((channel: string) => void) | null = null

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data
  if (m.type === 'init') {
    stop = run(m.cfg, m.identity)
    return
  }
  if (m.type === 'reading') {
    latest.set(m.channel, { value: m.value, t: monoNow() })
    return
  }
  if (m.type === 'pulse') {
    pulse?.(m.channel)
    return
  }
  if (m.type === 'snapshot') {
    snapshot?.(m.id)
    return
  }
  if (m.type === 'stop') {
    stop?.()
    self.postMessage({ type: 'stopped' })
  }
}
