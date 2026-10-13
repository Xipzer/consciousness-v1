import { describe, expect, test } from 'bun:test'
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Config, loadConfig, type Mode } from '../src/config.ts'
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

describe('attention policy', () => {
  test('compresses extreme surprise and applies configured relevance', () => {
    const channel: ChannelDef = { name: 'sense.x', unit: 'u', periodS: 1, minSigma: 1, discrete: true, attentionGain: 2 }
    const event = (salienceCompression: boolean, attentionPolicy = true) => {
      const core = new Core([channel], loadConfig({ salienceCompression, attentionPolicy }), { instanceId: 'x', birthWall: 0 })
      const latest: Latest = new Map([['sense.x', { value: 0, t: 0 }]])
      core.step(latest, 0, 1e9)
      latest.set('sense.x', { value: 100, t: 1 })
      return core.step(latest, 1, 1e9 + 1).events.find((e) => e.channel === 'sense.x')!
    }
    expect(event(true).salience).toBeCloseTo(2 * (4 + 4 * Math.log2(25)))
    expect(event(true, false).salience).toBeCloseTo(4 + 4 * Math.log2(25))
    expect(event(false).salience).toBe(200)
  })
})

describe('corollary discharge', () => {
  const chans: ChannelDef[] = [
    { name: 'body.gpu.util', unit: '%', periodS: 0.1, minSigma: 1 },
    { name: 'body.cpu.load', unit: 'frac', periodS: 0.1, minSigma: 0.01 },
    { name: 'mind.active', unit: 'n', periodS: 3600, minSigma: 0.5 },
    { name: 'brain.busy_slots', unit: 'n', periodS: 0.1, minSigma: 0.5 },
  ]
  const run = (efference: boolean, thinkFrom: number, thinkTo: number, busyExtra = 0) => {
    const core = new Core(chans, loadConfig({ efference }), { instanceId: 'x', birthWall: 0 })
    const r = rng(9)
    const latest: Latest = new Map()
    const events: CoreEvent[] = []
    for (let k = 0; k < 1800; k++) {
      const t = k / 10
      const thinking = t >= thinkFrom && t < thinkTo
      latest.set('body.gpu.util', { value: (thinking ? 60 : 2) + gauss(r), t })
      latest.set('body.cpu.load', { value: (t >= 150 && t < 160 ? 0.5 : 0.05) + 0.01 * gauss(r), t })
      latest.set('brain.busy_slots', { value: (thinking ? 1 : 0) + busyExtra * (thinking ? 1 : 0), t })
      if (k === Math.round(thinkFrom * 10)) latest.set('mind.active', { value: 1, t })
      if (k === Math.round(thinkTo * 10)) latest.set('mind.active', { value: 0, t })
      events.push(...core.step(latest, t, 1e9 + t).events)
    }
    return events
  }

  test('self-caused GPU and slot changes are attributed and cannot wake; they stay in history', () => {
    const on = run(true, 100, 110).filter((e) => e.channel === 'body.gpu.util' || e.channel === 'brain.busy_slots')
    expect(on.length).toBeGreaterThan(0)
    expect(on.every((e) => e.attribution === 'self' && e.decision !== 'wake')).toBe(true)
    const off = run(false, 100, 110).filter((e) => e.channel === 'body.gpu.util')
    expect(off.some((e) => e.decision === 'wake')).toBe(true)
  })

  test('external changes stay unattributed, even during a thought', () => {
    const cpu = run(true, 145, 165).filter((e) => e.channel === 'body.cpu.load')
    expect(cpu.length).toBeGreaterThan(0)
    expect(cpu.every((e) => e.attribution === undefined)).toBe(true)
  })

  test('brain load beyond own threads is treated as external', () => {
    const slots = run(true, 100, 110, 1).filter((e) => e.channel === 'brain.busy_slots')
    expect(slots.some((e) => e.attribution === undefined)).toBe(true)
  })
})

test('housekeeping efference attributes main-loop lag only while chores run', () => {
  const chans: ChannelDef[] = [
    { name: 'self.main_lag_ms', unit: 'ms', periodS: 0.5, minSigma: 0.2 },
    { name: 'self.housekeeping', unit: 'n', periodS: 3600, minSigma: 0.5 },
  ]
  const run = (on: boolean, choreAt: number | null, spikeAt: number) => {
    const core = new Core(chans, loadConfig({ efferenceHousekeeping: on }), { instanceId: 'x', birthWall: 0 })
    const r = rng(4)
    const latest: Latest = new Map()
    const events: CoreEvent[] = []
    for (let k = 0; k < 1800; k++) {
      const t = k / 10
      if (k % 5 === 0) latest.set('self.main_lag_ms', { value: (t >= spikeAt + 0.2 && t < spikeAt + 1.2 ? 40 : 0.4) + 0.05 * gauss(r), t })
      if (choreAt !== null && k === choreAt * 10) latest.set('self.housekeeping', { value: 1, t })
      if (choreAt !== null && k === choreAt * 10 + 5) latest.set('self.housekeeping', { value: 0, t })
      events.push(...core.step(latest, t, 1e9 + t).events)
    }
    return events.filter((e) => e.channel === 'self.main_lag_ms' && e.tWall - 1e9 >= spikeAt - 1)
  }
  expect(run(true, 120, 120).every((e) => e.attribution === 'self')).toBe(true)
  expect(run(false, 120, 120).some((e) => e.attribution === undefined && e.decision === 'wake')).toBe(true)
  expect(run(true, 60, 150).some((e) => e.attribution === undefined)).toBe(true)
})

test('a housekeeping pulse (synchronous chore) opens the attribution window', () => {
  const chans: ChannelDef[] = [{ name: 'self.main_lag_ms', unit: 'ms', periodS: 0.5, minSigma: 0.2 }]
  const run = (pulse: boolean) => {
    const core = new Core(chans, loadConfig(), { instanceId: 'x', birthWall: 0 })
    const r = rng(4)
    const latest: Latest = new Map()
    const events: CoreEvent[] = []
    for (let k = 0; k < 1800; k++) {
      const t = k / 10
      if (pulse && k === 1200) core.pulse('self.housekeeping', t)
      if (k % 5 === 0) latest.set('self.main_lag_ms', { value: (t >= 120.4 && t < 121.4 ? 40 : 0.4) + 0.05 * gauss(r), t })
      events.push(...core.step(latest, t, 1e9 + t).events)
    }
    return events.filter((e) => e.channel === 'self.main_lag_ms' && e.tWall - 1e9 >= 120)
  }
  expect(run(true).every((e) => e.attribution === 'self' && e.decision !== 'wake')).toBe(true)
  expect(run(false).some((e) => e.decision === 'wake')).toBe(true)
})

test('discrete channels: every value change is an event; self-caused ones stay noticed', () => {
  const chans: ChannelDef[] = [
    { name: 'brain.busy_slots', unit: 'n', periodS: 1, minSigma: 0.5, discrete: true },
    { name: 'mind.active', unit: 'n', periodS: 3600, minSigma: 0.5, discrete: true },
  ]
  const run = (cfg: Partial<Config>) => {
    const core = new Core(chans, loadConfig(cfg), { instanceId: 'x', birthWall: 0 })
    const latest: Latest = new Map()
    const events: CoreEvent[] = []
    for (let k = 0; k < 2000; k++) {
      const t = k / 10
      const thinking = t >= 150 && t < 154
      if (k % 10 === 0) latest.set('brain.busy_slots', { value: thinking ? 1 : 0, t })
      if (k === 1500) latest.set('mind.active', { value: 1, t })
      if (k === 1540) latest.set('mind.active', { value: 0, t })
      events.push(...core.step(latest, t, 1e9 + t).events.filter((e) => e.channel === 'brain.busy_slots'))
    }
    return events.filter((e) => e.decision !== 'ignore')
  }
  const full = run({})
  expect(full.map((e) => [e.direction, Math.round(e.tWall - 1e9)])).toEqual([[1, 150], [-1, 154]])
  expect(full.every((e) => e.attribution === 'self' && e.decision === 'log')).toBe(true)
  expect(run({ noticeFloor: false }).length).toBe(0)
  expect(run({ discreteDetector: false, efference: false }).length).toBeLessThan(2)
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
