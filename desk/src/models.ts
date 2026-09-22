import { ref, type Ref } from 'vue';
import { api, type Effort, type ModelOption } from './api';

/**
 * The model catalog, fetched once per page load and shared by every view that
 * offers a model picker. The server asks the bundled CLI for it, which spawns a
 * process — not something to repeat on each company switch or each open seat.
 *
 * `status` is what lets a picker tell "this model is not offered" from "the list
 * has not arrived": without it the stored setting was labelled unoffered for
 * the seconds the first spawn takes, which reads as a broken setting to fix.
 */
export type CatalogStatus = 'loading' | 'ready' | 'failed';

let pending: Promise<void> | null = null;
const models = ref<ModelOption[]>([]);
const status = ref<CatalogStatus>('loading');
/** The server could not ask the CLI and sent its static list of common aliases. */
const fallback = ref(false);

export const useModels = (): { models: Ref<ModelOption[]>; status: Ref<CatalogStatus>; fallback: Ref<boolean> } => {
  if (!pending) status.value = 'loading';
  pending ??= api.models()
    .then((c) => {
      models.value = c.models;
      fallback.value = c.source === 'fallback';
      status.value = 'ready';
    })
    // The pickers keep what is already set; the next view to mount asks again.
    .catch(() => { status.value = 'failed'; pending = null; });
  return { models, status, fallback };
};

/** A seat's setting that defers to the company's. Mirrors INHERIT in src/core/models.ts. */
export const INHERIT = 'company';

/** Typed on Effort so a level added server-side fails the check here until it has words. */
export const EFFORT_HINTS: Record<Effort, string> = {
  low: 'Quick, and lightest on the window.',
  medium: 'Balanced. What every shift ran at before this was a setting.',
  high: 'Thinks longer before acting.',
  xhigh: 'Deliberate. Noticeably heavier on the window.',
  max: 'Everything it has. Spends the window fastest.',
};
export const EFFORTS = Object.keys(EFFORT_HINTS) as Effort[];

/** "Default (recommended) · claude-opus-5-5[1m]" — the name, and what it means today. */
export const modelLabel = (list: readonly ModelOption[], value: string): string => {
  const m = list.find((x) => x.value === value);
  if (!m) return value;
  return m.resolved && m.resolved !== m.value ? `${m.label} · ${m.resolved}` : m.label;
};

/** Effort levels the model takes (empty: it takes none), or null for a model the catalog does not list. */
export const effortsFor = (list: readonly ModelOption[], value: string): readonly string[] | null => {
  const m = list.find((x) => x.value === value);
  if (!m) return null;
  return m.efforts;
};

/** The pickers' rows, plus any stored value the catalog lacks — flagged only once the list has actually arrived. */
export const withStored = (
  list: readonly ModelOption[], ready: boolean, stored: Iterable<string>,
): Array<{ value: string; label: string }> => {
  const rows = list.map((m) => ({ value: m.value, label: modelLabel(list, m.value) }));
  for (const v of new Set(stored)) {
    if (v === INHERIT || rows.some((r) => r.value === v)) continue;
    rows.unshift({ value: v, label: ready ? `${v} (not offered by this CLI)` : v });
  }
  return rows;
};
