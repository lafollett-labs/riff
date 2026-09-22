-- ledger.db — the machine-authored half of a company.
-- Small on purpose. If a rule or a render frame does not depend on it,
-- it belongs in world/ as markdown the staff can invent for themselves.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- tier is structural and closed; role and department are free text the CEO
-- invents. Constraining job titles in schema is exactly the kind of ceremony
-- that made a previous system unmanageable.
CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  tier        TEXT NOT NULL CHECK (tier IN ('board','executive','lead','member')),
  role        TEXT NOT NULL,
  department  TEXT NOT NULL DEFAULT '',
  reports_to  TEXT REFERENCES agents(id),
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','idle','departed')),
  activity    TEXT NOT NULL DEFAULT '',
  mandate     TEXT NOT NULL DEFAULT '',
  hired_at    TEXT NOT NULL,
  hired_by    TEXT REFERENCES agents(id),
  model       TEXT NOT NULL,
  -- 'company' follows the company default; see src/core/models.ts.
  effort      TEXT NOT NULL DEFAULT 'company'
);



CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open','claimed','in_progress','blocked','done','dropped')),
  created_by  TEXT NOT NULL REFERENCES agents(id),
  assigned_to TEXT REFERENCES agents(id),
  parent_id   TEXT REFERENCES tasks(id),
  priority    INTEGER NOT NULL DEFAULT 5,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status, priority);

-- House Rule 3 lives here. Anything touching the outside world stops in this
-- table as a draft and does not move until a human says so.
CREATE TABLE IF NOT EXISTS approvals (
  id              TEXT PRIMARY KEY,
  requested_by    TEXT NOT NULL REFERENCES agents(id),
  capability      TEXT NOT NULL,
  tier            TEXT NOT NULL CHECK (tier IN ('executive','board')),
  state           TEXT NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending','approved','rejected','expired')),
  summary         TEXT NOT NULL,
  target          TEXT,
  amount_cents    INTEGER,
  payload_json    TEXT,
  requested_at    TEXT NOT NULL,
  decided_by      TEXT REFERENCES agents(id),
  decided_at      TEXT,
  decision_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(state, tier, requested_at);

-- House Rule 4. Integer cents only; floats do not touch money.
-- Guarded by BEGIN IMMEDIATE in the gate so check-then-spend cannot race.
CREATE TABLE IF NOT EXISTS spend (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  purpose      TEXT NOT NULL,
  approval_id  TEXT REFERENCES approvals(id),
  at           TEXT NOT NULL,
  spend_day    TEXT NOT NULL           -- 'YYYY-MM-DD', local day the cap resets on
);
CREATE INDEX IF NOT EXISTS idx_spend_day ON spend(spend_day, agent_id);

-- Append-only. Everything that happened, in order. The map, the morale meter,
-- and "what did they do while I was gone" are all projections of this.
CREATE TABLE IF NOT EXISTS events (
  id      TEXT PRIMARY KEY,
  seq     INTEGER NOT NULL,
  at      TEXT NOT NULL,
  actor   TEXT NOT NULL,
  kind    TEXT NOT NULL,
  subject TEXT,
  data_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_seq  ON events(seq);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, at);
CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor, at);

-- Staff-to-staff mail. Deliberately ASYNCHRONOUS: a message is a row the
-- recipient picks up on their NEXT tick, never a blocking call into another
-- agent. With 22 staff, synchronous messaging deadlocks (A waits on B waits
-- on A) and bills a full turn per message. A broadcast fans out to one row
-- per recipient at send time, which keeps read-tracking per-person trivial.
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL REFERENCES agents(id),
  to_agent   TEXT NOT NULL REFERENCES agents(id),
  body       TEXT NOT NULL,
  broadcast  INTEGER NOT NULL DEFAULT 0,
  sent_at    TEXT NOT NULL,
  read_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages(to_agent, read_at, sent_at);

-- DERIVED, never authoritative. Notes are markdown files the staff wrote about
-- each other; this is only an index so the UI can count and sort them.
-- Safe to DELETE and rebuild from world/ at any time.
CREATE TABLE IF NOT EXISTS notes_index (
  path       TEXT PRIMARY KEY,
  author     TEXT NOT NULL,
  subject    TEXT,
  title      TEXT NOT NULL DEFAULT '',
  written_at TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_subject ON notes_index(subject, written_at);
CREATE INDEX IF NOT EXISTS idx_notes_author  ON notes_index(author, written_at);
