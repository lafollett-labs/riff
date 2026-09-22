import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId } from '../core/ids.ts';
import { systemClock, type Clock } from '../core/clock.ts';
import type {
  Agent, AgentId, Approval, ApprovalId, ApprovalTier, Capability,
  Event, Message, SpendRecord, Task, TaskId, TaskStatus,
} from '../core/types.ts';

const SCHEMA = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

type Row = Record<string, unknown>;
const str = (v: unknown): string => String(v);
const nstr = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number => Number(v);
const nnum = (v: unknown): number | null => (v == null ? null : Number(v));

/** Outcome of an attempted spend. `capped` is a refusal, not an error. */
export type SpendOutcome =
  | { ok: true; record: SpendRecord; spentTodayCents: number; remainingCents: number }
  | { ok: false; reason: 'capped'; spentTodayCents: number; capCents: number; requestedCents: number };

export class Ledger {
  #db: DatabaseSync;
  #clock: Clock;

  constructor(path: string, clock: Clock = systemClock) {
    this.#db = new DatabaseSync(path);
    this.#clock = clock;
    this.#db.exec(readFileSync(SCHEMA, 'utf8'));
    this.#migrate();
  }

  /**
   * Ledgers written before a column existed. schema.sql only ever creates, so a
   * table that predates a column is brought up to date here, once.
   */
  #migrate(): void {
    const cols = (this.#db.prepare('PRAGMA table_info(agents)').all() as Row[]).map((r) => str(r['name']));
    if (!cols.includes('effort')) {
      this.#db.exec("ALTER TABLE agents ADD COLUMN effort TEXT NOT NULL DEFAULT 'company'");
    }
    // Every seat was stamped with a model id at hire, and nothing could ever
    // change it — so no stored value is anybody's choice. They move to the
    // company default together, once; a choice made after this is kept.
    // The guard is read again inside the write lock: two processes opening one
    // ledger (the gateway, and an `exec node -e` beside it) must not both run
    // it, or the second undoes a choice the board made in between.
    if (this.getMeta('migrated:seat-models') == null) {
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        if (this.getMeta('migrated:seat-models') == null) {
          this.#db.prepare("UPDATE agents SET model='company' WHERE model!='human'").run();
          this.setMeta('migrated:seat-models', this.#clock.iso());
        }
        this.#db.exec('COMMIT');
      } catch (e) {
        this.#db.exec('ROLLBACK');
        throw e;
      }
    }
  }



  get db(): DatabaseSync { return this.#db; }
  close(): void { this.#db.close(); }

  // ------------------------------------------------------------------ meta
  setMeta(key: string, value: string): void {
    this.#db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
  getMeta(key: string): string | null {
    const r = this.#db.prepare('SELECT value FROM meta WHERE key=?').get(key) as Row | undefined;
    return r ? str(r['value']) : null;
  }

  // ---------------------------------------------------------------- events
  /**
   * Append-only. `seq` is assigned inside the INSERT so two staff members
   * writing at the same instant cannot collide on it.
   */
  emit(actor: AgentId, kind: string, subject?: string | null, data?: unknown): Event {
    const id = newId('evt', this.#clock.now());
    const at = this.#clock.iso();
    const dataJson = data === undefined ? null : JSON.stringify(data);
    this.#db.prepare(
      `INSERT INTO events(id,seq,at,actor,kind,subject,data_json)
       SELECT ?, COALESCE(MAX(seq),0)+1, ?, ?, ?, ?, ? FROM events`
    ).run(id, at, actor, kind, subject ?? null, dataJson);
    const row = this.#db.prepare('SELECT * FROM events WHERE id=?').get(id) as Row;
    return this.#toEvent(row);
  }

  eventsSince(seq: number, limit = 500): Event[] {
    return (this.#db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(seq, limit) as Row[])
      .map((r) => this.#toEvent(r));
  }

  /**
   * When each commons document first appeared, and how often it has been
   * rewritten since.
   *
   * The frontmatter carries `updated`, which is the last edit — useless for
   * working out what to read first. A commons of forty documents listed
   * alphabetically gives a reader no way in. The event log knows the real
   * order because every posting was recorded as it happened.
   */
  commonsHistory(): Map<string, { created: string; revisions: number }> {
    const rows = this.#db.prepare(
      `SELECT subject, MIN(at) AS created, COUNT(*) AS n
       FROM events WHERE kind='commons.posted' AND subject IS NOT NULL
       GROUP BY subject`
    ).all() as Row[];
    return new Map(rows.map((r) => [
      String(r['subject']), { created: String(r['created']), revisions: num(r['n']) },
    ]));
  }

  /**
   * When each commons document was last taken off the shelf.
   *
   * Pairs with `commonsHistory()`: a posting onto a path that was removed
   * beforehand puts a document BACK on the shelf, and counting it as a
   * revision under-reported the one act Rule 6 exists to encourage.
   */
  commonsRemovals(): Map<string, string> {
    const rows = this.#db.prepare(
      `SELECT subject, MAX(at) AS last FROM events
       WHERE kind='commons.removed' AND subject IS NOT NULL GROUP BY subject`
    ).all() as Row[];
    return new Map(rows.map((r) => [str(r['subject']), str(r['last'])]));
  }

  latestSeq(): number {
    const r = this.#db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM events').get() as Row;
    return num(r['s']);
  }

  // ------------------------------------------------------------- vitals
  // Window-scoped readers. They aggregate in SQL rather than handing back
  // rows because a busy fortnight is tens of thousands of events, and a
  // report that has to load all of them to count them is a report nobody
  // runs twice. The arithmetic lives in src/analytics/vitals.ts.
  //
  // Both ends are required. A reader that only took a start could not answer
  // "and how did the week before that go", which is the question that turns
  // every one of these counts from a number into a direction.

  /**
   * How many of each kind of thing happened, and who did it. Grouped by both
   * so one query answers the company totals and the per-person table.
   */
  eventCounts(since: string, until: string): Array<{ kind: string; actor: AgentId; n: number }> {
    return (this.#db.prepare(
      `SELECT kind, actor, COUNT(*) AS n FROM events
       WHERE at>=? AND at<? GROUP BY kind, actor`
    ).all(since, until) as Row[]).map((r) => ({
      kind: str(r['kind']), actor: str(r['actor']), n: num(r['n']),
    }));
  }

  /**
   * Whole events, for the few kinds whose `data_json` carries a number worth
   * summing — `agent.slept` holds the turns and the dollars of a shift, and
   * there is nowhere else they are written down.
   */
  eventsOfKinds(kinds: string[], since: string, until: string): Event[] {
    if (kinds.length === 0) return [];
    const holes = kinds.map(() => '?').join(',');
    return (this.#db.prepare(
      `SELECT * FROM events WHERE at>=? AND at<? AND kind IN (${holes}) ORDER BY seq`
    ).all(since, until, ...(kinds as never[])) as Row[]).map((r) => this.#toEvent(r));
  }

  /**
   * The most recent event of these kinds, or null.
   *
   * `before` bounds it, for a window that opens mid-shift and needs to know
   * what the company was doing when it opened — counting only the events
   * inside the window reads a company that had been running for a week as one
   * that started when the window did. Left off, it means "the latest, ever",
   * which is what a caller asking "has this changed?" wants: bounding that at
   * the current instant drops a change made in the same millisecond.
   */
  lastEvent(kinds: string[], before?: string): Event | null {
    if (kinds.length === 0) return null;
    const holes = kinds.map(() => '?').join(',');
    const r = this.#db.prepare(
      `SELECT * FROM events WHERE ${before ? 'at<? AND ' : ''}kind IN (${holes}) ORDER BY seq DESC LIMIT 1`
    ).get(...(before ? [before] : []), ...(kinds as never[])) as Row | undefined;
    return r ? this.#toEvent(r) : null;
  }

  /**
   * When each person last finished a shift, by actor.
   *
   * The rotation is company state, not process state. A scheduler built with
   * an empty picture of it treats everybody as equally overdue, and a dead
   * heat is resolved by rank and then by hire order — the same two people,
   * every restart. See Scheduler's constructor.
   */
  lastWorked(): Map<string, number> {
    const out = new Map<string, number>();
    for (const r of this.#db.prepare(
      `SELECT actor, MAX(at) AS at FROM events
        WHERE kind IN ('agent.slept','agent.failed') GROUP BY actor`
    ).all() as Array<{ actor: string; at: string }>) {
      const t = Date.parse(r.at);
      if (Number.isFinite(t)) out.set(r.actor, t);
    }
    return out;
  }

  /**
   * Which rules actually bite. The constitution claims Rule 6 is the
   * load-bearing one; this is the query that can contradict it.
   */
  gateDecisions(since: string, until: string): Array<{ kind: string; rule: string; capability: string; n: number }> {
    return (this.#db.prepare(
      `SELECT kind,
              json_extract(data_json,'$.rule')       AS rule,
              json_extract(data_json,'$.capability') AS capability,
              COUNT(*) AS n
       FROM events WHERE at>=? AND at<? AND kind LIKE 'gate.%'
       GROUP BY kind, rule, capability ORDER BY n DESC`
    ).all(since, until) as Row[]).map((r) => ({
      kind: str(r['kind']).slice('gate.'.length),
      rule: r['rule'] == null ? 'unknown' : str(r['rule']),
      capability: r['capability'] == null ? '' : str(r['capability']),
      n: num(r['n']),
    }));
  }

  /** Filed in the window or decided in it — a draft can be either, or both. */
  approvalsBetween(since: string, until: string): Approval[] {
    return (this.#db.prepare(
      `SELECT * FROM approvals
       WHERE (requested_at>=? AND requested_at<?) OR (decided_at>=? AND decided_at<?)
       ORDER BY requested_at`
    ).all(since, until, since, until) as Row[]).map((r) => this.#toApproval(r));
  }

  /** Real money, from the table that guards it — not from the event log. */
  spendBetween(since: string, until: string): Array<{ agentId: AgentId; cents: number; n: number }> {
    return (this.#db.prepare(
      `SELECT agent_id, SUM(amount_cents) AS cents, COUNT(*) AS n
       FROM spend WHERE at>=? AND at<? GROUP BY agent_id`
    ).all(since, until) as Row[]).map((r) => ({
      agentId: str(r['agent_id']), cents: num(r['cents']), n: num(r['n']),
    }));
  }

  #toEvent(r: Row): Event {
    return {
      id: str(r['id']), seq: num(r['seq']), at: str(r['at']), actor: str(r['actor']),
      kind: str(r['kind']), subject: nstr(r['subject']), dataJson: nstr(r['data_json']),
    };
  }

  // ---------------------------------------------------------------- agents
  upsertAgent(a: Agent): void {
    this.#db.prepare(
      `INSERT INTO agents(id,name,tier,role,department,reports_to,status,activity,mandate,hired_at,hired_by,model,effort)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, tier=excluded.tier, role=excluded.role,
         department=excluded.department, reports_to=excluded.reports_to,
         status=excluded.status, activity=excluded.activity,
         mandate=excluded.mandate, model=excluded.model, effort=excluded.effort`
    ).run(a.id, a.name, a.tier, a.role, a.department, a.reportsTo, a.status,
          a.activity, a.mandate, a.hiredAt, a.hiredBy, a.model, a.effort);
  }

  /**
   * What someone says they are working on, and a trace that they said it.
   *
   * This wrote to the column and nothing else, which made `activity` the one
   * field with no history behind it — so when genesis overwrote two CEOs with
   * "founding the company", what they had actually been doing was
   * unrecoverable. The feed treats this as routine and hides it by default.
   */
  setActivity(id: AgentId, activity: string): void {
    const before = (this.#db.prepare('SELECT activity FROM agents WHERE id=?').get(id) as Row | undefined)?.['activity'];
    this.#db.prepare('UPDATE agents SET activity=? WHERE id=?').run(activity, id);
    if (String(before ?? '') === activity) return;   // nothing changed, nothing to record
    this.emit(id, 'agent.activity', id, { activity, ...(before ? { from: String(before) } : {}) });
  }

  getAgent(id: AgentId): Agent | null {
    const r = this.#db.prepare('SELECT * FROM agents WHERE id=?').get(id) as Row | undefined;
    return r ? this.#toAgent(r) : null;
  }

  listAgents(includeDeparted = false): Agent[] {
    const sql = includeDeparted
      ? 'SELECT * FROM agents ORDER BY tier, name'
      : "SELECT * FROM agents WHERE status!='departed' ORDER BY tier, name";
    return (this.#db.prepare(sql).all() as Row[]).map((r) => this.#toAgent(r));
  }

  /** Walks `reports_to` upward. Cycle-safe: bails once it revisits an id. */
  chainOfCommand(id: AgentId): Agent[] {
    const chain: Agent[] = [];
    const seen = new Set<string>();
    let cur = this.getAgent(id);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.push(cur);
      cur = cur.reportsTo ? this.getAgent(cur.reportsTo) : null;
    }
    return chain;
  }

  #toAgent(r: Row): Agent {
    return {
      id: str(r['id']), name: str(r['name']), tier: str(r['tier']) as Agent['tier'],
      role: str(r['role']), department: str(r['department']),
      reportsTo: nstr(r['reports_to']), status: str(r['status']) as Agent['status'],
      activity: str(r['activity']), mandate: str(r['mandate']),
      hiredAt: str(r['hired_at']), hiredBy: nstr(r['hired_by']), model: str(r['model']),
      effort: str(r['effort']),
    };
  }

  // ----------------------------------------------------------------- tasks
  createTask(t: Omit<Task, 'createdAt' | 'updatedAt'>): Task {
    const now = this.#clock.iso();
    this.#db.prepare(
      `INSERT INTO tasks(id,title,body,status,created_by,assigned_to,parent_id,priority,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`
    ).run(t.id, t.title, t.body, t.status, t.createdBy, t.assignedTo, t.parentId, t.priority, now, now);
    return { ...t, createdAt: now, updatedAt: now };
  }

  updateTaskStatus(id: TaskId, status: TaskStatus, assignedTo?: AgentId | null): void {
    if (assignedTo === undefined) {
      this.#db.prepare('UPDATE tasks SET status=?, updated_at=? WHERE id=?').run(status, this.#clock.iso(), id);
    } else {
      this.#db.prepare('UPDATE tasks SET status=?, assigned_to=?, updated_at=? WHERE id=?')
        .run(status, assignedTo, this.#clock.iso(), id);
    }
  }

  getTask(id: TaskId): Task | null {
    const r = this.#db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Row | undefined;
    return r ? this.#toTask(r) : null;
  }

  listTasks(filter?: { assignedTo?: AgentId; status?: TaskStatus }): Task[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter?.assignedTo) { where.push('assigned_to=?'); args.push(filter.assignedTo); }
    if (filter?.status) { where.push('status=?'); args.push(filter.status); }
    const sql = `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY priority, created_at`;
    return (this.#db.prepare(sql).all(...(args as never[])) as Row[]).map((r) => this.#toTask(r));
  }

  #toTask(r: Row): Task {
    return {
      id: str(r['id']), title: str(r['title']), body: str(r['body']),
      status: str(r['status']) as TaskStatus, createdBy: str(r['created_by']),
      assignedTo: nstr(r['assigned_to']), parentId: nstr(r['parent_id']),
      priority: num(r['priority']), createdAt: str(r['created_at']), updatedAt: str(r['updated_at']),
    };
  }

  // ------------------------------------------------------------- approvals
  createApproval(input: {
    requestedBy: AgentId; capability: Capability; tier: ApprovalTier; summary: string;
    target?: string | null; amountCents?: number | null; payload?: unknown;
  }): Approval {
    const id = newId('apr', this.#clock.now());
    const at = this.#clock.iso();
    this.#db.prepare(
      `INSERT INTO approvals(id,requested_by,capability,tier,state,summary,target,amount_cents,payload_json,requested_at)
       VALUES(?,?,?,?,'pending',?,?,?,?,?)`
    ).run(id, input.requestedBy, input.capability, input.tier, input.summary,
      input.target ?? null, input.amountCents ?? null,
      input.payload === undefined ? null : JSON.stringify(input.payload), at);
    return this.getApproval(id)!;
  }

  getApproval(id: ApprovalId): Approval | null {
    const r = this.#db.prepare('SELECT * FROM approvals WHERE id=?').get(id) as Row | undefined;
    return r ? this.#toApproval(r) : null;
  }

  listApprovals(state: Approval['state'] = 'pending', tier?: ApprovalTier): Approval[] {
    const sql = tier
      ? 'SELECT * FROM approvals WHERE state=? AND tier=? ORDER BY requested_at'
      : 'SELECT * FROM approvals WHERE state=? ORDER BY requested_at';
    const args = tier ? [state, tier] : [state];
    return (this.#db.prepare(sql).all(...(args as never[])) as Row[]).map((r) => this.#toApproval(r));
  }

  /**
   * Decisions on this agent's own requests, most recent first.
   *
   * Without this an agent sees "something was rejected" in the event stream
   * and never learns WHY — the reason sits in a column nothing renders. A
   * review loop whose verdict never reaches the author is not a review loop.
   */
  decisionsFor(agentId: AgentId, limit = 5): Approval[] {
    return (this.#db.prepare(
      `SELECT * FROM approvals WHERE requested_by=? AND state IN ('approved','rejected')
       ORDER BY decided_at DESC LIMIT ?`
    ).all(agentId, limit) as Row[]).map((r) => this.#toApproval(r));
  }

  /**
   * Everything already decided, most recent first.
   *
   * The board's queue empties as it works, which left the console showing an
   * empty Envelope for a company that had published twice and refused twice.
   * What went out, and what was turned down and why, is the part worth keeping
   * — the pending list is only the part that still needs someone.
   */
  decided(limit = 40, tier?: ApprovalTier): Approval[] {
    const sql = tier
      ? `SELECT * FROM approvals WHERE state IN ('approved','rejected') AND tier=?
         ORDER BY decided_at DESC, id DESC LIMIT ?`
      : `SELECT * FROM approvals WHERE state IN ('approved','rejected')
         ORDER BY decided_at DESC, id DESC LIMIT ?`;
    const args = tier ? [tier, limit] : [limit];
    return (this.#db.prepare(sql).all(...(args as never[])) as Row[]).map((r) => this.#toApproval(r));
  }

  /**
   * Decide a pending approval. Returns false if it was already decided —
   * this is what makes approval exactly-once, so a draft cannot publish twice.
   */
  decideApproval(id: ApprovalId, decidedBy: AgentId, approved: boolean, reason: string): boolean {
    const res = this.#db.prepare(
      `UPDATE approvals SET state=?, decided_by=?, decided_at=?, decision_reason=?
       WHERE id=? AND state='pending'`
    ).run(approved ? 'approved' : 'rejected', decidedBy, this.#clock.iso(), reason, id);
    return Number(res.changes) === 1;
  }

  /**
   * Take back your own pending request.
   *
   * Without this the only way to say "do not approve that one" was to file
   * another draft saying so, and the board's queue became a conversation: nine
   * items waiting, six of them corrections and withdrawals about the other
   * three. A queue you have to read in order to discover which entries are
   * already dead is not a queue.
   *
   * Recorded as a rejection because that is what it is — the request is not
   * going ahead — decided by the person who asked for it. Requiring
   * requested_by to match is the whole safety of it: this can only ever ask
   * for less than was already asked for, never more, and nobody can retract
   * somebody else's request.
   */
  withdrawApproval(id: ApprovalId, by: AgentId, reason: string): boolean {
    const res = this.#db.prepare(
      `UPDATE approvals SET state='rejected', decided_by=?, decided_at=?, decision_reason=?
       WHERE id=? AND state='pending' AND requested_by=?`
    ).run(by, this.#clock.iso(), `withdrawn by ${by}: ${reason}`, id, by);
    return Number(res.changes) === 1;
  }

  #toApproval(r: Row): Approval {
    return {
      id: str(r['id']), requestedBy: str(r['requested_by']),
      capability: str(r['capability']) as Capability, tier: str(r['tier']) as ApprovalTier,
      state: str(r['state']) as Approval['state'], summary: str(r['summary']),
      target: nstr(r['target']), amountCents: nnum(r['amount_cents']),
      payloadJson: nstr(r['payload_json']), requestedAt: str(r['requested_at']),
      decidedBy: nstr(r['decided_by']), decidedAt: nstr(r['decided_at']),
      decisionReason: nstr(r['decision_reason']),
    };
  }

  // ----------------------------------------------------------------- money
  spentTodayCents(agentId: AgentId): number {
    const r = this.#db.prepare(
      'SELECT COALESCE(SUM(amount_cents),0) AS s FROM spend WHERE agent_id=? AND spend_day=?'
    ).get(agentId, this.#clock.day()) as Row;
    return num(r['s']);
  }

  /**
   * House Rule 4, enforced rather than requested.
   *
   * BEGIN IMMEDIATE takes the write lock BEFORE the SUM is read, so two staff
   * members spending concurrently serialise here instead of both observing the
   * same "remaining" and both being allowed through. Without IMMEDIATE this is
   * a textbook check-then-act race and the cap leaks real money.
   */
  trySpend(input: {
    agentId: AgentId; amountCents: number; purpose: string;
    capCents: number; approvalId?: ApprovalId | null;
  }): SpendOutcome {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new TypeError(`spend must be a positive integer number of cents, got ${input.amountCents}`);
    }
    const day = this.#clock.day();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const cur = this.#db.prepare(
        'SELECT COALESCE(SUM(amount_cents),0) AS s FROM spend WHERE agent_id=? AND spend_day=?'
      ).get(input.agentId, day) as Row;
      const spent = num(cur['s']);

      if (spent + input.amountCents > input.capCents) {
        this.#db.exec('ROLLBACK');
        return {
          ok: false, reason: 'capped', spentTodayCents: spent,
          capCents: input.capCents, requestedCents: input.amountCents,
        };
      }

      const id = newId('spn', this.#clock.now());
      const at = this.#clock.iso();
      this.#db.prepare(
        'INSERT INTO spend(id,agent_id,amount_cents,purpose,approval_id,at,spend_day) VALUES(?,?,?,?,?,?,?)'
      ).run(id, input.agentId, input.amountCents, input.purpose, input.approvalId ?? null, at, day);
      this.#db.exec('COMMIT');

      const record: SpendRecord = {
        id, agentId: input.agentId, amountCents: input.amountCents,
        purpose: input.purpose, approvalId: input.approvalId ?? null, at,
      };
      return {
        ok: true, record,
        spentTodayCents: spent + input.amountCents,
        remainingCents: input.capCents - (spent + input.amountCents),
      };
    } catch (err) {
      try { this.#db.exec('ROLLBACK'); } catch { /* already unwound */ }
      throw err;
    }
  }

  // -------------------------------------------------------------- messages
  /**
   * Deliver mail. `to: null` broadcasts to every active staff member except
   * the sender. Returns how many people it reached.
   *
   * Delivery is a row, not a call — nobody blocks, and the recipient reads it
   * on their next tick. This is what keeps 22 staff from deadlocking on each
   * other.
   */
  /**
   * Deliver to one person, to several by name, or to everybody.
   *
   * A list is not a broadcast. The founder replying to mail between two
   * colleagues has to reach both of them, and each agent's inbox is strictly
   * its own rows — nobody can see a conversation they were left out of. Every
   * row of one send shares a sent_at, which is what lets the whole-company
   * view fold them back into the single message they were.
   */
  sendMessage(from: AgentId, to: AgentId | AgentId[] | null, body: string): number {
    const at = this.#clock.iso();
    const named = to === null ? null : [...new Set(([] as AgentId[]).concat(to))];
    const recipients = named
      ? named.filter((id) => id !== from)
      : this.listAgents().map((a) => a.id).filter((id) => id !== from);

    const stmt = this.#db.prepare(
      'INSERT INTO messages(id,from_agent,to_agent,body,broadcast,sent_at) VALUES(?,?,?,?,?,?)'
    );
    for (const r of recipients) {
      stmt.run(newId('msg', this.#clock.now()), from, r, body, named ? 0 : 1, at);
    }
    return recipients.length;
  }

  /** Unread mail, oldest first. Marking read is the caller's choice so a
   *  failed tick does not silently swallow someone's message. */
  inbox(agentId: AgentId, markRead = false): Message[] {
    const rows = this.#db.prepare(
      // id breaks the tie: several messages can be written inside the same
      // millisecond, and an ORDER BY that is not total reshuffles the list on
      // every read.
      'SELECT * FROM messages WHERE to_agent=? AND read_at IS NULL ORDER BY sent_at, id'
    ).all(agentId) as Row[];

    const msgs = rows.map((r) => ({
      id: str(r['id']), from: str(r['from_agent']), to: str(r['to_agent']), alsoTo: [],
      yours: true,
      body: str(r['body']), broadcast: num(r['broadcast']) === 1,
      sentAt: str(r['sent_at']), readAt: nstr(r['read_at']),
    }));

    if (markRead && msgs.length > 0) {
      const now = this.#clock.iso();
      const upd = this.#db.prepare('UPDATE messages SET read_at=? WHERE id=?');
      for (const m of msgs) upd.run(now, m.id);
    }
    return msgs;
  }

  /**
   * Your side of the conversation: what reached you, and what you sent.
   *
   * inbox() deliberately returns only what is unread, because an agent waking
   * up wants what it has not seen. A person reading their own mail wants the
   * conversation, so this is the other half.
   *
   * Sent mail belongs here. Filtering on to_agent alone meant a message the
   * board wrote vanished the instant it was sent — the console showed an empty
   * inbox and no evidence the send had happened at all.
   */
  messagesFor(agentId: AgentId, limit = 200): Message[] {
    return this.#thread(agentId, limit, true);
  }

  /**
   * Every message in the company, not only the ones addressed to you.
   *
   * Most of a company's conversation never reaches the board — staff write to
   * each other far more than they write to anyone reading this. The inbox is a
   * slice; this is the whole thing.
   *
   * A broadcast is stored as one row per recipient, so it has to be folded
   * back into the single message it was. Grouping on sender, instant and body
   * does that; direct messages group on their own id, which groups nothing.
   */
  allMessages(viewer: AgentId, limit = 500): Message[] {
    return this.#thread(viewer, limit, false);
  }

  /**
   * The folded message list, either whole or narrowed to one person's threads.
   *
   * Read state is per row, and a collapsed message has several. The only one
   * that means anything to the reader is their own — so the viewer's row
   * supplies both the read mark and the id, because marking read is scoped to
   * to_agent and the group's MIN(id) is usually somebody else's row. Reading
   * the whole company used to drop read state entirely, which hid your own
   * unread mail the moment you widened the view.
   */
  #thread(viewer: AgentId, limit: number, mineOnly: boolean): Message[] {
    const rows = this.#db.prepare(
      `SELECT MIN(id) AS id, from_agent, body, broadcast, sent_at,
              MAX(CASE WHEN to_agent=? THEN id END) AS my_id,
              MAX(CASE WHEN to_agent=? THEN 1 ELSE 0 END) AS mine,
              MAX(CASE WHEN to_agent=? THEN read_at END) AS read_at,
              CASE WHEN broadcast=1 THEN NULL ELSE group_concat(to_agent) END AS to_agent
       FROM messages
       GROUP BY from_agent || sent_at || body
       ${mineOnly ? 'HAVING from_agent=? OR MAX(CASE WHEN to_agent=? THEN 1 ELSE 0 END)=1' : ''}
       ORDER BY sent_at DESC, id DESC LIMIT ?`
    ).all(...(mineOnly
      ? [viewer, viewer, viewer, viewer, viewer, limit]
      : [viewer, viewer, viewer, limit])) as Row[];
    return rows.map((r) => {
      // group_concat has no defined order, and a list that reshuffles between
      // reads makes the same message look like a different one each time.
      const named = (nstr(r['to_agent']) ?? '').split(',').filter(Boolean).sort();
      const yours = num(r['mine']) === 1;
      return {
        id: yours ? str(r['my_id']) : str(r['id']), from: str(r['from_agent']),
        to: named[0] ?? null, alsoTo: named.slice(1),
        body: str(r['body']), broadcast: num(r['broadcast']) === 1,
        sentAt: str(r['sent_at']), readAt: nstr(r['read_at']), yours,
      };
    });
  }

  unreadCount(agentId: AgentId): number {
    const r = this.#db.prepare(
      'SELECT COUNT(*) AS c FROM messages WHERE to_agent=? AND read_at IS NULL'
    ).get(agentId) as Row;
    return num(r['c']);
  }

  /**
   * Mark specific messages read, or everything addressed to someone.
   *
   * Reversible on purpose. Putting a message back to unread is how people
   * keep something visible when they read it at a moment they cannot act on
   * it, and a one-way "read" turns the inbox into a list you can only lose
   * things from.
   */
  markRead(agentId: AgentId, ids?: string[], read = true): number {
    const at = read ? this.#clock.iso() : null;
    const cond = read ? 'read_at IS NULL' : 'read_at IS NOT NULL';
    if (ids?.length) {
      const upd = this.#db.prepare(
        `UPDATE messages SET read_at=? WHERE id=? AND to_agent=? AND ${cond}`);
      let n = 0;
      for (const id of ids) n += upd.run(at, id, agentId).changes as number;
      return n;
    }
    const r = this.#db.prepare(`UPDATE messages SET read_at=? WHERE to_agent=? AND ${cond}`)
      .run(at, agentId);
    return r.changes as number;
  }

  // ------------------------------------------------------------ notes index
  indexNote(n: { path: string; author: AgentId; subject: string | null; title: string; writtenAt: string }): void {
    this.#db.prepare(
      `INSERT INTO notes_index(path,author,subject,title,written_at,indexed_at) VALUES(?,?,?,?,?,?)
       ON CONFLICT(path) DO UPDATE SET author=excluded.author, subject=excluded.subject,
         title=excluded.title, written_at=excluded.written_at, indexed_at=excluded.indexed_at`
    ).run(n.path, n.author, n.subject, n.title, n.writtenAt, this.#clock.iso());
  }

  clearNoteIndex(): void { this.#db.exec('DELETE FROM notes_index'); }

  countNotes(): number {
    const r = this.#db.prepare('SELECT COUNT(*) AS c FROM notes_index').get() as Row;
    return num(r['c']);
  }

  notesAbout(subject: AgentId): Array<{ path: string; author: string; title: string; writtenAt: string }> {
    return (this.#db.prepare(
      'SELECT path,author,title,written_at FROM notes_index WHERE subject=? ORDER BY written_at DESC'
    ).all(subject) as Row[]).map((r) => ({
      path: str(r['path']), author: str(r['author']),
      title: str(r['title']), writtenAt: str(r['written_at']),
    }));
  }
}
