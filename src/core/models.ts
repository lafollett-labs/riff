import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';

/**
 * Which model a staff member thinks with, and how hard.
 *
 * Two layers, the way Claude Code's own `/model` works: the company sets a
 * default, and any one seat may override it. A seat that has not been given a
 * setting of its own holds `INHERIT`, so changing the company default moves
 * everyone who has not been singled out — which is the point. Every seat used
 * to be stamped `claude-opus-5` at hire and nothing could change it, so a new
 * model reached nobody until someone edited the ledger by hand.
 *
 * Only the board sets these. No tool offers them to staff, and a shift's shell
 * cannot write the ledger they live in (see companyControlFiles): a CEO free to
 * hire every seat at `max` is a CEO free to spend the operator's week by Tuesday.
 */

/** A seat's setting that defers to the company's. */
export const INHERIT = 'company';

/**
 * The CLI's own default, passed through as-is, so "Default" means exactly what
 * it means in Claude Code: the latest Opus the bundled CLI knows. Pinning a
 * model id here instead would quietly stop tracking the moment a newer Opus
 * shipped — which is how every seat ended up on Opus 5 the day 5.5 came out.
 */
export const DEFAULT_MODEL = 'default';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly EffortLevel[];
export type Effort = (typeof EFFORTS)[number];

export type StaffDefaults = { model: string; effort: Effort };

/** Medium was the one hard-coded effort every shift ran at before this existed. */
export const DEFAULT_STAFF: StaffDefaults = { model: DEFAULT_MODEL, effort: 'medium' };

/**
 * The shape of a model id or alias the CLI accepts: `default`, `sonnet`,
 * `opus[1m]`, `claude-fable-5-1[1m]`. Checked on read so a hand-edited config
 * cannot put a shell-ish string into a spawn argument; whether the model
 * actually exists is the catalog's question, asked where the setting is made.
 */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[0-9a-z]+\])?$/;
export const isModelId = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 80 && MODEL_RE.test(v);
export const isEffort = (v: unknown): v is Effort =>
  typeof v === 'string' && (EFFORTS as readonly string[]).includes(v);

/** A stored company default, or the built-in one for anything unusable. */
export const readStaffDefaults = (raw: unknown): StaffDefaults => {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    model: isModelId(o['model']) ? o['model'] : DEFAULT_STAFF.model,
    effort: isEffort(o['effort']) ? o['effort'] : DEFAULT_STAFF.effort,
  };
};

/** What a seat actually runs on, once its own settings and the company's are combined. */
export const mindOf = (
  seat: { model: string; effort: string }, company: StaffDefaults,
): StaffDefaults => ({
  model: seat.model === INHERIT || !isModelId(seat.model) ? company.model : seat.model,
  effort: isEffort(seat.effort) ? seat.effort : company.effort,
});

/**
 * One row of the model picker, as the bundled CLI describes it (`/model`'s own
 * list). `efforts` is empty for a model that takes no effort setting — Haiku —
 * where the SDK drops the parameter rather than refusing it.
 */
export type ModelOption = {
  value: string;
  label: string;
  description: string;
  /** The wire id an alias resolves to today, e.g. `default` → `claude-opus-5-5[1m]`. */
  resolved?: string;
  efforts: Effort[];
};

export type ModelCatalog = {
  models: ModelOption[];
  /** `sdk` when the list came from the CLI itself; `fallback` when asking it failed. */
  source: 'sdk' | 'fallback';
};
