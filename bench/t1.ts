import { loadBackground, arg, gauss, mcnemar, pairedBootstrapDiff, pct, results, rng, shuffle } from './lib.ts'
import { probe, Rig, SYSTEMS, type System } from './rig.ts'
import { CHANNEL_SCHEMA, type ChannelReport } from '../src/mind/prompt.ts'

const KINDS = ['step_small', 'step_large', 'pulse_small', 'pulse_large', 'ramp_small', 'ramp_large', 'stale', 'null'] as const
type Kind = (typeof KINDS)[number]

const SMALL = 2.5
const LARGE = 8
const QUIET_S = 30
const SETTLE_S = 60
const WINDOW_S = 90
const RAMP_S = 60
const TOL: Record<Kind, number> = {
  step_small: 3, step_large: 3, pulse_small: 3, pulse_large: 3, ramp_small: 30, ramp_large: 30, stale: 3, null: 0,
}
const QUESTION = `What happened to channel test.a during the last ${WINDOW_S} seconds? List each change of test.a in \
"changes" (direction "stopped" if it stopped updating); seconds_ago is when the change began. Return an empty list if \
test.a did not change beyond its normal noise.`

const url = process.env.CV1_LLM_URL ?? ''
const seeds = arg('seeds', 2)
const seed0 = arg('seed0', 1)
const reps = arg('reps', 6)
const limit = arg('limit', Infinity)
const out = results('t1')
const bg = loadBackground()
console.log(`background ${bg.durationS.toFixed(0)}s, ${bg.frames.length} frames; results -> ${out.path}`)

const stimulus = (kind: Kind, dir: number, dt: number) => {
  if (dt < 0) return 0
  if (kind === 'step_small') return dir * SMALL
  if (kind === 'step_large') return dir * LARGE
  if (kind === 'pulse_small') return dt < 1 ? dir * SMALL : 0
  if (kind === 'pulse_large') return dt < 1 ? dir * LARGE : 0
  if (kind === 'ramp_small') return dir * SMALL * Math.min(dt / RAMP_S, 1)
  if (kind === 'ramp_large') return dir * LARGE * Math.min(dt / RAMP_S, 1)
  return 0
}

const grade = (kind: Kind, dir: number, report: ChannelReport | null, trueAgo: number) => {
  const claims = report?.changes ?? []
  if (kind === 'null') return { hit: claims.length === 0, claimed: claims.length > 0, onsetErr: null }
  const want = kind === 'stale' ? 'stopped' : dir > 0 ? 'up' : 'down'
  const match = claims.filter((c) => c.direction === want)
  const best = match.map((c) => Math.abs(c.seconds_ago - trueAgo)).sort((a, b) => a - b)[0]
  return { hit: best !== undefined && best <= TOL[kind], claimed: claims.length > 0, onsetErr: best ?? null }
}

let items = 0
const all: Record<string, unknown>[] = []
for (let seed = seed0; seed < seed0 + seeds && items < limit; seed++) {
  const r = rng(seed)
  const noise = rng(seed * 1000 + 7)
  const rig = new Rig(bg, seed)
  for (let i = 0; i < 120 * rig.cfg.tickHz; i++) rig.tick(gauss(noise))
  const trials = shuffle(KINDS.flatMap((k) => Array.from({ length: reps }, () => k)), r)
  for (const [ti, kind] of trials.entries()) {
    if (items >= limit) break
    const dir = r() < 0.5 ? 1 : -1
    const jitter = r() * 10
    const onset = rig.t + QUIET_S + jitter
    const probeAt = onset + (kind.startsWith('ramp') ? RAMP_S + 5 : 15)
    const evIdx = { S: rig.events.S.length, L: rig.events.L.length }
    while (rig.t < probeAt) {
      const dt = rig.t + 1 / rig.cfg.tickHz - onset
      const stale = kind === 'stale' && dt >= 0
      rig.tick(stale ? null : gauss(noise) + stimulus(kind, dir, dt))
    }
    const onsetWall = rig.wall - (rig.t - onset)
    const trueAgo = rig.wall - onsetWall
    const det: Record<string, { detected: boolean; latency: number | null }> = {}
    for (const sys of ['S', 'L'] as const) {
      const evs = rig.events[sys].slice(evIdx[sys]).filter((e) => e.channel === 'test.a' && e.tWall >= onsetWall - 0.05 && e.decision !== 'ignore')
      const relevant = kind === 'stale' ? evs.filter((e) => e.kind === 'stale') : evs.filter((e) => e.kind === 'change')
      const pre = rig.events[sys].slice(evIdx[sys]).filter((e) => e.channel === 'test.a' && e.tWall < onsetWall && e.decision !== 'ignore')
      det[sys] = kind === 'null'
        ? { detected: relevant.length === 0 && pre.length === 0, latency: null }
        : { detected: relevant.length > 0, latency: relevant.length ? relevant[0]!.tWall - onsetWall : null }
    }
    const eventsOnly = process.argv.includes('--events-only')
    const empty = { report: null, raw: '', tokens: 0, ms: 0, meanLogprob: Number.NaN, promptChars: 0 }
    const reports = eventsOnly ? SYSTEMS.map(() => empty) : await Promise.all(SYSTEMS.map((sys) => probe<ChannelReport>(url, rig, sys, QUESTION, WINDOW_S, seed * 100 + ti, CHANNEL_SCHEMA, 'test.a')))
    const row: Record<string, unknown> = { seed, trial: ti, kind, dir, trueAgo: +trueAgo.toFixed(2) }
    SYSTEMS.forEach((sys, i) => {
      const p = reports[i]!
      const g = grade(kind, dir, p.report, trueAgo)
      row[sys] = { ...g, event: det[sys] ?? null, tokens: p.tokens, ms: Math.round(p.ms), promptChars: p.promptChars, changes: p.report?.changes ?? null, confidence: p.report?.confidence ?? null, meanLogprob: p.meanLogprob }
    })
    out.write(row)
    all.push(row)
    items++
    const brief = SYSTEMS.map((s) => `${s}:${(row[s] as { hit: boolean }).hit ? 'hit' : 'miss'}`).join(' ')
    console.log(`seed ${seed} #${ti} ${kind.padEnd(11)} ${dir > 0 ? '+' : '-'} ${brief}  (${reports.map((p) => Math.round(p.ms)).join('/')} ms)`)
    const backAt = rig.t + SETTLE_S
    while (rig.t < backAt) rig.tick(gauss(noise))
  }
}

type Row = Record<System, { hit: boolean; event: { detected: boolean } | null; onsetErr: number | null }> & { kind: Kind }
const rows = all as unknown as Row[]
console.log('\n## T1 report hit rate (95% Wilson CI)')
console.log(['kind', ...SYSTEMS].join(' | '))
for (const kind of [...KINDS, 'all-stimuli'] as const) {
  const rs = kind === 'all-stimuli' ? rows.filter((x) => x.kind !== 'null') : rows.filter((x) => x.kind === kind)
  console.log([kind, ...SYSTEMS.map((s) => pct(rs.filter((x) => x[s].hit).length, rs.length))].join(' | '))
}
console.log('\n## T1 event-level detection (no LLM)')
for (const kind of KINDS) {
  const rs = rows.filter((x) => x.kind === kind)
  console.log([kind, ...(['S', 'L'] as const).map((s) => pct(rs.filter((x) => x[s].event?.detected).length, rs.length))].join(' | '))
}
const stim = rows.filter((x) => x.kind !== 'null')
for (const [a, b] of [['S', 'B1'], ['S', 'L']] as const) {
  const A = stim.map((x) => x[a].hit)
  const B = stim.map((x) => x[b].hit)
  const d = pairedBootstrapDiff(A, B)
  const m = mcnemar(A, B)
  console.log(`paired ${a} vs ${b} on stimuli: diff ${(d.mean * 100).toFixed(0)} pts [${(d.lo * 100).toFixed(0)}, ${(d.hi * 100).toFixed(0)}], McNemar p=${m.p.toPrecision(2)} (${a} only ${m.onlyA}, ${b} only ${m.onlyB})`)
}
