import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { query, type ModelInfo } from '@anthropic-ai/claude-agent-sdk';
import { isEffort, isModelId, type ModelCatalog, type ModelOption } from '../core/models.ts';

/**
 * The models a staff member may be given, asked of the bundled CLI itself.
 *
 * `supportedModels()` is the list Claude Code's own `/model` shows, with each
 * alias's resolved id and the effort levels it takes. Asking it rather than
 * keeping a table here means an SDK bump brings its models with it: the day
 * Opus 5.5 shipped, 0.3.243 still resolved `default` to Opus 5 and 0.3.280
 * resolved it to 5.5 — a table in this file would have been wrong for both.
 *
 * It needs no credential (measured: a probe inside the factory, with no token in
 * its env, answered in seconds), so it is given none — see probeEnv. The session is given
 * nothing to do: no prompt ever arrives, no tool can be granted, and it is
 * closed as soon as it has answered.
 */

/**
 * What 0.3.280 answered on 2026-09-22, used only when asking fails, so the
 * picker still offers the aliases every account has rather than nothing.
 */
const FALLBACK: ModelOption[] = [
  { value: 'default', label: 'Default (recommended)', description: 'The latest Opus', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'opus[1m]', label: 'Opus (1M context)', description: 'Opus with 1M context', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', label: 'Sonnet', description: 'Efficient for routine tasks', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', label: 'Haiku', description: 'Fastest for quick answers', efforts: [] },
];

const ASK_TIMEOUT_MS = 30_000;
/** A failed ask is retried this long after, not on every request to the picker. */
const RETRY_AFTER_MS = 10 * 60_000;

/** The CLI's rows, less its price list: costUsd is imputed, and a subscription pays none of it. */
export const toOptions = (rows: readonly ModelInfo[]): ModelOption[] =>
  rows.filter((r) => isModelId(r.value)).map((r) => ({
    value: r.value,
    label: r.displayName,
    // "Opus 5 with 1M context · Best for everyday, complex tasks · $5/$25 per Mtok"
    description: r.description.split(' · ').filter((s) => !s.includes('$')).join(' · '),
    ...(r.resolvedModel ? { resolved: r.resolvedModel } : {}),
    efforts: r.supportsEffort === false ? [] : (r.supportedEffortLevels ?? []).filter(isEffort),
  }));

/**
 * The probe's environment: the process's, less anything that authenticates,
 * and a throwaway config dir. On a host (the test suite, a dev gateway) the
 * inherited env is the operator's own login; the list needs none of it.
 */
const probeEnv = (configDir: string): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_CONFIG_DIR$)/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
};

export const askCli = async (): Promise<ModelInfo[]> => {
  const abortController = new AbortController();
  const configDir = mkdtempSync(join(tmpdir(), 'riff-models-'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Raced, not only aborted: the abort reaching supportedModels() depends on SDK
  // internals, and a promise left pending here would hang every model request.
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abortController.abort();
      reject(new Error(`the CLI did not list its models within ${ASK_TIMEOUT_MS / 1000}s`));
    }, ASK_TIMEOUT_MS);
  });
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  // Never yields: the catalog is a control request, and a prompt would start a turn.
  async function* nothing(): AsyncGenerator<never> { await held; }
  let q: ReturnType<typeof query> | undefined;
  try {
    q = query({
      prompt: nothing(),
      options: {
        cwd: tmpdir(),
        env: probeEnv(configDir),
        settingSources: [],
        persistSession: false,
        tools: [],
        canUseTool: async () => ({ behavior: 'deny', message: 'the model catalog probe runs nothing' }),
        abortController,
      },
    });
    return await Promise.race([q.supportedModels(), expired]);
  } finally {
    clearTimeout(timer);
    release();
    q?.close();
    rmSync(configDir, { recursive: true, force: true });
  }
};

/**
 * The catalog, asked once per process and kept. A failure is not kept as
 * success: the fallback is served and the CLI asked again after a while.
 */
export const catalogFrom = (ask: () => Promise<readonly ModelInfo[]>, now = Date.now) => {
  let kept: ModelCatalog | null = null;
  let failedAt: number | null = null;
  let inFlight: Promise<ModelCatalog> | null = null;
  return (): Promise<ModelCatalog> => {
    if (kept) return Promise.resolve(kept);
    if (failedAt !== null && now() - failedAt < RETRY_AFTER_MS) {
      return Promise.resolve({ models: FALLBACK, source: 'fallback' });
    }
    inFlight ??= ask()
      .then((rows) => {
        const models = toOptions(rows);
        if (!models.length) throw new Error('the CLI listed no models');
        kept = { models, source: 'sdk' };
        return kept;
      })
      .catch((): ModelCatalog => {
        failedAt = now();
        return { models: FALLBACK, source: 'fallback' };
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  };
};

export const modelCatalog = catalogFrom(askCli);
