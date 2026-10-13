export type Mode = 'full' | 'no-delta'

export interface Config {
  tickHz: number
  mode: Mode
  timescalesS: { fast: number; medium: number; slow: number }
  surpriseZ: number
  logSalience: number
  wakeSalience: number
  habituationDecay: number
  habituationRecoverS: number
  wakeCooldownS: number
  wakesPerMinute: number
  stillTicks: number
  staleFactor: number
  levelRangeZ: number
  chainEveryS: number
  dataDir: string
  retentionFullDays: number
  retentionDownsampledDays: number
  llmUrl: string
  narrator: boolean
  efference: boolean
  habituationByDirection: boolean
  efferenceHousekeeping: boolean
  housekeepingReafferent: string[]
  housekeepingEveryS: number
  efferenceTailS: number
  efferenceDiscount: number
  reafferent: string[]
}

const num = (key: string, fallback: number) => {
  const v = process.env[key]
  return v === undefined ? fallback : Number(v)
}

export const loadConfig = (overrides: Partial<Config> = {}): Config => ({
  tickHz: num('CV1_TICK_HZ', 10),
  mode: (process.env.CV1_MODE as Mode) ?? 'full',
  timescalesS: { fast: 1, medium: 10, slow: 300 },
  surpriseZ: 4,
  logSalience: 2,
  wakeSalience: 8,
  habituationDecay: 0.5,
  habituationRecoverS: 60,
  wakeCooldownS: 30,
  wakesPerMinute: 4,
  stillTicks: 10,
  staleFactor: 5,
  levelRangeZ: 3.5,
  chainEveryS: 60,
  dataDir: process.env.CV1_DATA ?? 'data',
  retentionFullDays: num('CV1_RETENTION_FULL_DAYS', 7),
  retentionDownsampledDays: num('CV1_RETENTION_DOWNSAMPLED_DAYS', 90),
  llmUrl: process.env.CV1_LLM_URL ?? '',
  narrator: process.env.CV1_NARRATOR !== '0',
  efference: process.env.CV1_EFFERENCE !== '0',
  habituationByDirection: process.env.CV1_HAB_DIRECTION !== '0',
  efferenceHousekeeping: process.env.CV1_EFFERENCE_HOUSEKEEPING !== '0',
  housekeepingReafferent: ['self.main_lag_ms', 'self.tick_ms', 'body.disk.write', 'body.disk.read'],
  housekeepingEveryS: num('CV1_HOUSEKEEPING_S', 600),
  efferenceTailS: 15,
  efferenceDiscount: 0.1,
  reafferent: [
    'body.gpu.util', 'body.gpu.power', 'body.gpu.temp', 'brain.busy_slots', 'brain.gen_tok',
    'mind.active', 'mind.confidence', 'self.tick_ms', 'self.main_lag_ms',
  ],
  ...overrides,
})
