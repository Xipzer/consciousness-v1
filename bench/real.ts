import { Database } from 'bun:sqlite'
import { loadConfig } from '../src/config.ts'
import { Core } from '../src/core/core.ts'
import type { CoreEvent, Latest } from '../src/core/types.ts'
import { ALL_CHANNELS } from '../src/senses/channels.ts'
import { loadBackground, pct, results } from './lib.ts'

const MIN_S = 3
const TOL_S = 3
const TAIL_S = 18
const iso = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const FROM = iso('from') ? Date.parse(iso('from')!) / 1000 : 0
const TO = iso('to') ? Date.parse(iso('to')!) / 1000 : Infinity
const VARIANTS: Record<string, Record<string, unknown>> = {
  full: {}, 'no-discrete': { discreteDetector: false }, 'no-notice-floor': { noticeFloor: false }, 'efference-off': { efference: false },
}
const full = loadBackground()
const bg = { ...full, frames: full.frames.filter((f) => f.tWall >= FROM && f.tWall <= TO) }
const db = new Database('data/mind.db', { readonly: true })
const t0 = bg.frames[0]!.tWall
const t1 = bg.frames.at(-1)!.tWall
const thoughts = (db.query("SELECT t_start, t_end, status FROM thoughts WHERE status IN ('done', 'interrupted') ORDER BY t_start").all() as { t_start: number; t_end: number; status: string }[])
  .filter((x) => x.t_start > t0 + 120 && x.t_end < t1)
db.close()
const IDLE_BEFORE = process.argv.includes('--idle-before')
const busyIdx = bg.channels.indexOf('brain.busy_slots')
const idleBefore = (t: number) => bg.frames.filter((f) => f.tWall >= t - 2 && f.tWall < t).every((f) => f.values[busyIdx] === 0)
const reafferent = new Set(loadConfig().reafferent)
const out = results('real')
console.log(`recorded ${((t1 - t0) / 3600).toFixed(1)} h, ${bg.frames.length} frames; ${thoughts.length} thoughts inside coverage`)

const run = (variant: string) => {
  const core = new Core(ALL_CHANNELS, loadConfig(VARIANTS[variant]), { instanceId: 'real', birthWall: t0 })
  const latest: Latest = new Map()
  const events: CoreEvent[] = []
  for (const f of bg.frames) {
    bg.channels.forEach((c, j) => {
      const age = f.ages[j]!
      if (age < 0 || c.startsWith('test.')) return
      const t = f.tWall - age
      const prev = latest.get(c)
      if (!prev || t > prev.t) latest.set(c, { value: f.values[j]!, t })
    })
    events.push(...core.step(latest, f.tWall, f.tWall).events)
  }
  return events
}

const report: Record<string, unknown> = {}
for (const variant of Object.keys(VARIANTS)) {
  const events = run(variant)
  const busy = events.filter((e) => e.channel === 'brain.busy_slots' && e.kind === 'change' && e.decision !== 'ignore')
  const scored = thoughts.filter((x) => x.t_end - x.t_start >= MIN_S && (!IDLE_BEFORE || idleBefore(x.t_start)))
  const onset = scored.map((x) => busy.find((e) => e.direction === 1 && e.tWall >= x.t_start - 0.5 && e.tWall <= x.t_start + TOL_S))
  const release = scored.map((x) => busy.find((e) => e.direction === -1 && e.tWall >= x.t_end - 0.5 && e.tWall <= x.t_end + TOL_S))
  const inWin = (t: number) => thoughts.some((x) => t >= x.t_start && t <= x.t_end + TAIL_S)
  const reaff = events.filter((e) => e.kind === 'change' && e.channel && reafferent.has(e.channel) && inWin(e.tWall))
  const lat = (xs: (CoreEvent | undefined)[], ref: (i: number) => number) => xs.flatMap((e, i) => (e ? [e.tWall - ref(i)] : [])).sort((a, b) => a - b)
  const onLat = lat(onset, (i) => scored[i]!.t_start)
  const offLat = lat(release, (i) => scored[i]!.t_end)
  const row = {
    variant, thoughtsScored: scored.length,
    onsetDetected: onset.filter(Boolean).length, onsetMedianS: onLat[onLat.length >> 1] ?? null,
    releaseDetected: release.filter(Boolean).length, releaseMedianS: offLat[offLat.length >> 1] ?? null,
    reafferentEventsInThought: reaff.length, attributedSelf: reaff.filter((e) => e.attribution === 'self').length,
    wakesFromThem: reaff.filter((e) => e.decision === 'wake').length,
    totalWakesPerHour: +((events.filter((e) => e.decision === 'wake').length / ((t1 - t0) / 3600)).toFixed(1)),
  }
  out.write(row)
  report[variant] = row
  console.log(`\n${variant}`)
  console.log(`P15a onset of real generations (busy_slots up within ${TOL_S} s): ${pct(row.onsetDetected, scored.length)}, median ${row.onsetMedianS?.toFixed(2)} s`)
  console.log(`P15b release (down within ${TOL_S} s of end): ${pct(row.releaseDetected, scored.length)}, median ${row.releaseMedianS?.toFixed(2)} s`)
  console.log(`P15c reafferent change events inside thought windows: ${row.reafferentEventsInThought}, attributed to self ${pct(row.attributedSelf, row.reafferentEventsInThought)}, wakes from them ${row.wakesFromThem}`)
  console.log(`all wakes per hour: ${row.totalWakesPerHour}`)
}
console.log(`results -> ${out.path}`)
