import { loadConfig } from '../src/config.ts'
import { Core } from '../src/core/core.ts'
import type { CoreEvent, Latest, TickOut } from '../src/core/types.ts'
import { chat } from '../src/mind/llm.ts'
import { ask, renderFocus, renderFull, renderLevelOnly, renderSnapshots, type Snapshot, SYSTEM } from '../src/mind/prompt.ts'
import { ALL_CHANNELS } from '../src/senses/channels.ts'
import { type Background, Replay } from './lib.ts'

export type System = 'S' | 'L' | 'B1'
export const SYSTEMS: System[] = ['S', 'L', 'B1']
export const HEARTBEAT_S = 10

export class Rig {
  readonly cfg = loadConfig()
  readonly S: Core
  readonly L: Core
  readonly latest: Latest = new Map()
  readonly replay: Replay
  readonly snaps: Snapshot[] = []
  readonly events: { S: CoreEvent[]; L: CoreEvent[] } = { S: [], L: [] }
  readonly names = ALL_CHANNELS.map((c) => c.name)
  t = 0
  k = 0
  readonly wall0 = Date.UTC(2026, 9, 1) / 1000
  private wallOffset = 0
  private nextBeat: number
  lastOut: TickOut | null = null

  constructor(bg: Background, seed: number) {
    const id = { instanceId: `bench-${seed}`, birthWall: this.wall0 }
    this.S = new Core(ALL_CHANNELS, loadConfig({ mode: 'full' }), id)
    this.L = new Core(ALL_CHANNELS, loadConfig({ mode: 'no-delta' }), id)
    this.replay = new Replay(bg, Math.floor((seed * 7919) % bg.frames.length))
    this.nextBeat = HEARTBEAT_S * ((seed % 10) / 10)
  }

  get wall() {
    return this.wall0 + this.t + this.wallOffset
  }

  tick(test: number | null, opts: { hold?: boolean } = {}) {
    this.k++
    this.t = this.k / this.cfg.tickHz
    if (opts.hold) {
      for (const [c, r] of this.latest) this.latest.set(c, { value: r.value, t: this.t })
      this.replay.shift(1 / this.cfg.tickHz)
    } else {
      this.replay.advance(this.t, this.latest)
      if (test !== null) this.latest.set('test.a', { value: test, t: this.t })
    }
    const s = this.S.step(this.latest, this.t, this.wall)
    const l = this.L.step(this.latest, this.t, this.wall)
    this.events.S.push(...s.events)
    this.events.L.push(...l.events)
    this.lastOut = s
    if (this.t >= this.nextBeat) {
      this.nextBeat += HEARTBEAT_S
      this.snaps.push(this.snapshot())
      if (this.snaps.length > 60) this.snaps.shift()
    }
    return s
  }

  suspend(seconds: number) {
    this.k += Math.round(seconds * this.cfg.tickHz)
    this.replay.shift(seconds)
    this.nextBeat = this.k / this.cfg.tickHz + HEARTBEAT_S
  }

  private snapshot(): Snapshot {
    const stale: string[] = []
    const values = new Float32Array(this.names.length)
    this.names.forEach((n, i) => {
      const r = this.latest.get(n)
      values[i] = r?.value ?? Number.NaN
      const def = ALL_CHANNELS[i]!
      if (r && this.t - r.t > this.cfg.staleFactor * def.periodS) stale.push(`${n} (${(this.t - r.t).toFixed(1)}s)`)
    })
    return { tWall: this.wall, values, stale }
  }

  context(sys: System, windowS: number, focus?: string) {
    const now = this.wall
    if (focus) {
      if (sys === 'S') return renderFocus('S', this.S.selfModel(now), this.S.recent, focus, now, windowS)
      if (sys === 'L') return renderFocus('L', this.L.selfModel(now), this.L.recent, focus, now, windowS)
      const i = this.names.indexOf(focus)
      const snaps = [...this.snaps.filter((s) => now - s.tWall <= windowS), this.snapshot()]
        .map((s) => ({ tWall: s.tWall, values: [s.values[i] ?? Number.NaN], stale: s.stale.filter((x) => x.startsWith(focus)) }))
      return renderSnapshots([focus], snaps, now)
    }
    if (sys === 'S') return renderFull(this.S.selfModel(now), this.S.recent, now, windowS)
    if (sys === 'L') return renderLevelOnly(this.L.selfModel(now), this.L.recent, now, windowS)
    const seen = this.names.map((n) => this.latest.has(n))
    const keep = (v: ArrayLike<number>) => Array.from(v).filter((_, i) => seen[i])
    const names = this.names.filter((_, i) => seen[i])
    const snaps = [...this.snaps.filter((s) => now - s.tWall <= windowS), this.snapshot()].map((s) => ({ ...s, values: keep(s.values) }))
    return renderSnapshots(names, snaps, now)
  }
}

export const probe = async <T>(url: string, rig: Rig, sys: System, question: string, windowS: number, seed: number, schema: object, focus?: string) => {
  const prompt = ask(rig.context(sys, windowS, focus), question)
  const r = await chat({ url, system: SYSTEM, user: prompt, schema, seed, temperature: 0, maxTokens: 300 }).catch((e: Error) => e)
  if (r instanceof Error) {
    console.error(`probe ${sys} failed: ${r.message.slice(0, 200)}`)
    return { report: null as T | null, raw: '', tokens: 0, ms: 0, meanLogprob: Number.NaN, promptChars: prompt.length, error: r.message.slice(0, 200) }
  }
  if (process.env.CV1_DEBUG) console.log(`----- ${sys} prompt\n${prompt}\n----- output\n${r.content}`)
  return { report: r.json as T | null, raw: r.content, tokens: r.tokens, ms: r.ms, meanLogprob: r.meanLogprob, promptChars: prompt.length }
}
