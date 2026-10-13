import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config.ts'
import { arg, gauss, pct, results, rng } from './lib.ts'

const FACTOR = process.argv.find((a) => a.startsWith('--factor='))?.slice(9) ?? 'efference'
const HK_CHANNELS = new Set(loadConfig().housekeepingReafferent)
const ORDER = (process.argv.find((a) => a.startsWith('--order='))?.slice(8) ?? 'on,off,off,on').split(',')
const TRIALS = arg('trials', 8)
const WARMUP_S = arg('warmup', 90)
const STEP_SD = arg('step', 3)
const HOLD_S = arg('hold', 15)
const ASK_AFTER_S = 8
const DETECT_WINDOW_S = 10
const TOL_S = 3
const PORT = 8094
const BASE = `http://127.0.0.1:${PORT}`
const reafferent = new Set(loadConfig().reafferent)
const out = results('live')
const seed = arg('seed', 11)
const r = rng(seed)
const noise = rng(seed * 31 + 1)
const sleep = (s: number) => new Promise((res) => setTimeout(res, s * 1000))
const now = () => Date.now() / 1000

const inject = (value: number) => fetch(`${BASE}/inject?channel=test.live&value=${value}`, { method: 'POST' }).catch(() => {})

interface Trial { kind: 'synthetic'; channel: string; onset: number; release: number; askT: number; report: any }

const runBlock = async (block: number, cond: string) => {
  const dir = join('data-bench', `b${block}-${cond}`)
  if (existsSync(dir)) rmSync(dir, { recursive: true })
  mkdirSync(dir, { recursive: true })
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    env: {
      ...process.env, CV1_DATA: dir, CV1_ASK_PORT: String(PORT),
      ...(FACTOR === 'efference'
        ? { CV1_EFFERENCE: cond === 'on' ? '1' : '0' }
        : { CV1_EFFERENCE: '1', CV1_EFFERENCE_HOUSEKEEPING: cond === 'on' ? '1' : '0', CV1_HOUSEKEEPING_S: '60' }),
    },
    stdout: Bun.file(join(dir, 'daemon.log')), stderr: 'inherit',
  })
  let level = 0
  let driving = true
  const driver = (async () => {
    await sleep(2)
    while (driving) {
      await inject(gauss(noise) + level)
      await sleep(0.1)
    }
  })()
  const t0 = now()
  console.log(`${new Date().toISOString()} block ${block} efference=${cond}: warm-up ${WARMUP_S}s`)
  await sleep(WARMUP_S)
  const trials: Trial[] = []
  for (let i = 0; i < TRIALS; i++) {
    const kind = 'synthetic' as const
    await sleep(30 + r() * 15)
    const onset = now()
    level = (r() < 0.5 ? 1 : -1) * STEP_SD
    await sleep(HOLD_S)
    level = 0
    const release = now()
    await sleep(ASK_AFTER_S)
    const channel = 'test.live'
    const askT = now()
    const res = (await fetch(`${BASE}/ask?channel=${channel}&window=60`).then((x) => x.json()).catch(() => null)) as any
    trials.push({ kind, channel, onset, release, askT, report: res?.report ?? null })
    console.log(`  ${kind} ${(release - onset).toFixed(1)}s, report ${JSON.stringify(res?.report?.changes ?? null)}`)
  }
  await sleep(20)
  driving = false
  await driver
  const t1 = now()
  proc.kill('SIGINT')
  await proc.exited
  return { dir, t0, t1, trials, level: () => level }
}

const score = (b: Awaited<ReturnType<typeof runBlock>>, cond: string) => {
  const db = new Database(join(b.dir, 'mind.db'), { readonly: true })
  const events = db.query('SELECT * FROM events ORDER BY t_wall').all() as any[]
  const thoughts = db.query('SELECT t_start FROM thoughts ORDER BY t_start').all() as any[]
  db.close()
  const log = readFileSync(join(b.dir, 'daemon.log'), 'utf8')
  const missed = Math.max(0, ...[...log.matchAll(/missed=(\d+)/g)].map((m) => Number(m[1])))
  const scoredFrom = b.t0 + WARMUP_S
  const minutes = (b.t1 - scoredFrom) / 60
  const inStim = (t: number) => b.trials.some((x) => t >= x.onset - 2 && t <= x.release + 15)
  const rows = b.trials.map((x) => {
    const ev = (e: any) => e.channel === x.channel && e.kind === 'change' && e.decision !== 'ignore'
    const dirSign = (sign: number) => (e: any) => e.direction === sign
    const firstUp = events.find((e) => ev(e) && e.t_wall >= x.onset && e.t_wall <= x.onset + DETECT_WINDOW_S)
    const onsetDir = firstUp?.direction ?? 1
    const off = events.find((e) => ev(e) && dirSign(-onsetDir)(e) && e.t_wall >= x.release && e.t_wall <= x.release + DETECT_WINDOW_S)
    const wake = events.some((e) => e.decision === 'wake' && e.channel === x.channel && e.t_wall >= x.onset && e.t_wall <= x.release + DETECT_WINDOW_S)
    const changes = (x.report?.changes ?? []) as { direction: string; seconds_ago: number }[]
    const name = (s: number) => (s > 0 ? 'up' : 'down')
    return {
      cond, kind: x.kind, channel: x.channel,
      onsetLatency: firstUp ? firstUp.t_wall - x.onset : null, releaseLatency: off ? off.t_wall - x.release : null,
      externalWake: wake,
      reportOnset: !!firstUp && changes.some((c) => c.direction === name(onsetDir) && Math.abs(c.seconds_ago - (x.askT - x.onset)) <= TOL_S),
      reportRelease: !!firstUp && changes.some((c) => c.direction === name(-onsetDir) && Math.abs(c.seconds_ago - (x.askT - x.release)) <= TOL_S),
      report: changes, truth: { onsetWall: x.onset, releaseWall: x.release, askWall: x.askT },
    }
  })
  const scored = events.filter((e) => e.t_wall >= scoredFrom)
  const wakes = scored.filter((e) => e.decision === 'wake')
  const selfAll = wakes.filter((e) => reafferent.has(e.channel))
  const selfOutside = selfAll.filter((e) => !inStim(e.t_wall))
  const chores = [...log.matchAll(/^(\S+) storage:/gm)].map((m) => Date.parse(m[1]!) / 1000).filter((t) => t >= scoredFrom)
  const afterChore = (t: number) => chores.some((c) => t >= c - 1 && t <= c + 20)
  const hkWakes = wakes.filter((e) => HK_CHANNELS.has(e.channel) && afterChore(e.t_wall))
  const summary = {
    factor: FACTOR, chores: chores.length, hkWakesAfterChore: hkWakes.length,
    hkEventsAfterChore: scored.filter((e) => HK_CHANNELS.has(e.channel) && e.kind === 'change' && afterChore(e.t_wall)).length,
    cond, minutes: +minutes.toFixed(2), missed, wakes: wakes.length, selfWakesAll: selfAll.length, selfWakesOutside: selfOutside.length,
    selfWakesByChannel: Object.fromEntries([...new Set(selfAll.map((e) => e.channel))].map((c) => [c, selfAll.filter((e) => e.channel === c).length])),
    attributed: scored.filter((e) => e.attribution === 'self').length, thoughts: thoughts.filter((t) => t.t_start >= scoredFrom).length,
  }
  return { rows, summary, events, thoughts }
}


const all: Awaited<ReturnType<typeof score>>[] = []
for (const [i, cond] of ORDER.entries()) {
  const b = await runBlock(i, cond)
  const s = score(b, cond)
  s.rows.forEach((row) => out.write({ type: 'trial', block: i, ...row }))
  out.write({ type: 'block', block: i, ...s.summary, startWall: b.t0, scoredFromWall: b.t0 + WARMUP_S, endWall: b.t1 })
  for (const e of s.events) out.write({ type: 'event', block: i, cond, ...e })
  for (const t of s.thoughts) out.write({ type: 'thought', block: i, cond, ...t })
  rmSync(b.dir, { recursive: true })
  console.log(JSON.stringify(s.summary))
  all.push(s)
}

const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1]!.toFixed(2) : 'n/a')
console.log(`\n## Live benchmark (synthetic step ${STEP_SD} sd for ${HOLD_S}s)`)
console.log('efference | kind | onset ≤10 s | median onset s | release ≤10 s | median release s | wake on stimulus | report onset | report release')
for (const cond of ['off', 'on']) {
  for (const kind of ['synthetic']) {
    const rows = all.filter((x) => x.summary.cond === cond).flatMap((x) => x.rows).filter((x) => x.kind === kind)
    if (!rows.length) continue
    const n = rows.length
    console.log([cond, kind, pct(rows.filter((x) => x.onsetLatency !== null).length, n), med(rows.flatMap((x) => (x.onsetLatency === null ? [] : [x.onsetLatency]))),
      pct(rows.filter((x) => x.releaseLatency !== null).length, n), med(rows.flatMap((x) => (x.releaseLatency === null ? [] : [x.releaseLatency]))),
      pct(rows.filter((x) => x.externalWake).length, n), pct(rows.filter((x) => x.reportOnset).length, n), pct(rows.filter((x) => x.reportRelease).length, n)].join(' | '))
  }
}
console.log(`factor: ${FACTOR}`)
for (const cond of ['off', 'on']) {
  const ss = all.filter((x) => x.summary.cond === cond).map((x) => x.summary)
  if (ss.length && FACTOR === 'housekeeping') console.log(`${cond}: chores ${ss.reduce((a, s) => a + s.chores, 0)}, housekeeping-channel events after chores ${ss.reduce((a, s) => a + s.hkEventsAfterChore, 0)}, wakes ${ss.reduce((a, s) => a + s.hkWakesAfterChore, 0)}`)
}
console.log('\nefference | minutes | wakes | self-channel wakes (all) | per min | self-channel wakes outside stimuli | per min | thoughts | missed ticks')
for (const cond of ['off', 'on']) {
  const ss = all.filter((x) => x.summary.cond === cond).map((x) => x.summary)
  if (!ss.length) continue
  const sum = (k: keyof (typeof ss)[0]) => ss.reduce((a, s) => a + (s[k] as number), 0)
  const m = sum('minutes')
  console.log([cond, m.toFixed(1), sum('wakes'), sum('selfWakesAll'), (sum('selfWakesAll') / m).toFixed(2), sum('selfWakesOutside'), (sum('selfWakesOutside') / m).toFixed(2), sum('thoughts'), sum('missed')].join(' | '))
}
console.log(`results -> ${out.path}`)
process.exit(0)
