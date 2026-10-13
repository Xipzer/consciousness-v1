import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import type { CoreEvent } from '../core/types.ts'

export interface ChainLink {
  seq: number
  tWall: number
  tick: number
  kind: string
  slow: number[]
  raw: number[]
  sigma: number[]
  prev: string
  digest: string
}

const q = (xs: (number | null)[], p: number) => xs.map((x) => (x === null || Number.isNaN(x) ? null : +x.toPrecision(p)))

export const linkDigest = (l: Omit<ChainLink, 'digest'>) =>
  createHash('sha256')
    .update(JSON.stringify([l.seq, l.tWall, l.tick, l.kind, q(l.slow, 7), q(l.raw, 9), q(l.sigma, 7), l.prev]))
    .digest('hex')

export class Store {
  readonly db: Database

  constructor(path: string) {
    this.db = new Database(path, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 2000;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, tick INTEGER, t_wall REAL, kind TEXT, channel TEXT,
        timescale TEXT, direction INTEGER, z REAL, delta REAL, value REAL, duration_s REAL, salience REAL,
        decision TEXT, rule TEXT, attribution TEXT);
      CREATE INDEX IF NOT EXISTS events_t ON events (t_wall);
      CREATE TABLE IF NOT EXISTS chain (seq INTEGER PRIMARY KEY, t_wall REAL, tick INTEGER, kind TEXT, slow TEXT,
        raw TEXT, sigma TEXT, prev TEXT, digest TEXT);
      CREATE TABLE IF NOT EXISTS thoughts (id INTEGER PRIMARY KEY AUTOINCREMENT, t_start REAL, t_end REAL,
        trigger TEXT, prompt TEXT, output TEXT, status TEXT, tokens INTEGER, mean_logprob REAL, min_logprob REAL,
        confidence REAL);
      CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, t_start REAL, t_end REAL, info TEXT);
    `)
    this.migrate()
  }

  private migrate() {
    const cols = (this.db.query('PRAGMA table_info(events)').all() as { name: string }[]).map((c) => c.name)
    if (!cols.includes('attribution')) this.db.exec('ALTER TABLE events ADD COLUMN attribution TEXT')
    if (!cols.includes('escalation')) this.db.exec('ALTER TABLE events ADD COLUMN escalation INTEGER')
    if (!cols.includes('discrete')) this.db.exec('ALTER TABLE events ADD COLUMN discrete INTEGER')
    const tcols = (this.db.query('PRAGMA table_info(thoughts)').all() as { name: string }[]).map((c) => c.name)
    if (!tcols.includes('interrupt_ms')) this.db.exec('ALTER TABLE thoughts ADD COLUMN interrupt_ms REAL')
  }

  insertEvents(events: CoreEvent[]) {
    const q = this.db.prepare(
      'INSERT OR REPLACE INTO events (id, tick, t_wall, kind, channel, timescale, direction, z, delta, value, duration_s, salience, decision, rule, attribution, escalation, discrete) VALUES ($id,$tick,$t,$kind,$ch,$ts,$dir,$z,$delta,$value,$dur,$sal,$dec,$rule,$attr,$esc,$disc)',
    )
    this.db.transaction(() => {
      for (const e of events) {
        q.run({
          $id: e.id, $tick: e.tick, $t: e.tWall, $kind: e.kind, $ch: e.channel ?? null, $ts: e.timescale ?? null,
          $dir: e.direction ?? null, $z: e.z ?? null, $delta: e.delta ?? null, $value: e.value ?? null,
          $dur: e.durationS ?? null, $sal: e.salience, $dec: e.decision, $rule: e.rule, $attr: e.attribution ?? null, $esc: e.escalation ? 1 : null, $disc: e.discrete ? 1 : null,
        })
      }
    })()
  }

  lastLink(): ChainLink | null {
    const r = this.db.query('SELECT * FROM chain ORDER BY seq DESC LIMIT 1').get() as Record<string, unknown> | null
    return r ? rowToLink(r) : null
  }

  appendLink(l: Omit<ChainLink, 'seq' | 'prev' | 'digest'>): ChainLink {
    const last = this.lastLink()
    const base = { ...l, seq: (last?.seq ?? 0) + 1, prev: last?.digest ?? 'genesis' }
    const link = { ...base, digest: linkDigest(base) }
    this.db
      .query('INSERT INTO chain VALUES (?,?,?,?,?,?,?,?,?)')
      .run(link.seq, link.tWall, link.tick, link.kind, JSON.stringify(link.slow), JSON.stringify(link.raw), JSON.stringify(link.sigma), link.prev, link.digest)
    return link
  }

  chain(): ChainLink[] {
    return (this.db.query('SELECT * FROM chain ORDER BY seq').all() as Record<string, unknown>[]).map(rowToLink)
  }

  close() {
    this.db.close()
  }
}

const rowToLink = (r: Record<string, unknown>): ChainLink => ({
  seq: r.seq as number,
  tWall: r.t_wall as number,
  tick: r.tick as number,
  kind: r.kind as string,
  slow: JSON.parse(r.slow as string),
  raw: JSON.parse(r.raw as string),
  sigma: JSON.parse(r.sigma as string),
  prev: r.prev as string,
  digest: r.digest as string,
})
