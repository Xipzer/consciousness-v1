import { readFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { chat } from '../src/mind/llm.ts'
import { arg, results } from './lib.ts'

const url = process.env.CV1_LLM_URL ?? ''
const phaseS = arg('phase', 120)
const out = results('t9')
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000))

const llmLoad = (stopAt: number) =>
  Promise.all([0, 1].map(async (slot) => {
    while (Date.now() / 1000 < stopAt) {
      await chat({ url, system: 'You write long essays.', user: 'Write a long essay about clocks.', maxTokens: 400, slot, temperature: 0.8 }).catch(() => {})
    }
  }))

const cpuLoad = (seconds: number) =>
  Bun.spawn(['sh', '-c', `for i in $(seq ${cpus().length}); do timeout ${seconds} sh -c 'while :; do :; done' & done; wait`])

const phases: { name: string; t0: number; t1: number }[] = []
const phase = async (name: string, run: (stopAt: number) => Promise<unknown>) => {
  const t0 = Date.now() / 1000
  console.log(`${new Date().toISOString()} phase ${name} (${phaseS}s)`)
  await run(t0 + phaseS)
  phases.push({ name, t0, t1: Date.now() / 1000 })
}

await phase('idle', () => sleep(phaseS))
await phase('llm-2-slots', (stopAt) => llmLoad(stopAt))
await phase('cpu-all-cores', async () => {
  await cpuLoad(phaseS).exited
})
await phase('llm+cpu', async (stopAt) => {
  const p = cpuLoad(phaseS)
  await llmLoad(stopAt)
  await p.exited
})
await sleep(12)

const lines = readFileSync('data/daemon.log', 'utf8').split('\n')
const stats = lines
  .map((l) => /^(\S+) ticks=(\d+) overruns=(\d+) missed=(\d+) tick_ms p50=(\S+) p99=(\S+) max=(\S+)/.exec(l))
  .filter((m) => m !== null)
  .map((m) => ({ t: Date.parse(m[1]!) / 1000, ticks: +m[2]!, overruns: +m[3]!, missed: +m[4]!, p50: +m[5]!, p99: +m[6]!, max: +m[7]! }))

console.log('\n## T9 non-blocking tick (10 s windows from the running daemon)')
console.log('phase | windows | worst p50 ms | worst p99 ms | max ms | overruns | missed ticks')
for (const p of phases) {
  const w = stats.filter((s) => s.t > p.t0 + 10 && s.t <= p.t1)
  const before = stats.filter((s) => s.t <= p.t0 + 10).at(-1)
  const last = w.at(-1)
  const row = {
    phase: p.name, windows: w.length,
    p50: Math.max(...w.map((s) => s.p50)), p99: Math.max(...w.map((s) => s.p99)), max: Math.max(...w.map((s) => s.max)),
    overruns: last && before ? last.overruns - before.overruns : null, missed: last && before ? last.missed - before.missed : null,
  }
  out.write(row)
  console.log(`${row.phase} | ${row.windows} | ${row.p50.toFixed(3)} | ${row.p99.toFixed(3)} | ${row.max.toFixed(3)} | ${row.overruns} | ${row.missed}`)
}
