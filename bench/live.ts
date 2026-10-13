import { Database } from 'bun:sqlite'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config.ts'
import { arg, gauss, pct, results, rng } from './lib.ts'

const ORDER = (process.argv.find((a) => a.startsWith('--order='))?.slice(8) ?? 'on,off,off,on').split(',')
const TRIALS = arg('trials', 8)
const WARMUP_S = arg('warmup', 90)
const STEP_SD = arg('step', 3)
const HOLD_S = arg('hold', 15)
const CPU = process.argv.find((a) => a.startsWith('--cpu='))?.slice(6) ?? ''
const [CPU_THREADS, CPU_SECONDS] = CPU ? CPU.split('x').map(Number) : [0, 0]
const THERMAL_LIMIT_C = 80
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

const guard = {
  cpuTempC: null as number | null,
  cpuPowerW: null as number | null,
  gpuTempC: null as number | null,
  maxCpuC: 0,
  maxGpuC: 0,
  tripped: '' as string,
  procs: [] as ReturnType<typeof Bun.spawn>[],
}

const readLines = async (stream: ReadableStream<Uint8Array>, onLine: (l: string) => void) => {
  let buf = ''
  const dec = new TextDecoder()
  for await (const chunk of stream) {
    buf += dec.decode(chunk)
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    lines.forEach((l) => onLine(l.replace('\r', '')))
  }
}

const stimuli = new Set<number>()
const killStimuli = () => {
  for (const pid of stimuli) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {}
  }
  stimuli.clear()
}

const trip = (why: string) => {
  if (guard.tripped) return
  guard.tripped = why
  killStimuli()
  console.error(`THERMAL GUARD TRIPPED: ${why}; all stimuli killed`)
}

const startGuard = () => {
  const gpu = Bun.spawn(['nvidia-smi', '--query-gpu=temperature.gpu', '--format=csv,noheader,nounits', '-lms', '1000'], { stdout: 'pipe' })
  void readLines(gpu.stdout, (l) => {
    const t = Number(l)
    if (!Number.isFinite(t)) return
    guard.gpuTempC = t
    guard.maxGpuC = Math.max(guard.maxGpuC, t)
    if (t > THERMAL_LIMIT_C) trip(`GPU ${t} C > ${THERMAL_LIMIT_C} C`)
  })
  mkdirSync('/mnt/c/cv1', { recursive: true })
  copyFileSync('scripts/cpu-thermal.ps1', '/mnt/c/cv1/cpu-thermal.ps1')
  const cpu = Bun.spawn(['/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\cv1\\cpu-thermal.ps1'], { stdout: 'pipe', cwd: '/mnt/c' })
  void readLines(cpu.stdout, (l) => {
    try {
      const j = JSON.parse(l) as { cpuTempC?: number; cpuPowerW?: number; error?: string }
      if (j.cpuTempC === undefined) {
        guard.cpuTempC = null
        return
      }
      guard.cpuTempC = j.cpuTempC
      guard.cpuPowerW = j.cpuPowerW ?? null
      guard.maxCpuC = Math.max(guard.maxCpuC, j.cpuTempC)
      if (j.cpuTempC > THERMAL_LIMIT_C) trip(`CPU ${j.cpuTempC} C > ${THERMAL_LIMIT_C} C`)
    } catch {}
  })
  guard.procs.push(gpu, cpu)
}

const stopAll = () => {
  killStimuli()
  guard.procs.forEach((p) => p.kill())
}
process.on('SIGINT', () => {
  stopAll()
  process.exit(130)
})
process.on('exit', stopAll)

const inject = (value: number) => fetch(`${BASE}/inject?channel=test.live&value=${value}`, { method: 'POST' }).catch(() => {})

const cpuPulse = async () => {
  if (guard.cpuTempC === null) throw new Error('CPU stimulus refused: no CPU temperature reading for the thermal guard')
  const p = Bun.spawn(['setsid', 'sh', '-c', `for i in $(seq ${CPU_THREADS}); do timeout ${CPU_SECONDS} sh -c 'while :; do :; done' & done; wait`])
  stimuli.add(p.pid)
  await p.exited
  stimuli.delete(p.pid)
}

interface Trial { kind: 'synthetic' | 'cpu'; channel: string; onset: number; release: number; askT: number; report: any }

const runBlock = async (block: number, cond: string) => {
  const dir = join('data-bench', `b${block}-${cond}`)
  if (existsSync(dir)) rmSync(dir, { recursive: true })
  mkdirSync(dir, { recursive: true })
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    env: { ...process.env, CV1_DATA: dir, CV1_EFFERENCE: cond === 'on' ? '1' : '0', CV1_ASK_PORT: String(PORT) },
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
  const kinds = Array.from({ length: TRIALS }, (_, i) => (CPU && i % 2 === 1 ? 'cpu' : 'synthetic') as Trial['kind'])
  for (const kind of kinds) {
    if (guard.tripped) break
    await sleep(30 + r() * 15)
    const onset = now()
    if (kind === 'synthetic') {
      level = (r() < 0.5 ? 1 : -1) * STEP_SD
      await sleep(HOLD_S)
      level = 0
    } else {
      await cpuPulse()
    }
    const release = now()
    await sleep(ASK_AFTER_S)
    const channel = kind === 'synthetic' ? 'test.live' : 'body.cpu.load'
    const askT = now()
    const res = (await fetch(`${BASE}/ask?channel=${channel}&window=60`).then((x) => x.json()).catch(() => null)) as any
    trials.push({ kind, channel, onset, release, askT, report: res?.report ?? null })
    console.log(`  ${kind} ${(release - onset).toFixed(1)}s, cpu ${guard.cpuTempC ?? 'n/a'} C, report ${JSON.stringify(res?.report?.changes ?? null)}`)
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
  const summary = {
    cond, minutes: +minutes.toFixed(2), missed, wakes: wakes.length, selfWakesAll: selfAll.length, selfWakesOutside: selfOutside.length,
    selfWakesByChannel: Object.fromEntries([...new Set(selfAll.map((e) => e.channel))].map((c) => [c, selfAll.filter((e) => e.channel === c).length])),
    attributed: scored.filter((e) => e.attribution === 'self').length, thoughts: thoughts.filter((t) => t.t_start >= scoredFrom).length,
  }
  return { rows, summary, events, thoughts }
}

startGuard()
await sleep(3)
console.log(`guard: cpu ${guard.cpuTempC ?? 'unavailable'} C, gpu ${guard.gpuTempC} C; cpu stimulus ${CPU || 'off'}`)
if (CPU && guard.cpuTempC === null) throw new Error('CPU stimulus requested but no CPU temperature is available for the guard')

const all: Awaited<ReturnType<typeof score>>[] = []
for (const [i, cond] of ORDER.entries()) {
  if (guard.tripped) break
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
out.write({ type: 'guard', maxCpuC: guard.maxCpuC || null, maxGpuC: guard.maxGpuC, tripped: guard.tripped || null })

const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1]!.toFixed(2) : 'n/a')
console.log(`\n## Live benchmark (synthetic step ${STEP_SD} sd for ${HOLD_S}s${CPU ? `, CPU ${CPU_THREADS} threads x ${CPU_SECONDS}s` : ''})`)
console.log('efference | kind | onset ≤10 s | median onset s | release ≤10 s | median release s | wake on stimulus | report onset | report release')
for (const cond of ['off', 'on']) {
  for (const kind of ['synthetic', 'cpu']) {
    const rows = all.filter((x) => x.summary.cond === cond).flatMap((x) => x.rows).filter((x) => x.kind === kind)
    if (!rows.length) continue
    const n = rows.length
    console.log([cond, kind, pct(rows.filter((x) => x.onsetLatency !== null).length, n), med(rows.flatMap((x) => (x.onsetLatency === null ? [] : [x.onsetLatency]))),
      pct(rows.filter((x) => x.releaseLatency !== null).length, n), med(rows.flatMap((x) => (x.releaseLatency === null ? [] : [x.releaseLatency]))),
      pct(rows.filter((x) => x.externalWake).length, n), pct(rows.filter((x) => x.reportOnset).length, n), pct(rows.filter((x) => x.reportRelease).length, n)].join(' | '))
  }
}
console.log('\nefference | minutes | wakes | self-channel wakes (all) | per min | self-channel wakes outside stimuli | per min | thoughts | missed ticks')
for (const cond of ['off', 'on']) {
  const ss = all.filter((x) => x.summary.cond === cond).map((x) => x.summary)
  if (!ss.length) continue
  const sum = (k: keyof (typeof ss)[0]) => ss.reduce((a, s) => a + (s[k] as number), 0)
  const m = sum('minutes')
  console.log([cond, m.toFixed(1), sum('wakes'), sum('selfWakesAll'), (sum('selfWakesAll') / m).toFixed(2), sum('selfWakesOutside'), (sum('selfWakesOutside') / m).toFixed(2), sum('thoughts'), sum('missed')].join(' | '))
}
console.log(`guard: max CPU ${guard.maxCpuC || 'n/a'} C, max GPU ${guard.maxGpuC} C, tripped: ${guard.tripped || 'no'}`)
console.log(`results -> ${out.path}`)
stopAll()
process.exit(0)
