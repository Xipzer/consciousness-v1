import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Frame } from '../src/memory/segments.ts'
import { listSegments, readSegment } from '../src/memory/segments.ts'
import type { Latest } from '../src/core/types.ts'

export const rng = (seed: number) => {
  let s = seed >>> 0 || 1
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

export const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r())

export const shuffle = <T>(xs: T[], r: () => number) => {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

export interface Background {
  channels: string[]
  frames: Frame[]
  durationS: number
}

export const loadBackground = (dataDir = 'data'): Background => {
  const dir = join(dataDir, 'ticks')
  const keys = listSegments(dir)
  if (!keys.length) throw new Error(`no recorded segments in ${dir}; run the daemon first`)
  let channels: string[] = []
  const frames: Frame[] = []
  for (const k of keys) {
    const s = readSegment(dir, k)
    channels = s.channels
    frames.push(...s.frames)
  }
  frames.sort((a, b) => a.tWall - b.tWall)
  const durationS = frames[frames.length - 1]!.tWall - frames[0]!.tWall
  return { channels, frames, durationS }
}

export class Replay {
  private i = 0
  private offset = 0
  private readonly base: number
  private readonly skip: Set<string>

  constructor(private readonly bg: Background, start = 0, skip: string[] = ['test.a']) {
    this.base = bg.frames[0]!.tWall
    this.skip = new Set(skip)
    this.i = Math.floor(start) % bg.frames.length
    this.offset = -(bg.frames[this.i]!.tWall - this.base)
  }

  advance(simT: number, latest: Latest) {
    const fr = this.bg.frames
    while (true) {
      const f = fr[this.i]!
      const ft = f.tWall - this.base + this.offset
      if (ft > simT) return
      this.bg.channels.forEach((c, j) => {
        const age = f.ages[j]!
        if (this.skip.has(c) || age < 0) return
        const t = ft - age
        const prev = latest.get(c)
        if (!prev || t > prev.t) latest.set(c, { value: f.values[j]!, t })
      })
      this.i++
      if (this.i >= fr.length) {
        this.i = 0
        this.offset += this.bg.durationS + 0.1
      }
    }
  }

  shift(dt: number) {
    this.offset += dt
  }
}

export const results = (name: string) => {
  mkdirSync('results', { recursive: true })
  const path = join('results', `${name}-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.jsonl`)
  return { path, write: (o: object) => appendFileSync(path, JSON.stringify(o) + '\n') }
}

export const wilson = (k: number, n: number, z = 1.96) => {
  if (!n) return [0, 0] as const
  const p = k / n
  const d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [(c - m) / d, (c + m) / d] as const
}

const logChoose = (n: number, k: number) => {
  let s = 0
  for (let i = 1; i <= k; i++) s += Math.log((n - k + i) / i)
  return s
}

export const mcnemar = (a: boolean[], b: boolean[]) => {
  let onlyA = 0
  let onlyB = 0
  a.forEach((x, i) => {
    if (x && !b[i]) onlyA++
    if (!x && b[i]) onlyB++
  })
  const n = onlyA + onlyB
  const k = Math.min(onlyA, onlyB)
  let p = 0
  for (let i = 0; i <= k; i++) p += Math.exp(logChoose(n, i) - n * Math.LN2)
  return { onlyA, onlyB, p: n ? Math.min(1, 2 * p) : 1 }
}

export const pairedBootstrapDiff = (a: boolean[], b: boolean[], iters = 5000, seed = 1) => {
  const r = rng(seed)
  const n = a.length
  const diffs: number[] = []
  for (let it = 0; it < iters; it++) {
    let s = 0
    for (let i = 0; i < n; i++) {
      const j = Math.floor(r() * n)
      s += (a[j] ? 1 : 0) - (b[j] ? 1 : 0)
    }
    diffs.push(s / n)
  }
  diffs.sort((x, y) => x - y)
  const mean = a.reduce((s, x, i) => s + (x ? 1 : 0) - (b[i] ? 1 : 0), 0) / n
  return { mean, lo: diffs[Math.floor(iters * 0.025)]!, hi: diffs[Math.floor(iters * 0.975)]! }
}

export const pct = (k: number, n: number) => {
  const [lo, hi] = wilson(k, n)
  return `${((100 * k) / Math.max(n, 1)).toFixed(0)}% [${(100 * lo).toFixed(0)}-${(100 * hi).toFixed(0)}] (${k}/${n})`
}

export const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? Number(process.argv[i + 1]) : fallback
}
