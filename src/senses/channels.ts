import type { ChannelDef } from '../core/types.ts'

const ch = (name: string, unit: string, periodS: number, minSigma: number, extra: Partial<ChannelDef> = {}): ChannelDef => ({
  name, unit, periodS, minSigma, ...extra,
})

export const BODY: ChannelDef[] = [
  ch('body.cpu.load', 'frac', 0.2, 0.005),
  ch('body.cpu.max_core', 'frac', 0.2, 0.01),
  ch('body.mem.used', 'frac', 1, 0.0005),
  ch('body.swap.used', 'frac', 1, 0.0005),
  ch('body.net.rx', 'B/s', 1, 2000),
  ch('body.net.tx', 'B/s', 1, 2000),
  ch('body.disk.read', 'B/s', 1, 8192),
  ch('body.disk.write', 'B/s', 1, 8192),
  ch('body.gpu.temp', 'C', 0.2, 0.5),
  ch('body.gpu.util', '%', 0.2, 1),
  ch('body.gpu.mem', 'MiB', 0.2, 2),
  ch('body.gpu.power', 'W', 0.2, 0.5),
  ch('body.host.uptime', 's', 1, 0.01, { excludeFromChange: true }),
]

export const SELF: ChannelDef[] = [
  ch('self.tick_ms', 'ms', 0.1, 0.05),
  ch('self.main_lag_ms', 'ms', 0.5, 0.2),
]

export const BRAIN: ChannelDef[] = [
  ch('brain.up', 'bool', 1, 0.5),
  ch('brain.busy_slots', 'n', 1, 0.5),
  ch('brain.gen_tok', 'tok', 1, 1),
]

export const MIND: ChannelDef[] = [
  ch('mind.active', 'n', 3600, 0.5),
  ch('mind.confidence', 'p', 3600, 0.01),
]

export const TEST: ChannelDef[] = [ch('test.a', 'u', 0.1, 0.01)]

export const ALL_CHANNELS = [...BODY, ...SELF, ...BRAIN, ...MIND, ...TEST]
