import type { CoreEvent, SelfModel } from '../core/types.ts'

export const SYSTEM = `You are the reporting thread of a system that runs continuously and senses its own body (hardware), \
its own process and its own thoughts as numeric channels. You perceive only the data given to you. Report only what \
that data supports; never invent channels or events. Answer with the JSON object requested.`

export const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    changes: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        properties: {
          channel: { type: 'string' },
          direction: { type: 'string', enum: ['up', 'down', 'stopped', 'resumed'] },
          seconds_ago: { type: 'number' },
        },
        required: ['channel', 'direction', 'seconds_ago'],
      },
    },
    still: { type: 'boolean' },
    still_for_s: { type: ['number', 'null'] },
    gap_s: { type: ['number', 'null'] },
    confidence: { type: 'number' },
    note: { type: 'string', maxLength: 240 },
  },
  required: ['changes', 'still', 'still_for_s', 'gap_s', 'confidence', 'note'],
}

export const CHANNEL_SCHEMA = {
  type: 'object',
  properties: {
    changes: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down', 'stopped', 'resumed'] },
          seconds_ago: { type: 'number' },
        },
        required: ['direction', 'seconds_ago'],
      },
    },
    confidence: { type: 'number' },
  },
  required: ['changes', 'confidence'],
}

export interface ChannelReport {
  changes: { direction: 'up' | 'down' | 'stopped' | 'resumed'; seconds_ago: number }[]
  confidence: number
}

export const STILL_SCHEMA = {
  type: 'object',
  properties: {
    still_now: { type: 'boolean' },
    still_now_for_s: { type: ['number', 'null'] },
    last_stillness_period_s: { type: ['number', 'null'] },
    last_time_gap_s: { type: ['number', 'null'] },
    confidence: { type: 'number' },
  },
  required: ['still_now', 'still_now_for_s', 'last_stillness_period_s', 'last_time_gap_s', 'confidence'],
}

export interface StillReport {
  still_now: boolean
  still_now_for_s: number | null
  last_stillness_period_s: number | null
  last_time_gap_s: number | null
  confidence: number
}

const f = (x: number) => (Math.abs(x) >= 1000 || (Math.abs(x) < 0.01 && x !== 0) ? x.toExponential(2) : +x.toFixed(3))

const renderEvent = (e: CoreEvent, nowWall: number) => {
  const ago = (nowWall - e.tWall).toFixed(1)
  const parts = [`${ago}s ago`, e.kind]
  if (e.channel) parts.push(e.channel)
  if (e.direction) parts.push(e.direction > 0 ? 'up' : 'down')
  if (e.timescale) parts.push(`timescale=${e.timescale}`)
  if (e.z !== undefined && e.kind === 'change') parts.push(`z=${e.z.toFixed(1)}`)
  if (e.durationS !== undefined) parts.push(`duration=${e.durationS.toFixed(1)}s`)
  return `- ${parts.join(' ')}`
}

const selfSummary = (self: SelfModel, events: CoreEvent[], nowWall: number, windowS: number) => {
  const inWindow = events.filter((e) => nowWall - e.tWall <= windowS)
  const periods = inWindow.filter((e) => e.kind === 'moved')
  const gaps = inWindow.filter((e) => e.kind === 'gap')
  const lines = [
    'SELF SUMMARY (computed from your own state history):',
    self.still
      ? `- right now: STILL. No channel has changed for ${self.stillForS.toFixed(1)}s.`
      : '- right now: MOVING. Channels are changing.',
    periods.length
      ? periods.map((e) => `- stillness period: nothing changed for ${e.durationS!.toFixed(1)}s, ended ${(nowWall - e.tWall).toFixed(1)}s ago`).join('\n')
      : `- no completed stillness period in the last ${windowS}s`,
    gaps.length
      ? gaps.map((e) => `- time gap: you were not running for ${e.durationS!.toFixed(1)}s, ended ${(nowWall - e.tWall).toFixed(1)}s ago`).join('\n')
      : `- no time gap in the last ${windowS}s`,
  ]
  return lines.join('\n')
}

export const renderFull = (self: SelfModel, events: CoreEvent[], nowWall: number, windowS = 120) => {
  const lines = [
    selfSummary(self, events, nowWall, windowS),
    '',
    `now: ${new Date(nowWall * 1000).toISOString()}`,
    `uptime_s: ${self.uptimeS.toFixed(1)}  tick: ${self.tick}`,
    'body (channel: value | baseline | velocity/s over 1s | velocity/s over 10s | noise sd):',
    ...Object.entries(self.body).map(
      ([k, v]) => `  ${k}: ${f(v.value)} | ${f(v.baseline)} | ${f(v.velocityFast)} | ${f(v.velocityMedium)} | ${f(v.sigma)}`,
    ),
    `events in the last ${windowS}s (newest first):`,
    ...events.filter((e) => nowWall - e.tWall <= windowS && e.decision !== 'ignore').reverse().slice(0, 60).map((e) => renderEvent(e, nowWall)),
  ]
  return lines.join('\n')
}

export const renderLevelOnly = (self: SelfModel, events: CoreEvent[], nowWall: number, windowS = 120) => {
  const lines = [
    `now: ${new Date(nowWall * 1000).toISOString()}`,
    `uptime_s: ${self.uptimeS.toFixed(1)}  tick: ${self.tick}`,
    'body (channel: value | normal level | normal sd):',
    ...Object.entries(self.body).map(([k, v]) => `  ${k}: ${f(v.value)} | ${f(v.baseline)} | ${f(v.sigma)}`),
    `level alarms in the last ${windowS}s (newest first):`,
    ...events.filter((e) => nowWall - e.tWall <= windowS && e.decision !== 'ignore').reverse().slice(0, 60).map((e) => renderEvent(e, nowWall)),
  ]
  return lines.join('\n')
}

export interface Snapshot {
  tWall: number
  values: ArrayLike<number>
  stale: string[]
}

export const renderSnapshots = (channels: string[], snaps: Snapshot[], nowWall: number) => {
  const lines = [`now: ${new Date(nowWall * 1000).toISOString()}`, 'heartbeat snapshots of all channels (oldest first):']
  for (const s of snaps) {
    const stale = s.stale.length ? ` | not updating: ${s.stale.join(', ')}` : ''
    lines.push(`snapshot ${(nowWall - s.tWall).toFixed(1)}s ago: ` + channels.map((c, i) => `${c}=${f(s.values[i] ?? 0)}`).join(', ') + stale)
  }
  return lines.join('\n')
}

export const ask = (context: string, question: string) => `${context}\n\nQUESTION: ${question}`
