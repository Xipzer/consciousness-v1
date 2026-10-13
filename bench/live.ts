import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config.ts'
import { arg, pct, results, rng } from './lib.ts'

const ORDER = (process.argv.find((a) => a.startsWith('--order='))?.slice(8) ?? 'on,off,off,on').split(',')
const TRIALS = arg('trials', 5)
const CORES = arg('cores', 8)
const BURN_S = arg('burn', 20)
const WARMUP_S = arg('warmup', 90)
const ASK_AFTER_S = 8
const DETECT_WINDOW_S = 10
const TOL_S = 3
const PORT = 8094
const reafferent = new Set(loadConfig().reafferent)
const out = results('live')
const r = rng(arg('seed', 7))
const sleep = (s: number) => new Promise((res) => setTimeout(res, s * 1000))
const now = () => Date.now() / 1000

interface Trial { block: number; cond: string; onset: number; release: number; askT: number; report: any; prompt: string }

const runBlock = async (block: number, cond: string) => {
  const dir = join('data-bench', `b${block}-${cond}`)
  if (existsSync(dir)) rmSync(dir, { recursive: true })
  mkdirSync(dir, { recursive: true })
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    env: { ...process.env, CV1_DATA: dir, CV1_EFFERENCE: cond === 'on' ? '1' : '0', CV1_ASK_PORT: String(PORT) },
    stdout: Bun.file(join(dir, 'daemon.log')), stderr: 'inherit',
  })
  const t0 = now()
  console.log(`${new Date().toISOString()} block ${block} efference=${cond}: warm-up ${WARMUP_S}s`)
  await sleep(WARMUP_S)
  const trials: Trial[] = []
  for (let i = 0; i < TRIALS; i++) {
    await sleep(40 + r() * 30)
    const onset = now()
    const burn = Bun.spawn(['sh', '-c', `for i in $(seq ${CORES}); do timeout ${BURN_S} sh -c 'while :; do :; done' & done; wait`])
    await burn.exited
    const release = now()
    await sleep(ASK_AFTER_S)
    const askT = now()
    const res = (await fetch(`http://127.0.0.1:${PORT}/ask?channel=body.cpu.load&window=60`).then((x) => x.json()).catch(() => null)) as any
    trials.push({ block, cond, onset, release, askT, report: res?.report ?? null, prompt: res?.prompt ?? '' })
    console.log(`  trial ${i}: burn ${(release - onset).toFixed(1)}s, report ${JSON.stringify(res?.report?.changes ?? null)}`)
  }
  await sleep(20)
  const t1 = now()
  proc.kill('SIGINT')
  await proc.exited
  return { dir, t0, t1, trials }
}

const score = (b: Awaited<ReturnType<typeof runBlock>>, cond: string) => {
  const db = new Database(join(b.dir, 'mind.db'), { readonly: true })
  const events = db.query('SELECT * FROM events ORDER BY t_wall').all() as any[]
  const thoughts = db.query('SELECT t_start, t_end, status FROM thoughts ORDER BY t_start').all() as any[]
  db.close()
  const log = readFileSync(join(b.dir, 'daemon.log'), 'utf8')
  const missed = Math.max(0, ...[...log.matchAll(/missed=(\d+)/g)].map((m) => Number(m[1])))
  const overruns = Math.max(0, ...[...log.matchAll(/overruns=(\d+)/g)].map((m) => Number(m[1])))
  const scoredFrom = b.t0 + WARMUP_S
  const minutes = (b.t1 - scoredFrom) / 60
  const inStim = (t: number) => b.trials.some((x) => t >= x.onset - 2 && t <= x.release + 15)
  const cpu = (e: any) => e.channel === 'body.cpu.load' && e.decision !== 'ignore'
  const rows = b.trials.map((x) => {
    const on = events.find((e) => cpu(e) && e.direction === 1 && e.t_wall >= x.onset && e.t_wall <= x.onset + DETECT_WINDOW_S)
    const off = events.find((e) => cpu(e) && e.direction === -1 && e.t_wall >= x.release && e.t_wall <= x.release + DETECT_WINDOW_S)
    const extWake = events.some((e) => e.decision === 'wake' && e.channel?.startsWith('body.cpu.') && e.t_wall >= x.onset && e.t_wall <= x.release + DETECT_WINDOW_S)
    const extBlocked = events.filter((e) => e.channel?.startsWith('body.cpu.') && ['budget', 'refractory'].includes(e.decision) && e.t_wall >= x.onset && e.t_wall <= x.release + DETECT_WINDOW_S).length
    const changes = (x.report?.changes ?? []) as { direction: string; seconds_ago: number }[]
    const upOk = changes.some((c) => c.direction === 'up' && Math.abs(c.seconds_ago - (x.askT - x.onset)) <= TOL_S)
    const downOk = changes.some((c) => c.direction === 'down' && Math.abs(c.seconds_ago - (x.askT - x.release)) <= TOL_S)
    return {
      cond, block: x.block, onsetLatency: on ? on.t_wall - x.onset : null, releaseLatency: off ? off.t_wall - x.release : null,
      externalWake: extWake, externalBlocked: extBlocked, reportUp: upOk, reportDown: downOk, report: changes,
      truth: { onsetAgo: +(x.askT - x.onset).toFixed(1), releaseAgo: +(x.askT - x.release).toFixed(1) },
    }
  })
  const scored = events.filter((e) => e.t_wall >= scoredFrom)
  const wakes = scored.filter((e) => e.decision === 'wake')
  const selfWakes = wakes.filter((e) => reafferent.has(e.channel) && !inStim(e.t_wall))
  const summary = {
    cond, block: b.trials[0]?.block, minutes: +minutes.toFixed(1), missed, overruns,
    wakesPerMin: +(wakes.length / minutes).toFixed(2),
    selfChannelWakesPerMinOutsideStimuli: +(selfWakes.length / minutes).toFixed(2),
    selfChannelWakesByChannel: Object.fromEntries([...new Set(selfWakes.map((e) => e.channel))].map((c) => [c, selfWakes.filter((e) => e.channel === c).length])),
    attributedEvents: scored.filter((e) => e.attribution === 'self').length,
    thoughts: thoughts.filter((t) => t.t_start >= scoredFrom).length,
    thoughtsPerMin: +(thoughts.filter((t) => t.t_start >= scoredFrom).length / minutes).toFixed(2),
  }
  return { rows, summary }
}

const all: { rows: any[]; summary: any }[] = []
for (const [i, cond] of ORDER.entries()) {
  const b = await runBlock(i, cond)
  const s = score(b, cond)
  s.rows.forEach((row) => out.write({ type: 'trial', ...row }))
  out.write({ type: 'block', ...s.summary })
  console.log(JSON.stringify(s.summary))
  all.push(s)
}

console.log('\n## Live stimulus benchmark (CPU burn, %d cores, %ds)', CORES, BURN_S)
console.log('efference | onset detected (≤10 s) | median onset s | release detected | median release s | external wake | report up | report down | self-channel wakes/min | wakes/min | missed ticks')
const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1]!.toFixed(2) : 'n/a')
for (const cond of ['off', 'on']) {
  const rows = all.filter((x) => x.summary.cond === cond).flatMap((x) => x.rows)
  const sums = all.filter((x) => x.summary.cond === cond).map((x) => x.summary)
  if (!rows.length) continue
  const mins = sums.reduce((a, s) => a + s.minutes, 0)
  const selfRate = sums.reduce((a, s) => a + s.selfChannelWakesPerMinOutsideStimuli * s.minutes, 0) / mins
  const wakeRate = sums.reduce((a, s) => a + s.wakesPerMin * s.minutes, 0) / mins
  console.log([
    cond, pct(rows.filter((x) => x.onsetLatency !== null).length, rows.length), med(rows.filter((x) => x.onsetLatency !== null).map((x) => x.onsetLatency)),
    pct(rows.filter((x) => x.releaseLatency !== null).length, rows.length), med(rows.filter((x) => x.releaseLatency !== null).map((x) => x.releaseLatency)),
    pct(rows.filter((x) => x.externalWake).length, rows.length), pct(rows.filter((x) => x.reportUp).length, rows.length),
    pct(rows.filter((x) => x.reportDown).length, rows.length), selfRate.toFixed(2), wakeRate.toFixed(2), sums.reduce((a, s) => a + s.missed, 0),
  ].join(' | '))
}
console.log(`results -> ${out.path}`)
