import { describe, expect, test } from 'bun:test'
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, type Mode } from '../src/config.ts'
import { assessContinuity, verifyChain } from '../src/core/continuity.ts'
import { Core } from '../src/core/core.ts'
import type { ChannelDef, CoreEvent, Latest } from '../src/core/types.ts'
import { enforceRetention, readSegment, SegmentWriter } from '../src/memory/segments.ts'
import { Store } from '../src/memory/store.ts'

const CH: ChannelDef[] = [{ name: 'test.a', unit: 'u', periodS: 0.1, minSigma: 0.01 }]

const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r())

const sim = (mode: Mode, signal: (t: number) => number | null, seconds: number, seed = 1) => {
  const cfg = loadConfig({ mode })
  const core = new Core(CH, cfg, { instanceId: 'test-instance', birthWall: 0 })
  const r = rng(seed)
  const latest: Latest = new Map()
  const events: CoreEvent[] = []
  const changes: number[] = []
  for (let k = 0; k < seconds * cfg.tickHz; k++) {
    const t = k / cfg.tickHz
    const v = signal(t)
    if (v !== null) latest.set('test.a', { value: v + gauss(r), t })
    const out = core.step(latest, t, 1e9 + t)
    events.push(...out.events)
    changes.push(out.change)
  }
  return { core, events, changes }
}

const changeEvents = (evs: CoreEvent[], from: number) => evs.filter((e) => e.kind === 'change' && e.tWall - 1e9 >= from)

describe('core motion layer', () => {
  test('detects a small 2.5 sigma step within 2 s', () => {
    const step = (t: number) => (t >= 120 ? 2.5 : 0)
    const full = changeEvents(sim('full', step, 140).events, 120)
    expect(full.length).toBeGreaterThan(0)
    expect(full[0]!.tWall - 1e9 - 120).toBeLessThan(2)
    expect(full[0]!.direction).toBe(1)
    expect(changeEvents(sim('no-delta', step, 140).events, 120).every((e) => e.timescale === undefined)).toBe(true)
  })

  test('false alarms on pure noise stay rare', () => {
    const quiet = changeEvents(sim('full', () => 0, 600, 7).events, 60)
    expect(quiet.length).toBeLessThanOrEqual(2)
  })

  test('detects a 1 s pulse', () => {
    const pulse = (t: number) => (t >= 120 && t < 121 ? -2.5 : 0)
    const evs = changeEvents(sim('full', pulse, 140).events, 120)
    expect(evs.some((e) => e.direction === -1)).toBe(true)
  })

  test('freeze: change measure is exactly zero, stillness is flagged and the gap length is reported', () => {
    const r = rng(3)
    const cfg = loadConfig()
    const core = new Core(CH, cfg, { instanceId: 'x', birthWall: 0 })
    const latest: Latest = new Map()
    const events: CoreEvent[] = []
    let frozen = 0
    for (let k = 0; k < 2400; k++) {
      const t = k / 10
      const inFreeze = t >= 100 && t < 160
      if (!inFreeze) frozen = gauss(r)
      latest.set('test.a', { value: frozen, t })
      const out = core.step(latest, t, 1e9 + t)
      events.push(...out.events)
      if (t >= 100.2 && t < 160) expect(out.change).toBe(0)
      if (t === 130) expect(core.selfModel(1e9 + t).still).toBe(true)
    }
    const moved = events.find((e) => e.kind === 'moved')
    expect(moved?.durationS).toBeGreaterThan(59)
    expect(moved?.durationS).toBeLessThan(61)
  })

  test('suspension: a clock jump becomes a gap event with its length', () => {
    const cfg = loadConfig()
    const core = new Core(CH, cfg, { instanceId: 'x', birthWall: 0 })
    const latest: Latest = new Map([['test.a', { value: 0, t: 0 }]])
    core.step(latest, 0, 1e9)
    const out = core.step(latest, 300, 1e9 + 300)
    expect(out.events.find((e) => e.kind === 'gap')?.durationS).toBe(300)
  })
})

describe('memory', () => {
  test('chain detects tampering and continuity uses host uptime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cv1-'))
    const store = new Store(join(dir, 'm.db'))
    const chans: ChannelDef[] = [
      { name: 'body.x', unit: 'u', periodS: 1, minSigma: 0.1 },
      { name: 'body.host.uptime', unit: 's', periodS: 1, minSigma: 0.01, excludeFromChange: true },
    ]
    for (let i = 0; i < 5; i++) store.appendLink({ tWall: 1000 + i * 10, tick: i, kind: 'tick', slow: [1, 0], raw: [1, 500 + i * 10], sigma: [0.1, 0] })
    const links = store.chain()
    expect(verifyChain(links)).toBe(true)
    expect(assessContinuity(links, 1100, [1.05, 0], [1, 600], chans).verdict).toBe('continuous')
    expect(assessContinuity(links, 1100, [1.05, 0], [1, 9000], chans).verdict).toBe('discontinuous')
    expect(assessContinuity(links, 1100, [5, 0], [1, 600], chans).verdict).toBe('discontinuous')
    const bad = links.map((l, i) => (i === 2 ? { ...l, raw: [1, 999] } : l))
    expect(assessContinuity(bad, 1100, [1.05, 0], [1, 600], chans).verdict).toBe('tampered')
    store.close()
  })

  test('segments round-trip and retention compresses, downsamples and deletes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cv1-seg-'))
    const w = new SegmentWriter(dir, ['a', 'b'])
    const base = Date.UTC(2026, 0, 1, 0) / 1000
    for (let i = 0; i < 50; i++) {
      w.push({ tick: i, tMono: i / 10, tWall: base + i / 10, values: new Float32Array([i, -i]), ages: new Float32Array([0, 0.1]), change: 0, maxSalience: 0, events: [], wake: null }, 0.1)
    }
    w.flush()
    const seg = readSegment(dir, '2026010100')
    expect(seg.frames.length).toBe(50)
    expect(seg.frames[49]!.values[1]).toBe(-49)
    const opts = { currentKey: 'none', fullDays: 7, downsampledDays: 90, tickHz: 10 }
    expect(enforceRetention(dir, { ...opts, nowWall: base + 86400 }).compressed).toEqual(['2026010100'])
    expect(readSegment(dir, '2026010100').frames.length).toBe(50)
    expect(enforceRetention(dir, { ...opts, nowWall: base + 8 * 86400 }).downsampled).toEqual(['2026010100'])
    expect(readSegment(dir, '2026010100').frames.length).toBe(5)
    expect(enforceRetention(dir, { ...opts, nowWall: base + 91 * 86400 }).deleted).toEqual(['2026010100'])
    expect(existsSync(join(dir, '2026010100.json'))).toBe(false)
    writeFileSync(join(dir, 'unused'), '')
  })
})
