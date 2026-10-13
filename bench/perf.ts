import { Database } from 'bun:sqlite'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dataDir = process.argv.find((a, i) => i > 1 && !a.startsWith('--')) ?? 'data'
const sinceArg = process.argv.find((a) => a.startsWith('--since='))?.slice(8)
const since = sinceArg ? Date.parse(sinceArg) : 0
const logs = readdirSync(dataDir).filter((f) => /^daemon.*\.log$/.test(f)).map((f) => readFileSync(join(dataDir, f), 'utf8')).join('\n')
const stats = [...logs.matchAll(/^(\S+) ticks=(\d+) overruns=(\d+) missed=(\d+) tick_ms p50=(\S+) p99=(\S+) max=(\S+)/gm)].map((m) => ({
  t: Date.parse(m[1]!), overruns: +m[3]!, missed: +m[4]!, p50: +m[5]!, p99: +m[6]!, max: +m[7]!,
})).filter((s) => s.t >= since)
const q = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : Number.NaN
}
console.log('## Passive architecture performance (normal operation, no induced load)')
console.log(`stats windows: ${stats.length} (10 s each, ${((stats.length * 10) / 3600).toFixed(1)} h)`)
console.log(`tick compute ms: median of window p50 ${q(stats.map((s) => s.p50), 0.5).toFixed(3)}, median window p99 ${q(stats.map((s) => s.p99), 0.5).toFixed(3)}, 99th pct of window p99 ${q(stats.map((s) => s.p99), 0.99).toFixed(3)}, worst max ${Math.max(...stats.map((s) => s.max)).toFixed(3)}`)
console.log(`overruns (tick compute > period): ${stats.filter((s) => s.overruns > 0).length ? Math.max(...stats.map((s) => s.overruns)) : 0} per run max; missed ticks: ${Math.max(0, ...stats.map((s) => s.missed))} per run max`)

const dbPath = join(dataDir, 'mind.db')
if (existsSync(dbPath)) {
  const db = new Database(dbPath, { readonly: true })
  const hasInterrupt = (db.query('PRAGMA table_info(thoughts)').all() as { name: string }[]).some((c) => c.name === 'interrupt_ms')
  const thoughts = db.query(`SELECT t_start, t_end, trigger, status, ${hasInterrupt ? 'interrupt_ms' : 'NULL AS interrupt_ms'} FROM thoughts`).all() as { t_start: number; t_end: number; trigger: string; status: string; interrupt_ms: number | null }[]
  const evTime = db.query('SELECT t_wall FROM events WHERE id = ?')
  const starts: number[] = []
  for (const t of thoughts.filter((x) => (x.status === 'done' || x.status === 'interrupted') && x.t_start * 1000 >= since)) {
    const ids = JSON.parse(t.trigger ?? '[]') as string[]
    const times = ids.map((id) => (evTime.get(id) as { t_wall: number } | null)?.t_wall).filter((x): x is number => x !== undefined)
    if (times.length) starts.push((t.t_start - Math.min(...times)) * 1000)
  }
  const durations = thoughts.filter((x) => x.status === 'done').map((x) => (x.t_end - x.t_start) * 1000)
  const interrupts = thoughts.map((x) => x.interrupt_ms).filter((x): x is number => x !== null)
  const by = Object.fromEntries([...new Set(thoughts.map((x) => x.status.split(':')[0]))].map((s) => [s, thoughts.filter((x) => x.status.split(':')[0] === s).length]))
  console.log(`thoughts: ${JSON.stringify(by)}`)
  console.log(`thought start latency ms (wake event to request): p50 ${q(starts, 0.5).toFixed(1)}, p99 ${q(starts, 0.99).toFixed(1)}, n=${starts.length}`)
  console.log(`thought duration ms: p50 ${q(durations, 0.5).toFixed(0)}, p90 ${q(durations, 0.9).toFixed(0)}`)
  console.log(`interrupt latency ms (abort to slot released): ${interrupts.length ? `p50 ${q(interrupts, 0.5).toFixed(1)}, max ${Math.max(...interrupts).toFixed(1)}, n=${interrupts.length}` : 'no interrupts logged since interrupt_ms was added'}`)
  db.close()
}
for (const l of logs.split('\n').filter((l) => l.includes('storage:')).slice(-3)) console.log(l)
