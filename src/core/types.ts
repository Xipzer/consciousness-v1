export interface ChannelDef {
  name: string
  unit: string
  periodS: number
  minSigma: number
  gain?: number
  excludeFromChange?: boolean
}

export interface Reading {
  value: number
  t: number
}

export type Latest = Map<string, Reading>

export type EventKind = 'change' | 'stale' | 'resumed' | 'still' | 'moved' | 'gap'

export interface CoreEvent {
  id: string
  tick: number
  tWall: number
  kind: EventKind
  channel?: string
  timescale?: 'fast' | 'medium'
  direction?: 1 | -1
  z?: number
  delta?: number
  value?: number
  durationS?: number
  salience: number
  decision: 'ignore' | 'log' | 'refractory' | 'budget' | 'wake'
  rule: string
}

export interface ChannelView {
  value: number
  age: number
  baseline: number
  velocityFast: number
  velocityMedium: number
  sigma: number
}

export interface SelfModel {
  instanceId: string
  birthWall: number
  uptimeS: number
  tick: number
  mode: string
  still: boolean
  stillForS: number
  lastGapS: number
  body: Record<string, ChannelView>
}

export interface TickOut {
  tick: number
  tMono: number
  tWall: number
  values: Float32Array
  ages: Float32Array
  change: number
  maxSalience: number
  events: CoreEvent[]
  wake: CoreEvent[] | null
}
