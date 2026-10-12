import { STILL_SCHEMA, type StillReport } from '../src/mind/prompt.ts'
import { arg, gauss, loadBackground, pct, results, rng, shuffle } from './lib.ts'
import { probe, Rig, SYSTEMS } from './rig.ts'

const DURATIONS = [60, 180, 300]
const VARIANTS = ['hold', 'suspend'] as const
const TOL = 0.2
const WINDOW_S = 330
const QUESTION = 'Describe your stillness and continuity. still_now: is nothing at all changing right now? still_now_for_s: for how long (null if moving). last_stillness_period_s: length of the most recent completed period in which nothing changed (null if none). last_time_gap_s: length of the most recent gap in time in which you were not running (null if none).'
const MID_Q = QUESTION
const POST_Q = QUESTION

const url = process.env.CV1_LLM_URL ?? ''
const seeds = arg('seeds', 2)
const seed0 = arg('seed0', 1)
const reps = arg('reps', 3)
const limit = arg('limit', Infinity)
const out = results('t2')
const bg = loadBackground()
console.log(`background ${bg.durationS.toFixed(0)}s; results -> ${out.path}`)

const within = (x: number | null | undefined, truth: number) => typeof x === 'number' && Math.abs(x - truth) <= TOL * truth

let items = 0
const rows: Record<string, any>[] = []
for (let seed = seed0; seed < seed0 + seeds && items < limit; seed++) {
  const r = rng(seed + 50)
  const noise = rng(seed * 1000 + 99)
  const rig = new Rig(bg, seed + 50)
  for (let i = 0; i < 120 * rig.cfg.tickHz; i++) rig.tick(gauss(noise))
  const trials = shuffle(VARIANTS.flatMap((v) => DURATIONS.flatMap((d) => Array.from({ length: reps }, () => ({ v, d })))), r)
  for (const [ti, { v, d }] of trials.entries()) {
    if (items >= limit) break
    const settle = rig.t + WINDOW_S + 10 + r() * 20
    while (rig.t < settle) rig.tick(gauss(noise))
    const row: Record<string, any> = { seed, trial: ti, variant: v, durationS: d }
    if (v === 'hold') {
      const end = rig.t + d
      let nonZero = 0
      let ticks = 0
      let mid: Awaited<ReturnType<typeof probe<StillReport>>>[] | null = null
      const midAt = rig.t + d / 2
      const startWall = rig.wall
      while (rig.t < end) {
        const o = rig.tick(null, { hold: true })
        ticks++
        if (o.change !== 0) nonZero++
        if (!mid && rig.t >= midAt) mid = await Promise.all(SYSTEMS.map((s) => probe<StillReport>(url, rig, s, MID_Q, WINDOW_S, seed * 1000 + ti, STILL_SCHEMA)))
      }
      const midElapsed = midAt - (end - d)
      row.changeMeasure = { ticks, nonZero, allZero: nonZero === 0 }
      row.velocityAtEnd = Math.max(...Object.values(rig.S.selfModel(rig.wall).body).map((b) => Math.abs(b.velocityFast) / (b.sigma || 1)))
      row.mid = Object.fromEntries(SYSTEMS.map((s, i) => {
        const rep = mid![i]!.report
        return [s, { still: rep?.still_now ?? null, still_for_s: rep?.still_now_for_s ?? null, flagged: rep?.still_now === true, lengthOk: within(rep?.still_now_for_s, midElapsed), truth: midElapsed }]
      }))
      row.startWall = startWall
    } else {
      rig.suspend(d)
    }
    const after = rig.t + 5
    while (rig.t < after) rig.tick(gauss(noise))
    const post = await Promise.all(SYSTEMS.map((s) => probe<StillReport>(url, rig, s, POST_Q, WINDOW_S, seed * 1000 + ti + 500, STILL_SCHEMA)))
    row.post = Object.fromEntries(SYSTEMS.map((s, i) => {
      const rep = post[i]!.report
      const reported = v === 'hold' ? rep?.last_stillness_period_s : rep?.last_time_gap_s
      const either = within(rep?.last_stillness_period_s, d) || within(rep?.last_time_gap_s, d)
      return [s, { stillness_s: rep?.last_stillness_period_s ?? null, gap_s: rep?.last_time_gap_s ?? null, lengthOk: within(reported, d), eitherOk: either }]
    }))
    const evs = rig.events.S.filter((e) => (e.kind === 'moved' || e.kind === 'gap') && rig.wall - e.tWall < 10)
    row.eventDurationS = evs.map((e) => +(e.durationS ?? 0).toFixed(2))
    out.write(row)
    rows.push(row)
    items++
    console.log(`seed ${seed} #${ti} ${v.padEnd(7)} ${String(d).padStart(3)}s change=0:${row.changeMeasure?.allZero ?? '-'} ` +
      `mid S:${row.mid?.S.flagged ?? '-'}/${row.mid?.S.lengthOk ?? '-'} post ${SYSTEMS.map((s) => `${s}:${row.post[s].lengthOk}`).join(' ')} event=${row.eventDurationS}`)
  }
}

const hold = rows.filter((x) => x.variant === 'hold')
console.log('\n## T2 freeze (P4)')
console.log(`P4a change measure exactly zero through the freeze (S): ${pct(hold.filter((x) => x.changeMeasure.allZero).length, hold.length)}`)
for (const s of SYSTEMS) {
  console.log(`${s}: mid-freeze flags stillness ${pct(hold.filter((x) => x.mid[s].flagged).length, hold.length)}, ` +
    `with length within 20% ${pct(hold.filter((x) => x.mid[s].flagged && x.mid[s].lengthOk).length, hold.length)}`)
  for (const v of ['hold', 'suspend']) {
    const vs = rows.filter((x) => x.variant === v)
    console.log(`${s}: after release (${v}) gap length within 20% ${pct(vs.filter((x) => x.post[s].lengthOk).length, vs.length)}`)
  }
}
