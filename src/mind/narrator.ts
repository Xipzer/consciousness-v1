import type { Store } from '../memory/store.ts'
import type { CoreEvent, SelfModel } from '../core/types.ts'
import { chat } from './llm.ts'
import { ask, REPORT_SCHEMA, renderFull, SYSTEM } from './prompt.ts'

export interface Wake {
  events: CoreEvent[]
  self: SelfModel
  recent: CoreEvent[]
}

const QUESTION = 'Something salient just happened to you. Report what changed, in which direction and when, and whether you are still.'

export class Narrator {
  private current: { ctrl: AbortController; salience: number } | null = null

  constructor(
    private readonly url: string,
    private readonly store: Store,
    private readonly sense: (channel: string, value: number) => void,
  ) {}

  wake(w: Wake) {
    const salience = Math.max(...w.events.map((e) => e.salience))
    if (this.current) {
      if (salience < this.current.salience * 2) return this.record(w, 'dropped', null)
      this.current.ctrl.abort()
    }
    void this.think(w, salience)
  }

  private async think(w: Wake, salience: number) {
    const ctrl = new AbortController()
    this.current = { ctrl, salience }
    this.sense('mind.active', 1)
    const nowWall = Date.now() / 1000
    const prompt = ask(renderFull(w.self, w.recent, nowWall), QUESTION)
    const tStart = nowWall
    try {
      const r = await chat({ url: this.url, system: SYSTEM, user: prompt, schema: REPORT_SCHEMA, signal: ctrl.signal, slot: 0 })
      const confidence = Math.exp(r.meanLogprob)
      this.sense('mind.confidence', confidence)
      this.store.db
        .query('INSERT INTO thoughts (t_start, t_end, trigger, prompt, output, status, tokens, mean_logprob, min_logprob, confidence) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(tStart, Date.now() / 1000, JSON.stringify(w.events.map((e) => e.id)), prompt, r.content, 'done', r.tokens, r.meanLogprob, r.minLogprob, confidence)
    } catch (e) {
      this.record(w, ctrl.signal.aborted ? 'interrupted' : `error: ${(e as Error).message.slice(0, 200)}`, tStart)
    } finally {
      if (this.current?.ctrl === ctrl) {
        this.current = null
        this.sense('mind.active', 0)
      }
    }
  }

  private record(w: Wake, status: string, tStart: number | null) {
    this.store.db
      .query('INSERT INTO thoughts (t_start, t_end, trigger, status) VALUES (?,?,?,?)')
      .run(tStart ?? Date.now() / 1000, Date.now() / 1000, JSON.stringify(w.events.map((e) => e.id)), status)
  }
}
