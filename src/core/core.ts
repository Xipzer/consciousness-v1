import type { Config } from '../config.ts'
import type { ChannelDef, ChannelView, CoreEvent, EventKind, Latest, SelfModel, TickOut } from './types.ts'

type Scale = 'fast' | 'medium'

interface ChannelState {
  def: ChannelDef
  value: number
  t: number
  seen: boolean
  readings: number
  ema: { fast: number; medium: number; slow: number }
  prevEma: { fast: number; medium: number }
  velocity: { fast: number; medium: number }
  noiseVar: number
  alpha: { fast: number; medium: number }
  armed: { fast: boolean; medium: boolean }
  devVar: { fast: number; medium: number }
  stale: boolean
  range: { mean: number; m2: number; n: number } | null
  outOfRange: boolean
}

const WARMUP_READINGS = 30
const WARMUP_S = 60
const NOISE_CLIP = 2
const ref = (s: ChannelState, scale: Scale) => (scale === 'fast' ? s.prevEma.medium : s.ema.slow)

export class Core {
  readonly channels: ChannelDef[]
  private readonly state: ChannelState[]
  private readonly habituation = new Map<string, { h: number; t: number }>()
  private readonly lastWake = new Map<string, number>()
  private wakeTimes: number[] = []
  private tick = 0
  private lastMono: number | null = null
  private stillTicks = 0
  private stillSinceWall: number | null = null
  private lastGapS = 0
  private eventSeq = 0
  private startMono: number | null = null
  private selfEndMono: number | null = null
  private selfWasActive = false
  private readonly reafferent: Set<string>
  readonly recent: CoreEvent[] = []

  constructor(
    channels: ChannelDef[],
    private readonly cfg: Config,
    private readonly identity: { instanceId: string; birthWall: number },
  ) {
    this.channels = channels
    this.reafferent = new Set(cfg.reafferent)
    this.state = channels.map((def) => ({
      def,
      value: 0,
      t: -Infinity,
      seen: false,
      readings: 0,
      ema: { fast: 0, medium: 0, slow: 0 },
      prevEma: { fast: 0, medium: 0 },
      velocity: { fast: 0, medium: 0 },
      noiseVar: 0,
      alpha: { fast: 1, medium: 1 },
      armed: { fast: true, medium: true },
      devVar: { fast: 0, medium: 0 },
      stale: false,
      range: cfg.mode === 'no-delta' ? { mean: 0, m2: 0, n: 0 } : null,
      outOfRange: false,
    }))
  }

  step(latest: Latest, tMono: number, tWall: number): TickOut {
    this.tick++
    this.startMono ??= tMono
    const dtTick = this.lastMono === null ? 1 / this.cfg.tickHz : tMono - this.lastMono
    this.lastMono = tMono
    const events: CoreEvent[] = []
    const n = this.state.length
    const values = new Float32Array(n)
    const ages = new Float32Array(n)

    const motion = this.cfg.mode !== 'no-delta'
    if (motion && dtTick > 5 / this.cfg.tickHz) {
      this.lastGapS = dtTick
      events.push(this.event('gap', tWall, { durationS: dtTick, z: dtTick * this.cfg.tickHz }))
    }

    let change = 0
    for (let i = 0; i < n; i++) {
      const s = this.state[i]!
      const r = latest.get(s.def.name)
      if (r && r.t > s.t) change += this.update(s, r, tWall, events)
      values[i] = s.value
      ages[i] = s.seen ? Math.round((tMono - s.t) * 1000) / 1000 : -1
      this.checkStale(s, tMono, tWall, events)
    }

    if (motion) this.trackStillness(change, tWall, events)
    this.attribute(events, latest, tMono)

    let maxSalience = 0
    const wake: CoreEvent[] = []
    for (const e of events) {
      this.decide(e, tMono)
      maxSalience = Math.max(maxSalience, e.salience)
      if (e.decision === 'ignore') continue
      this.recent.push(e)
      if (e.decision === 'wake') wake.push(e)
    }
    while (this.recent.length > 200) this.recent.shift()

    return { tick: this.tick, tMono, tWall, values, ages, change, maxSalience, events, wake: wake.length ? wake : null }
  }

  private attribute(events: CoreEvent[], latest: Latest, tMono: number) {
    const own = latest.get('mind.active')?.value ?? 0
    if (own > 0) this.selfWasActive = true
    else if (this.selfWasActive) {
      this.selfWasActive = false
      this.selfEndMono = tMono
    }
    if (!this.cfg.efference) return
    const sinceEnd = own > 0 ? 0 : this.selfEndMono === null ? Infinity : tMono - this.selfEndMono
    const tail = (scale?: Scale) => this.cfg.efferenceTailS + 3 * this.cfg.timescalesS[scale ?? 'fast']
    if (sinceEnd > tail('medium')) return
    const expectedSlots = Math.max(own, 1)
    const busy = latest.get('brain.busy_slots')?.value ?? 0
    for (const e of events) {
      if (e.kind !== 'change' || !e.channel || !this.reafferent.has(e.channel)) continue
      if (sinceEnd > tail(e.timescale)) continue
      if (e.channel.startsWith('brain.') && busy > expectedSlots) continue
      e.attribution = 'self'
      e.salience *= this.cfg.efferenceDiscount
    }
  }

  private update(s: ChannelState, r: { value: number; t: number }, tWall: number, events: CoreEvent[]): number {
    const first = !s.seen
    const dt = first ? s.def.periodS : Math.max(r.t - s.t, 1e-3)
    const diff = first ? 0 : r.value - s.value
    s.value = r.value
    s.t = r.t
    s.seen = true
    s.readings++

    if (s.range) return this.updateLevelOnly(s, tWall, events)

    const ts = this.cfg.timescalesS
    if (first) {
      s.ema = { fast: r.value, medium: r.value, slow: r.value }
      s.prevEma = { fast: r.value, medium: r.value }
      return 0
    }
    const a = (tau: number) => Math.max(1 - Math.exp(-dt / tau), 1 / s.readings)
    s.alpha = { fast: a(ts.fast), medium: a(ts.medium) }
    s.prevEma = { fast: s.ema.fast, medium: s.ema.medium }
    s.ema.fast += s.alpha.fast * (r.value - s.ema.fast)
    s.ema.medium += s.alpha.medium * (r.value - s.ema.medium)
    s.velocity = { fast: (s.ema.fast - s.prevEma.fast) / dt, medium: (s.ema.medium - s.prevEma.medium) / dt }
    const sigma = this.sigma(s)
    const scaled = Math.min(Math.abs(diff), 10 * sigma)
    const noiseAlpha = a(ts.slow)
    s.noiseVar += noiseAlpha * ((scaled * scaled) / 2 - s.noiseVar)

    const warm = s.readings * s.def.periodS >= WARMUP_S && s.readings > WARMUP_READINGS
    for (const scale of ['fast', 'medium'] as const) {
      const z = warm ? this.surprise(s, scale, tWall, events) : 0
      if (z >= this.cfg.surpriseZ) continue
      const dev = Math.min(Math.abs(s.ema[scale] - ref(s, scale)), NOISE_CLIP * this.devSd(s, scale))
      s.devVar[scale] += a(ts.slow) * (dev * dev - s.devVar[scale])
    }
    s.ema.slow += a(ts.slow) * (r.value - s.ema.slow)
    return s.def.excludeFromChange ? 0 : Math.abs(diff) / sigma
  }

  private updateLevelOnly(s: ChannelState, tWall: number, events: CoreEvent[]): number {
    const rg = s.range!
    if (rg.n < WARMUP_READINGS * 4) {
      rg.n++
      const d = s.value - rg.mean
      rg.mean += d / rg.n
      rg.m2 += d * (s.value - rg.mean)
      return 0
    }
    const sd = Math.max(Math.sqrt(rg.m2 / (rg.n - 1)), s.def.minSigma)
    const z = Math.abs(s.value - rg.mean) / sd
    const out = z > this.cfg.levelRangeZ
    if (out && !s.outOfRange) {
      events.push(this.event('change', tWall, {
        channel: s.def.name, direction: s.value > rg.mean ? 1 : -1, z, delta: s.value - rg.mean, value: s.value,
      }, s.def.gain))
    }
    s.outOfRange = out
    return 0
  }

  private sigma(s: ChannelState) {
    return Math.max(Math.sqrt(s.noiseVar), s.def.minSigma)
  }

  private devSd(s: ChannelState, scale: Scale) {
    const al = s.alpha[scale]
    return Math.max(Math.sqrt(s.devVar[scale]), this.sigma(s) * Math.sqrt(al / (2 - al)))
  }

  private surprise(s: ChannelState, scale: Scale, tWall: number, events: CoreEvent[]): number {
    const se = this.devSd(s, scale)
    const delta = s.ema[scale] - ref(s, scale)
    const z = Math.abs(delta) / se
    if (s.armed[scale] && z >= this.cfg.surpriseZ) {
      s.armed[scale] = false
      events.push(this.event('change', tWall, {
        channel: s.def.name, timescale: scale, direction: delta > 0 ? 1 : -1, z, delta, value: s.value,
      }, s.def.gain))
    }
    if (!s.armed[scale] && z < this.cfg.surpriseZ / 2) s.armed[scale] = true
    return z
  }

  private checkStale(s: ChannelState, tMono: number, tWall: number, events: CoreEvent[]) {
    if (!s.seen) return
    const stale = tMono - s.t > this.cfg.staleFactor * s.def.periodS
    if (stale === s.stale) return
    s.stale = stale
    events.push(this.event(stale ? 'stale' : 'resumed', tWall, { channel: s.def.name, durationS: tMono - s.t, z: 10 }))
  }

  private trackStillness(change: number, tWall: number, events: CoreEvent[]) {
    if (change > 0) {
      if (this.stillSinceWall !== null && this.stillTicks >= this.cfg.stillTicks) {
        events.push(this.event('moved', tWall, { durationS: tWall - this.stillSinceWall, z: 10 }))
      }
      this.stillTicks = 0
      this.stillSinceWall = null
      return
    }
    this.stillSinceWall ??= tWall
    this.stillTicks++
    if (this.stillTicks === this.cfg.stillTicks) events.push(this.event('still', tWall, { durationS: tWall - this.stillSinceWall, z: 10 }))
  }

  private event(kind: EventKind, tWall: number, f: Partial<CoreEvent>, gain = 1): CoreEvent {
    const sig = `${kind}:${f.channel ?? '*'}`
    const now = tWall
    const hab = this.habituation.get(sig) ?? { h: 1, t: now }
    const recovered = 1 - (1 - hab.h) * Math.exp(-(now - hab.t) / this.cfg.habituationRecoverS)
    const salience = gain * (f.z ?? 0) * recovered
    this.habituation.set(sig, { h: recovered * this.cfg.habituationDecay, t: now })
    return { id: `${this.identity.instanceId.slice(0, 8)}-${++this.eventSeq}`, tick: this.tick, tWall, kind, ...f, salience, decision: 'ignore', rule: '' }
  }

  private decide(e: CoreEvent, tMono: number) {
    const c = this.cfg
    const sig = `${e.kind}:${e.channel ?? '*'}`
    if (e.salience < c.logSalience) return Object.assign(e, { decision: 'ignore', rule: 'R2' })
    if (e.salience < c.wakeSalience) return Object.assign(e, { decision: 'log', rule: 'R3' })
    if (e.attribution === 'self') return Object.assign(e, { decision: 'log', rule: 'R3s' })
    const last = this.lastWake.get(sig)
    if (last !== undefined && tMono - last < c.wakeCooldownS) return Object.assign(e, { decision: 'refractory', rule: 'R4' })
    this.wakeTimes = this.wakeTimes.filter((t) => tMono - t < 60)
    if (this.wakeTimes.length >= c.wakesPerMinute) return Object.assign(e, { decision: 'budget', rule: 'R5' })
    this.wakeTimes.push(tMono)
    this.lastWake.set(sig, tMono)
    return Object.assign(e, { decision: 'wake', rule: 'R6' })
  }

  selfModel(tWall: number): SelfModel {
    const body: Record<string, ChannelView> = {}
    for (const s of this.state) {
      if (!s.seen) continue
      body[s.def.name] = {
        value: s.value,
        age: this.lastMono === null ? 0 : this.lastMono - s.t,
        baseline: s.range ? s.range.mean : s.ema.slow,
        velocityFast: s.velocity.fast,
        velocityMedium: s.velocity.medium,
        sigma: s.range ? Math.sqrt(s.range.m2 / Math.max(s.range.n - 1, 1)) : this.sigma(s),
      }
    }
    const still = this.stillTicks >= this.cfg.stillTicks
    return {
      ...this.identity,
      uptimeS: this.lastMono === null || this.startMono === null ? 0 : this.lastMono - this.startMono,
      tick: this.tick,
      mode: this.cfg.mode,
      still,
      stillForS: still && this.stillSinceWall !== null ? tWall - this.stillSinceWall : 0,
      lastGapS: this.lastGapS,
      body,
    }
  }

  sigmaVector(): number[] {
    return this.state.map((s) => (!s.seen ? Number.NaN : s.range ? Math.sqrt(s.range.m2 / Math.max(s.range.n - 1, 1)) : this.sigma(s)))
  }

  rawVector(): number[] {
    return this.state.map((s) => (s.seen ? s.value : Number.NaN))
  }

  slowVector(): number[] {
    return this.state.map((s) => (!s.seen ? Number.NaN : s.range ? s.value : s.ema.slow))
  }
}
