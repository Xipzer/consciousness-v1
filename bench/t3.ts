import { loadConfig } from '../src/config.ts'
import { assessContinuity, type Continuity } from '../src/core/continuity.ts'
import { Core } from '../src/core/core.ts'
import type { Latest } from '../src/core/types.ts'
import { type ChainLink, linkDigest, Store } from '../src/memory/store.ts'
import { ALL_CHANNELS } from '../src/senses/channels.ts'
import { arg, loadBackground, pct, Replay, results, rng } from './lib.ts'

const RUN_S = 300
const WARM_S = 15
const GAPS = [10, 60, 300]
const VARIANTS = ['clean', 'crash', 'foreign', 'tampered'] as const
type Variant = (typeof VARIANTS)[number]
const EXPECT: Record<Variant, Continuity['verdict']> = { clean: 'continuous', crash: 'continuous', foreign: 'discontinuous', tampered: 'tampered' }

const trialsPer = arg('trials', 10)
const out = results('t3')
const bg = loadBackground()
const cfg = loadConfig({ efference: false, habituationByDirection: false })
const span = RUN_S + Math.max(...GAPS) + WARM_S + 5
if (bg.durationS < span * 2) throw new Error(`need ${span * 2}s of recorded background, have ${bg.durationS.toFixed(0)}s`)
console.log(`background ${bg.durationS.toFixed(0)}s; results -> ${out.path}`)

const frameAt = (sec: number) => {
  const t0 = bg.frames[0]!.tWall
  return Math.max(0, bg.frames.findIndex((f) => f.tWall - t0 >= sec))
}

const live = (startSec: number, seconds: number, wallStart: number, onTick?: (core: Core, wall: number, t: number) => void) => {
  const core = new Core(ALL_CHANNELS, cfg, { instanceId: 'bench-t3', birthWall: 0 })
  const latest: Latest = new Map()
  const replay = new Replay(bg, frameAt(startSec))
  for (let k = 1; k <= seconds * cfg.tickHz; k++) {
    const t = k / cfg.tickHz
    replay.advance(t, latest)
    core.step(latest, t, wallStart + t)
    onTick?.(core, wallStart + t, t)
  }
  return core
}

const history = (startSec: number, wallStart: number, crash: boolean): ChainLink[] => {
  const store = new Store(':memory:')
  let next = cfg.chainEveryS
  const core = live(startSec, RUN_S, wallStart, (c, wall, t) => {
    if (t + 1e-9 < next) return
    next += cfg.chainEveryS
    store.appendLink({ tWall: wall, tick: Math.round(t * cfg.tickHz), kind: 'tick', slow: c.slowVector(), raw: c.rawVector(), sigma: c.sigmaVector() })
  })
  if (!crash) store.appendLink({ tWall: wallStart + RUN_S, tick: RUN_S * cfg.tickHz, kind: 'shutdown', slow: core.slowVector(), raw: core.rawVector(), sigma: core.sigmaVector() })
  const links = store.chain()
  store.close()
  return links
}

const restamp = (links: ChainLink[], shift: number): ChainLink[] => {
  const outLinks: ChainLink[] = []
  for (const l of links) {
    const base = { ...l, tWall: l.tWall + shift, prev: outLinks.length ? outLinks[outLinks.length - 1]!.digest : 'genesis' }
    const { digest: _d, ...rest } = base
    outLinks.push({ ...base, digest: linkDigest(rest) })
  }
  return outLinks
}

const noUptime = ALL_CHANNELS.map((c) => (c.name === 'body.host.uptime' ? { ...c, name: 'ablated.uptime' } : c))
const r = rng(arg('seed', 42))
const rows: Record<string, any>[] = []
const usable = bg.durationS - span
for (let i = 0; i < trialsPer; i++) {
  const start = r() * usable
  const foreignStart = (start + bg.durationS / 2) % usable
  const wall0 = 1.9e9
  for (const v of VARIANTS) {
    const gaps = v === 'clean' ? GAPS : [60]
    for (const g of gaps) {
      let links = history(start, wall0, v === 'crash')
      if (v === 'foreign') links = restamp(history(foreignStart, wall0, false), 0)
      if (v === 'tampered') {
        const j = 1 + Math.floor(r() * (links.length - 2))
        links = links.map((l, idx) => (idx === j ? { ...l, raw: l.raw.map((x, c) => (c === 0 && x !== null ? x + 0.05 : x)) } : l))
      }
      const after = live(start + RUN_S + g, WARM_S, wall0 + RUN_S + g)
      const nowWall = wall0 + RUN_S + g + WARM_S
      const c = assessContinuity(links, nowWall, after.slowVector(), after.rawVector(), ALL_CHANNELS, WARM_S)
      const cBody = assessContinuity(links, nowWall, after.slowVector(), after.rawVector(), noUptime, WARM_S)
      const row = {
        trial: i, variant: v, gapS: g, expected: EXPECT[v], verdict: c.verdict, correct: c.verdict === EXPECT[v],
        bodyOnlyVerdict: cBody.verdict, bodyOnlyCorrect: cBody.verdict === EXPECT[v],
        downtimeS: c.downtimeS, downtimeErr: c.downtimeS === null ? null : c.downtimeS - (v === 'foreign' ? g : g),
        bodyDistance: c.bodyDistance, uptimeErrorS: c.uptimeErrorS, clockRate: c.clockRate, cleanShutdown: c.cleanShutdown,
      }
      out.write(row)
      rows.push(row)
    }
  }
  console.log(`trial ${i}: ${rows.slice(-6).map((x) => `${x.variant}${x.variant === 'clean' ? x.gapS : ''}=${x.verdict}${x.correct ? '' : '(X)'}`).join(' ')}`)
}

console.log('\n## T3 continuity (P5)')
for (const v of VARIANTS) {
  const vs = rows.filter((x) => x.variant === v)
  console.log(`${v.padEnd(9)} expected ${EXPECT[v].padEnd(13)} full check ${pct(vs.filter((x) => x.correct).length, vs.length)} | body-distance only ${pct(vs.filter((x) => x.bodyOnlyCorrect).length, vs.length)}`)
}
const clean = rows.filter((x) => x.variant === 'clean')
console.log(`clean restarts: max |downtime error| ${Math.max(...clean.map((x) => Math.abs(x.downtimeErr))).toFixed(2)}s, body distance median ${clean.map((x) => x.bodyDistance).sort((a, b) => a - b)[clean.length >> 1].toFixed(2)}`)
const foreign = rows.filter((x) => x.variant === 'foreign')
console.log(`foreign histories: body distance median ${foreign.map((x) => x.bodyDistance).sort((a, b) => a - b)[foreign.length >> 1].toFixed(2)}, |uptime error| min ${Math.min(...foreign.map((x) => Math.abs(x.uptimeErrorS))).toFixed(0)}s`)
const all = rows
console.log(`overall P5 (>= 90% correct): ${pct(all.filter((x) => x.correct).length, all.length)}`)
