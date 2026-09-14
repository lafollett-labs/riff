import { DatabaseSync } from 'node:sqlite';
import { systemClock, type Clock } from '../core/clock.ts';

/**
 * A company's own audit of what its staff actually did — recorded from the SDK
 * message stream as a shift runs, not parsed back out of Claude Code's private
 * transcript files.
 *
 * WHY ITS OWN DATABASE, beside the ledger rather than a table inside it. The
 * ledger is the governance record — approvals, spend, the exactly-once gate on
 * what leaves the company — and it is small on purpose and the one file a host
 * `sqlite3` once corrupted. Conversation is the highest-volume thing a company
 * produces; folding it into the ledger would put a large, hot write path on the
 * db that guards the money, and grow the file every integrity check and every
 * transfer has to carry. Kept apart, a problem with the audit store stays in the
 * audit store, and search can grow its own indexes (FTS later) without touching
 * the ledger schema. Still inside the company directory, so it travels and backs
 * up with everything else.
 *
 * WHY RECORDED, not read from the CLI's JSONL. The JSONL is Claude Code's
 * private, versioned resume format, and it exists only when the backend is
 * Claude Code — the moment a shift runs on another provider it is gone. The SDK
 * message stream is ours whatever runs underneath, so the audit is
 * provider-agnostic and in a schema we own.
 */

type Row = Record<string, unknown>;
const str = (v: unknown): string => String(v);
const nstr = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number => Number(v);

export type TurnRole = 'user' | 'assistant' | 'result';
export type TurnKind = 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'result';

/** One recorded block of a shift's conversation. */
export type TurnInput = {
  sessionId: string;
  agentId: string;
  role: TurnRole;
  kind: TurnKind;
  /** Tool name for a call; the call's id for its result. */
  name?: string | null;
  text?: string;
  /** JSON-serialisable: model, costUsd, isError, subtype, turns, id. */
  meta?: unknown;
};

export type Turn = {
  seq: number; at: string; sessionId: string; agentId: string;
  role: TurnRole; kind: TurnKind; name: string | null; text: string; meta: unknown;
};

export type SessionSummary = {
  sessionId: string; agentId: string; turns: number; startedAt: string; endedAt: string;
};

/** What the recorder needs of the store — the seam a test fakes. */
export type TranscriptSink = { append(t: TurnInput): void };

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS turns (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  at         TEXT NOT NULL,
  role       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  name       TEXT,
  text       TEXT NOT NULL DEFAULT '',
  meta       TEXT
);
CREATE INDEX IF NOT EXISTS turns_session ON turns(session_id, seq);
CREATE INDEX IF NOT EXISTS turns_agent   ON turns(agent_id, id);
`;

/**
 * A block past this is a tool that dumped a file or a build log, not a turn of
 * conversation; keep the head and say how much was cut. Bounds one row and the
 * eventual API payload without losing what the block was.
 */
const MAX_TEXT = 200_000;

export class TranscriptStore implements TranscriptSink {
  #db: DatabaseSync;
  #clock: Clock;

  constructor(path: string, clock: Clock = systemClock) {
    this.#db = new DatabaseSync(path);
    this.#clock = clock;
    this.#db.exec(SCHEMA);
  }

  close(): void { this.#db.close(); }

  /**
   * Append one block. `seq` is assigned inside the INSERT, per session, the same
   * way the ledger assigns event seq, so a session's blocks keep the order they
   * were spoken in even if two shifts of different sessions write at once.
   */
  append(t: TurnInput): void {
    const text = t.text ?? '';
    const clipped = text.length > MAX_TEXT
      ? `${text.slice(0, MAX_TEXT)}\n…[${text.length - MAX_TEXT} more characters]`
      : text;
    const meta = t.meta === undefined ? null : JSON.stringify(t.meta);
    this.#db.prepare(
      `INSERT INTO turns(session_id,agent_id,seq,at,role,kind,name,text,meta)
       SELECT ?, ?, COALESCE(MAX(seq),0)+1, ?, ?, ?, ?, ?, ? FROM turns WHERE session_id=?`
    ).run(t.sessionId, t.agentId, this.#clock.iso(), t.role, t.kind, t.name ?? null, clipped, meta, t.sessionId);
  }

  /**
   * One page of a session's blocks, in the order they were spoken, taking only
   * those past `after` (a block's `seq`). Forward paging serves both the "load
   * the rest of a long shift" button and the live tail — the reader holds the
   * last seq it has and asks for what came after it — so a shift is never
   * silently truncated at a fixed ceiling the way a bare LIMIT did.
   */
  bySession(sessionId: string, opts: { after?: number; limit?: number } = {}): Turn[] {
    const after = opts.after ?? 0;
    const limit = opts.limit ?? 5000;
    return (this.#db.prepare(
      'SELECT * FROM turns WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?'
    ).all(sessionId, after, limit) as Row[]).map((r) => this.#toTurn(r));
  }

  /** The sessions an agent has on record, most recent first. */
  sessionsFor(agentId: string, limit = 50): SessionSummary[] {
    return (this.#db.prepare(
      `SELECT session_id, agent_id, COUNT(*) AS n, MIN(at) AS started, MAX(at) AS ended
       FROM turns WHERE agent_id=? GROUP BY session_id ORDER BY MAX(id) DESC LIMIT ?`
    ).all(agentId, limit) as Row[]).map((r) => ({
      sessionId: str(r['session_id']), agentId: str(r['agent_id']),
      turns: num(r['n']), startedAt: str(r['started']), endedAt: str(r['ended']),
    }));
  }

  #toTurn(r: Row): Turn {
    let meta: unknown = null;
    try { meta = r['meta'] == null ? null : JSON.parse(str(r['meta'])); } catch { meta = null; }
    return {
      seq: num(r['seq']), at: str(r['at']), sessionId: str(r['session_id']), agentId: str(r['agent_id']),
      role: str(r['role']) as TurnRole, kind: str(r['kind']) as TurnKind,
      name: nstr(r['name']), text: str(r['text']), meta,
    };
  }
}
