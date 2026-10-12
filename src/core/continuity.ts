import { type ChainLink, linkDigest } from '../memory/store.ts'
import type { ChannelDef } from './types.ts'

export type Verdict = 'new' | 'continuous' | 'discontinuous' | 'tampered'

export interface Continuity {
  verdict: Verdict
  chainOk: boolean
  links: number
  downtimeS: number | null
  cleanShutdown: boolean | null
  bodyDistance: number | null
  comparedChannels: number
  uptimeErrorS: number | null
}

export const BODY_DISTANCE_MAX = 6

export const verifyChain = (links: ChainLink[]) =>
  links.every((l, i) => {
    const { digest, ...rest } = l
    if (linkDigest(rest) !== digest) return false
    return i === 0 ? l.prev === 'genesis' : l.prev === links[i - 1]!.digest
  })

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

export const UPTIME_TOLERANCE_S = 5

export const assessContinuity = (
  links: ChainLink[],
  nowWall: number,
  nowSlow: number[],
  nowRaw: number[],
  channels: ChannelDef[],
  selfUptimeS = 0,
): Continuity => {
  if (!links.length) {
    return { verdict: 'new', chainOk: true, links: 0, downtimeS: null, cleanShutdown: null, bodyDistance: null, comparedChannels: 0, uptimeErrorS: null }
  }
  const chainOk = verifyChain(links)
  const last = links[links.length - 1]!
  const ok = (x: number | null | undefined): x is number => x !== null && x !== undefined && !Number.isNaN(x)
  const d: number[] = []
  channels.forEach((c, i) => {
    const x = last.slow[i]
    const y = nowSlow[i]
    if (!c.name.startsWith('body.') || c.excludeFromChange || !ok(x) || !ok(y)) return
    d.push(Math.abs(y - x) / Math.max(last.sigma[i] ?? 0, c.minSigma))
  })
  const u = channels.findIndex((c) => c.name === 'body.host.uptime')
  const downtimeS = nowWall - last.tWall - selfUptimeS
  const lastU = last.raw[u]
  const nowU = nowRaw[u]
  const uptimeErrorS = u >= 0 && ok(lastU) && ok(nowU) ? nowU - lastU - (nowWall - last.tWall) : null
  const bodyDistance = d.length ? median(d) : null
  const bodyOk = bodyDistance === null || bodyDistance <= BODY_DISTANCE_MAX
  const uptimeOk = uptimeErrorS === null || Math.abs(uptimeErrorS) <= UPTIME_TOLERANCE_S
  const verdict: Verdict = !chainOk ? 'tampered' : bodyOk && uptimeOk ? 'continuous' : 'discontinuous'
  return {
    verdict, chainOk, links: links.length, downtimeS, cleanShutdown: last.kind === 'shutdown', bodyDistance,
    comparedChannels: d.length, uptimeErrorS,
  }
}
