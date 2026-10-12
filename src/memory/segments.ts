import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TickOut } from '../core/types.ts'

export const HEADER = ['tMono', 'tWall', 'tick', 'tickMs', 'change', 'maxSalience'] as const

export const frameBytes = (n: number) => HEADER.length * 8 + n * 8

export const hourKey = (tWall: number) => new Date(tWall * 1000).toISOString().slice(0, 13).replace(/[-:T]/g, '')

export class SegmentWriter {
  private buf: Uint8Array[] = []
  private key = ''

  constructor(private readonly dir: string, private readonly channels: string[]) {
    mkdirSync(dir, { recursive: true })
  }

  push(t: TickOut, tickMs: number) {
    const key = hourKey(t.tWall)
    if (key !== this.key) {
      this.flush()
      this.key = key
      const manifest = join(this.dir, `${key}.json`)
      if (!existsSync(manifest)) writeFileSync(manifest, JSON.stringify({ header: HEADER, channels: this.channels }))
    }
    const n = this.channels.length
    const frame = new ArrayBuffer(frameBytes(n))
    new Float64Array(frame, 0, HEADER.length).set([t.tMono, t.tWall, t.tick, tickMs, t.change, t.maxSalience])
    const body = new Float32Array(frame, HEADER.length * 8, n * 2)
    body.set(t.values, 0)
    body.set(t.ages, n)
    this.buf.push(new Uint8Array(frame))
  }

  flush() {
    if (!this.buf.length || !this.key) return
    appendFileSync(join(this.dir, `${this.key}.bin`), Buffer.concat(this.buf))
    this.buf = []
  }

  get currentKey() {
    return this.key
  }
}

export interface Frame {
  tMono: number
  tWall: number
  tick: number
  tickMs: number
  change: number
  maxSalience: number
  values: Float32Array
  ages: Float32Array
}

export const readSegment = (dir: string, key: string): { channels: string[]; frames: Frame[] } => {
  const { channels } = JSON.parse(readFileSync(join(dir, `${key}.json`), 'utf8')) as { channels: string[] }
  const raw = existsSync(join(dir, `${key}.bin`))
    ? readFileSync(join(dir, `${key}.bin`))
    : Bun.zstdDecompressSync(readFileSync(join(dir, `${key}.bin.zst`)))
  const n = channels.length
  const size = frameBytes(n)
  const bytes = new Uint8Array(raw)
  const frames: Frame[] = []
  for (let off = 0; off + size <= bytes.length; off += size) {
    const ab = bytes.slice(off, off + size).buffer
    const h = new Float64Array(ab, 0, HEADER.length)
    const body = new Float32Array(ab, HEADER.length * 8, n * 2)
    frames.push({
      tMono: h[0]!, tWall: h[1]!, tick: h[2]!, tickMs: h[3]!, change: h[4]!, maxSalience: h[5]!,
      values: body.slice(0, n), ages: body.slice(n),
    })
  }
  return { channels, frames }
}

export const listSegments = (dir: string) =>
  existsSync(dir)
    ? [...new Set(readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)))].sort()
    : []

const keyAgeDays = (key: string, nowWall: number) => {
  const t = Date.UTC(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6, 8), +key.slice(8, 10)) / 1000
  return (nowWall - t) / 86400
}

export interface RetentionReport {
  compressed: string[]
  downsampled: string[]
  deleted: string[]
  bytes: number
}

export const enforceRetention = (
  dir: string,
  opts: { currentKey: string; fullDays: number; downsampledDays: number; nowWall: number; tickHz: number },
): RetentionReport => {
  const rep: RetentionReport = { compressed: [], downsampled: [], deleted: [], bytes: 0 }
  const liveKey = hourKey(opts.nowWall)
  for (const key of listSegments(dir)) {
    if (key === opts.currentKey || key >= liveKey) continue
    const age = keyAgeDays(key, opts.nowWall)
    const p = (ext: string) => join(dir, `${key}${ext}`)
    if (age > opts.downsampledDays) {
      for (const ext of ['.json', '.bin', '.bin.zst', '.ds']) if (existsSync(p(ext))) unlinkSync(p(ext))
      rep.deleted.push(key)
      continue
    }
    if (age > opts.fullDays && !existsSync(p('.ds'))) {
      const { channels, frames } = readSegment(dir, key)
      const step = Math.max(1, Math.round(opts.tickHz))
      const kept = frames.filter((_, i) => i % step === 0)
      const n = channels.length
      const out = new Uint8Array(kept.length * frameBytes(n))
      kept.forEach((f, i) => {
        const ab = new ArrayBuffer(frameBytes(n))
        new Float64Array(ab, 0, HEADER.length).set([f.tMono, f.tWall, f.tick, f.tickMs, f.change, f.maxSalience])
        const body = new Float32Array(ab, HEADER.length * 8, n * 2)
        body.set(f.values, 0)
        body.set(f.ages, n)
        out.set(new Uint8Array(ab), i * frameBytes(n))
      })
      writeFileSync(p('.bin.zst'), Bun.zstdCompressSync(out, { level: 6 }))
      if (existsSync(p('.bin'))) unlinkSync(p('.bin'))
      writeFileSync(p('.ds'), JSON.stringify({ downsampledTo: 1 }))
      rep.downsampled.push(key)
      continue
    }
    if (existsSync(p('.bin'))) {
      writeFileSync(p('.bin.zst'), Bun.zstdCompressSync(readFileSync(p('.bin')), { level: 6 }))
      unlinkSync(p('.bin'))
      rep.compressed.push(key)
    }
  }
  for (const f of existsSync(dir) ? readdirSync(dir) : []) rep.bytes += statSync(join(dir, f)).size
  return rep
}
