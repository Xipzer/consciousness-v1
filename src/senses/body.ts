import { readFileSync } from 'node:fs'
import type { Latest } from '../core/types.ts'

const now = () => performance.now() / 1000
const read = (p: string) => readFileSync(p, 'utf8')

const cpuTimes = () =>
  read('/proc/stat')
    .split('\n')
    .filter((l) => l.startsWith('cpu'))
    .map((l) => {
      const f = l.trim().split(/\s+/).slice(1).map(Number)
      const idle = (f[3] ?? 0) + (f[4] ?? 0)
      return { idle, total: f.reduce((a, b) => a + b, 0) }
    })

const meminfo = () => {
  const m = new Map(read('/proc/meminfo').split('\n').map((l) => {
    const [k, v] = l.split(':')
    return [k ?? '', Number.parseInt(v ?? '0')] as const
  }))
  const g = (k: string) => m.get(k) ?? 0
  return { used: 1 - g('MemAvailable') / g('MemTotal'), swap: g('SwapTotal') ? 1 - g('SwapFree') / g('SwapTotal') : 0 }
}

const netBytes = () =>
  read('/proc/net/dev')
    .split('\n')
    .slice(2)
    .map((l) => l.trim().split(/[:\s]+/))
    .filter((f) => f[0] && f[0] !== 'lo')
    .reduce((acc, f) => ({ rx: acc.rx + Number(f[1]), tx: acc.tx + Number(f[9]) }), { rx: 0, tx: 0 })

const diskBytes = () =>
  read('/proc/diskstats')
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f[2] && /^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+)$/.test(f[2]))
    .reduce((acc, f) => ({ r: acc.r + Number(f[5]) * 512, w: acc.w + Number(f[9]) * 512 }), { r: 0, w: 0 })

export const startProcSensors = (latest: Latest) => {
  let prevCpu = cpuTimes()
  const fast = setInterval(() => {
    const cur = cpuTimes()
    const t = now()
    const loads = cur.map((c, i) => {
      const p = prevCpu[i]!
      const dt = c.total - p.total
      return dt > 0 ? 1 - (c.idle - p.idle) / dt : 0
    })
    prevCpu = cur
    latest.set('body.cpu.load', { value: loads[0] ?? 0, t })
    latest.set('body.cpu.max_core', { value: Math.max(...loads.slice(1)), t })
  }, 200)

  let prev = { net: netBytes(), disk: diskBytes(), t: now() }
  const slow = setInterval(() => {
    const t = now()
    const net = netBytes()
    const disk = diskBytes()
    const dt = t - prev.t
    const mem = meminfo()
    latest.set('body.host.uptime', { value: Number.parseFloat(read('/proc/uptime')), t })
    latest.set('body.mem.used', { value: mem.used, t })
    latest.set('body.swap.used', { value: mem.swap, t })
    latest.set('body.net.rx', { value: (net.rx - prev.net.rx) / dt, t })
    latest.set('body.net.tx', { value: (net.tx - prev.net.tx) / dt, t })
    latest.set('body.disk.read', { value: (disk.r - prev.disk.r) / dt, t })
    latest.set('body.disk.write', { value: (disk.w - prev.disk.w) / dt, t })
    prev = { net, disk, t }
  }, 1000)

  return () => {
    clearInterval(fast)
    clearInterval(slow)
  }
}

export const startGpuSensor = (latest: Latest) => {
  const proc = Bun.spawn(
    ['nvidia-smi', '--query-gpu=temperature.gpu,utilization.gpu,memory.used,power.draw', '--format=csv,noheader,nounits', '-lms', '200'],
    { stdout: 'pipe', stderr: 'ignore' },
  )
  const names = ['body.gpu.temp', 'body.gpu.util', 'body.gpu.mem', 'body.gpu.power']
  ;(async () => {
    let buf = ''
    const decoder = new TextDecoder()
    for await (const chunk of proc.stdout) {
      buf += decoder.decode(chunk)
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const vals = line.split(',').map((v) => Number(v.trim()))
        if (vals.length !== 4 || vals.some(Number.isNaN)) continue
        const t = now()
        vals.forEach((v, i) => latest.set(names[i]!, { value: v, t }))
      }
    }
  })()
  return () => proc.kill()
}

export const startBrainSensor = (latest: Latest, url: string) => {
  let prevTok: number | null = null
  const poll = async () => {
    const t = now()
    try {
      const [slots, metrics] = await Promise.all([
        fetch(`${url}/slots`, { signal: AbortSignal.timeout(800) }).then((r) => r.json() as Promise<{ is_processing: boolean }[]>),
        fetch(`${url}/metrics`, { signal: AbortSignal.timeout(800) }).then((r) => r.text()),
      ])
      const tok = Number(/^llamacpp:tokens_predicted_total (\S+)/m.exec(metrics)?.[1] ?? 0)
      latest.set('brain.up', { value: 1, t })
      latest.set('brain.busy_slots', { value: slots.filter((s) => s.is_processing).length, t })
      latest.set('brain.gen_tok', { value: prevTok === null ? 0 : Math.max(tok - prevTok, 0), t })
      prevTok = tok
    } catch {
      latest.set('brain.up', { value: 0, t })
    }
  }
  const timer = setInterval(poll, 1000)
  return () => clearInterval(timer)
}
