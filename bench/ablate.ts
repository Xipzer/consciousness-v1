import { type Config, loadConfig } from '../src/config.ts'
import { Core } from '../src/core/core.ts'
import type { CoreEvent, Latest } from '../src/core/types.ts'
import { ALL_CHANNELS } from '../src/senses/channels.ts'
import { arg, gauss, loadBackground, mcnemar, pct, Replay, results, rng, shuffle } from './lib.ts'

const STEPS = [1, 1.5, 2, 3, 5, 8]
const KINDS = [...STEPS.map((a) => `step_${a}`), 'pulse_3', 'ramp_3', 'null']
const HOLD_S = 15
const RAMP_S = 60
const WINDOW_S = 10

const VARIANTS: Record<string, Partial<Config>> = Object.fromEntries(
  (process.argv.find((a) => a.startsWith('--variants='))?.slice(11) ?? 'full,hab-channel,no-delta').split(',').map((v) => [v, {
    full: {}, 'hab-channel': { habituationByDirection: false }, 'no-delta': { mode: 'no-delta' as const },
    'no-escalation': { escalation: false },
    'no-urgent': { urgentOverride: false },
    'v0.2-arbiter': { escalation: false, urgentOverride: false, surpriseOnClocks: true, discreteDetector: false, noticeFloor: false },
  }[v] ?? (() => { throw new Error(`unknown variant ${v}`) })()]),
)

const seed0 = arg('seed0', 1)
const seeds = arg('seeds', 2)
const reps = arg('reps', 4)
const bg = loadBackground()
const out = results('ablate')
console.log(`background ${bg.durationS.toFixed(0)}s; variants ${Object.keys(VARIANTS).join(', ')}; results -> ${out.path}`)

const bgSummary: { seed: number; variant: string; wakesPerMin: number }[] = []
type Row = { seed: number; kind: string; variant: string; onset: boolean; onsetLatency: number | null; release: boolean | null; wake: boolean; falseAlarm: boolean | null }
const rows: Row[] = []

for (let seed = seed0; seed < seed0 + seeds; seed++) {
  const r = rng(seed)
  const noise = rng(seed * 977 + 3)
  const names = Object.keys(VARIANTS)
  const cores = names.map((v) => new Core(ALL_CHANNELS, loadConfig({ ...VARIANTS[v] }), { instanceId: `abl-${seed}`, birthWall: 0 }))
  const events: CoreEvent[][] = names.map(() => [])
  const bgWakes = names.map(() => 0)
  const latest: Latest = new Map()
  const replay = new Replay(bg, Math.floor((seed * 7919) % bg.frames.length))
  const hz = 10
  let k = 0
  const tick = (level: number) => {
    k++
    const t = k / hz
    replay.advance(t, latest)
    latest.set('test.a', { value: gauss(noise) + level, t })
    cores.forEach((c, i) => {
      for (const e of c.step(latest, t, 1e9 + t).events) {
        if (e.channel === 'test.a') events[i]!.push(e)
        else if (e.decision === 'wake' && t > 120) bgWakes[i]!++
      }
    })
    return t
  }
  let t = 0
  while (t < 120) t = tick(0)
  const tStart = 120
  const trials = shuffle(KINDS.flatMap((kind) => Array.from({ length: reps }, () => kind)), r)
  for (const kind of trials) {
    const quietEnd = t + 40 + r() * 20
    while (t < quietEnd) t = tick(0)
    const dir = r() < 0.5 ? 1 : -1
    const amp = Number(kind.split('_')[1] ?? 0)
    const onset = t
    const dur = kind.startsWith('step') ? HOLD_S : kind.startsWith('pulse') ? 1 : kind.startsWith('ramp') ? RAMP_S : HOLD_S
    while (t < onset + dur) {
      const dt = t - onset
      const level = kind.startsWith('ramp') ? dir * amp * Math.min(dt / RAMP_S, 1) : kind === 'null' ? 0 : dir * amp
      t = tick(level)
    }
    const release = t
    const settle = t + 30
    while (t < settle) t = tick(kind.startsWith('ramp') ? 0 : 0)
    names.forEach((variant, i) => {
      const evs = events[i]!.filter((e) => e.kind === 'change' && e.decision !== 'ignore')
      const at = (from: number, to: number, d: number) => evs.filter((e) => e.direction === d && e.tWall - 1e9 >= from && e.tWall - 1e9 <= to)
      if (kind === 'null') {
        const any = evs.filter((e) => e.tWall - 1e9 >= onset && e.tWall - 1e9 <= release + WINDOW_S)
        rows.push({ seed, kind, variant, onset: false, onsetLatency: null, release: null, wake: any.some((e) => e.decision === 'wake'), falseAlarm: any.length > 0 })
        return
      }
      const onWin = kind.startsWith('ramp') ? RAMP_S : WINDOW_S
      const on = at(onset, onset + onWin, dir)
      const rel = kind.startsWith('step') ? at(release, release + WINDOW_S, -dir) : []
      const wake = evs.some((e) => e.decision === 'wake' && e.tWall - 1e9 >= onset && e.tWall - 1e9 <= release + WINDOW_S)
      rows.push({
        seed, kind, variant, onset: on.length > 0, onsetLatency: on.length ? on[0]!.tWall - 1e9 - onset : null,
        release: kind.startsWith('step') ? rel.length > 0 : null, wake, falseAlarm: null,
      })
    })
  }
  names.forEach((variant, i) => bgSummary.push({ seed, variant, wakesPerMin: +((bgWakes[i]! / (t - tStart)) * 60).toFixed(2) }))
}
rows.forEach((x) => out.write(x))
for (const b of bgSummary) out.write({ type: 'background', ...b })

const names = Object.keys(VARIANTS)
console.log('\n## Onset detection within 10 s (60 s for ramps)')
console.log(['kind', ...names].join(' | '))
for (const kind of KINDS.filter((x) => x !== 'null')) console.log([kind, ...names.map((v) => { const rs = rows.filter((x) => x.kind === kind && x.variant === v); return pct(rs.filter((x) => x.onset).length, rs.length) })].join(' | '))
console.log('\n## Release detection within 10 s (steps)')
for (const kind of KINDS.filter((x) => x.startsWith('step'))) console.log([kind, ...names.map((v) => { const rs = rows.filter((x) => x.kind === kind && x.variant === v); return pct(rs.filter((x) => x.release).length, rs.length) })].join(' | '))
const steps = (v: string) => rows.filter((x) => x.kind.startsWith('step') && x.variant === v)
console.log(['all steps', ...names.map((v) => pct(steps(v).filter((x) => x.release).length, steps(v).length))].join(' | '))
console.log('\n## Wake on stimulus')
for (const kind of KINDS.filter((x) => x !== 'null')) console.log([kind, ...names.map((v) => { const rs = rows.filter((x) => x.kind === kind && x.variant === v); return pct(rs.filter((x) => x.wake).length, rs.length) })].join(' | '))
console.log('\n## False alarms on null windows')
console.log(['null', ...names.map((v) => { const rs = rows.filter((x) => x.kind === 'null' && x.variant === v); return pct(rs.filter((x) => x.falseAlarm).length, rs.length) })].join(' | '))
console.log('\n## Wakes/min on body channels (replayed background, outside test.a)')
console.log(names.map((v) => `${v} ${(bgSummary.filter((b) => b.variant === v).reduce((a, b) => a + b.wakesPerMin, 0) / seeds).toFixed(2)}`).join(' | '))
if (names.includes('full') && names.includes('hab-channel')) {
  const a = steps('full').map((x) => !!x.release)
  const b = steps('hab-channel').map((x) => !!x.release)
  const m = mcnemar(a, b)
  console.log(`\nP13 release, full vs hab-channel: ${a.filter(Boolean).length}/${a.length} vs ${b.filter(Boolean).length}/${b.length}, McNemar p=${m.p.toPrecision(2)} (full only ${m.onlyA}, hab-channel only ${m.onlyB})`)
}
