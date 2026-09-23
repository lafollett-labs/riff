<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { api, type PlanUsage, type RuntimeCredential, type RuntimeCredentialType } from '../api';
import { pressedByKeyboard, rehome } from '../focus';

/**
 * Installation-level settings — Riff itself, not any one company. Today just the
 * DEFAULT runtime credential every company inherits until it sets its own: the
 * credential the agents' own Claude inference runs on. The token value is
 * write-only, exactly like a secret — set here and never shown again; all this
 * reads back is the type and that a value is set. A company overrides it from its
 * own Overview. Rendered outside App's per-company state guard, like Companies,
 * so it opens with no company selected — it takes no props and fetches its own.
 */
const loaded = ref<RuntimeCredential | null>(null);
const valueSet = ref(false);
const loading = ref(true);
const err = ref('');

const type = ref<RuntimeCredentialType>('subscription');
const value = ref('');
const saving = ref(false);
const justSaved = ref(false);
const confirmRemove = ref(false);
const removing = ref(false);

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// The type currently stored, or null when nothing is set — shown in the status.
const loadedType = computed<RuntimeCredentialType | null>(() => loaded.value?.type ?? null);
// A save always carries a token: the stored value is provider-specific, so the
// type is chosen alongside the value it applies to, never on its own. This is the
// client half of the server's type+value atomicity — Save stays inert until a
// token is entered, so a stray click can never store a type with no value.
const dirty = computed(() => !!value.value);
const canSave = computed(() => dirty.value && !saving.value);
// A fresh keystroke means the last "Saved." no longer describes the field, and
// starting to type a replacement is not the moment to be mid-way through a remove.
watch(value, (v) => { if (v) { justSaved.value = false; confirmRemove.value = false; } });

const label = (t: RuntimeCredentialType): string =>
  t === 'subscription' ? 'Subscription token' : 'API key';

// ------------------------------------------------------------- plan usage
/**
 * The plan's windows, and how stale they may get. They are read off the
 * runtime credential's own responses — every shift refreshes them for free —
 * and while nothing runs, a one-token call refreshes them once the reading is
 * older than this. Figures are account-wide, so they include your own use.
 */
const usage = ref<PlanUsage | null>(null);
const usageErr = ref(false);
// null until the server's value arrives: a literal here would show a default
// as though it were saved, and an edit made during the load would be lost.
const pollMinutes = ref<number | null>(null);
const savedMinutes = ref<number | null>(null);
const pollMax = ref(25);
const pollSaving = ref(false);
const pollSaved = ref(false);
const pollErr = ref('');
const pollDirty = computed(() => pollMinutes.value !== savedMinutes.value);
watch(pollDirty, (d) => { if (d) pollSaved.value = false; });
watch(pollMinutes, () => { pollErr.value = ''; });

// Per-model weeks too: when one of them binds, the plain seven-day figure is
// the comfortable-looking number that is not the limit.
const WINDOW_NAMES: Record<string, string> = {
  five_hour: '5-hour', seven_day: '7-day', seven_day_opus: '7-day Opus', seven_day_sonnet: '7-day Sonnet',
};
const shown = computed(() => (usage.value?.windows ?? [])
  .filter((w) => w.utilization != null && WINDOW_NAMES[w.kind])
  .map((w) => ({ name: WINDOW_NAMES[w.kind]!, pct: Math.round((w.utilization ?? 0) * 100) })));
// A ticking clock, so "read 3 min ago" keeps telling the truth while the page
// is open; the same tick fetches the reading again.
const now = ref(Date.now());
const age = computed(() => {
  if (!usage.value?.at) return '';
  const min = Math.round((now.value - Date.parse(usage.value.at)) / 60_000);
  return min < 1 ? 'just now' : min < 90 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
});
const readUsage = async (): Promise<void> => {
  try { usage.value = await api.usage(); usageErr.value = false; }
  catch { usageErr.value = true; }
};
let tick: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  tick = setInterval(() => { now.value = Date.now(); void readUsage(); }, 60_000);
});
onBeforeUnmount(() => clearInterval(tick));

const savePoll = async (e?: UIEvent): Promise<void> => {
  const m = pollMinutes.value;
  if (typeof m !== 'number' || !Number.isFinite(m)) { pollErr.value = 'Enter a number of minutes.'; return; }
  const from = pressedByKeyboard(e);
  let landed = false;
  pollSaving.value = true;
  try {
    const r = await api.putUsagePoll(m);
    pollMinutes.value = savedMinutes.value = r.usagePollMinutes;
    pollSaved.value = true;
    pollErr.value = '';
    landed = true;
  } catch (e) { pollErr.value = msg(e); }
  finally { pollSaving.value = false; void rehome(from, 'usage-poll', landed); }
};

const load = async (): Promise<void> => {
  try {
    const s = await api.settings();
    loaded.value = s.runtimeCredential;
    valueSet.value = s.runtimeCredentialSet;
    pollMinutes.value = savedMinutes.value = s.usagePollMinutes ?? 10;
    if (s.usagePollMax != null) pollMax.value = s.usagePollMax;
    await readUsage();
    if (s.runtimeCredential) type.value = s.runtimeCredential.type;
    err.value = '';
  } catch (e) { err.value = msg(e); }
  finally { loading.value = false; }
};

const save = async (e?: UIEvent): Promise<void> => {
  if (!canSave.value) return;
  const from = pressedByKeyboard(e);
  let landed = false;
  saving.value = true;
  justSaved.value = false;
  try {
    // dirty guarantees a value; type and value are sent together.
    const r = await api.putSettings({
      runtimeCredential: { type: type.value },
      value: value.value,
    });
    loaded.value = r.runtimeCredential;
    valueSet.value = r.runtimeCredentialSet;
    value.value = '';
    justSaved.value = true;
    err.value = '';
    landed = true;
  } catch (e) { err.value = msg(e); }
  finally { saving.value = false; void rehome(from, 'rc-type', landed); }
};

// Clearing the default drops both the type and the vault value. It is behind a
// confirm because every company inheriting it stops until a new default (or its
// own override) is set — a company with its own credential is unaffected.
/** Opening the confirm unmounts the button pressed; Cancel is the safe place to land. */
const openRemove = (e: UIEvent) => {
  const from = pressedByKeyboard(e);
  confirmRemove.value = true;
  void rehome(from, 'rc-remove-cancel', true);
};

/** Cancel removes the confirm it sits in; the button that opened it is back. */
const cancelRemove = (e: UIEvent) => {
  const from = pressedByKeyboard(e);
  confirmRemove.value = false;
  void rehome(from, 'rc-remove', true);
};

const remove = async (e: UIEvent): Promise<void> => {
  const from = pressedByKeyboard(e);
  let landed = false;
  removing.value = true;
  try {
    const r = await api.deleteSettings();
    loaded.value = r.runtimeCredential;
    valueSet.value = r.runtimeCredentialSet;
    value.value = '';
    justSaved.value = false;
    confirmRemove.value = false;
    err.value = '';
    landed = true;
  } catch (e) { err.value = msg(e); }
  finally { removing.value = false; void rehome(from, 'rc-type', landed); }
};

onMounted(load);
</script>

<template>
  <div class="wrap">
    <header class="head">
      <h1>Riff Settings</h1>
      <p class="muted lede">
        Riff itself, not any one company. What is set here is the installation's
        default — every company inherits it until it sets its own.
      </p>
    </header>

    <section class="set">
      <h2>Default runtime credential</h2>

      <p v-if="loading" class="muted note">Loading…</p>
      <template v-else>
        <div class="badge" :class="valueSet ? 'is-set' : 'not-set'" role="status">
          <span class="dot" />
          <span v-if="valueSet">
            Set<template v-if="loaded"> — <b class="mono">{{ label(loaded.type) }}</b></template>
          </span>
          <span v-else>Not set</span>
        </div>

        <p class="muted note">
          The credential the agents' own Claude inference runs on. A subscription
          token is a long-lived setup token; an API key is an Anthropic key. The
          token value is write-only — set once, never shown again; this screen only
          ever reports the type and that a value is set, never the value itself.
          <template v-if="!valueSet"> A company with no credential of its own cannot
          run until an installation default is set.</template>
        </p>

        <label class="fld-l" for="rc-type">Credential type</label>
        <select id="rc-type" class="fld type" v-model="type">
          <option value="subscription">Subscription token</option>
          <option value="apiKey">API key</option>
        </select>

        <label class="fld-l" for="rc-value">Token value</label>
        <input id="rc-value" class="fld val" v-model="value" type="password"
               placeholder="Paste the token — write-only, never shown again"
               spellcheck="false" autocapitalize="off" autocomplete="new-password"
               data-1p-ignore data-lpignore="true" @keydown.enter="save" />
        <p class="hint faint">
          Pick the type, then paste its token — they are saved together. To rotate
          or change it later, set it again.
        </p>

        <div class="row">
          <button class="save" :disabled="!canSave" @click="save">
            {{ saving ? 'Saving…' : 'Save' }}
          </button>
          <button v-if="valueSet && !confirmRemove" id="rc-remove" class="danger" @click="openRemove">
            Remove default
          </button>
        </div>

        <div v-if="confirmRemove" class="confirm" role="alertdialog" aria-label="Confirm removing the default">
          <p>
            Remove the installation default? Every company inheriting it stops
            until a new default — or its own credential — is set.
          </p>
          <div class="row">
            <button class="danger" :disabled="removing" @click="remove">
              {{ removing ? 'Removing…' : 'Remove' }}
            </button>
            <button id="rc-remove-cancel" class="ghost" :disabled="removing" @click="cancelRemove">Cancel</button>
          </div>
        </div>

        <p v-if="err" class="err" role="alert">{{ err }}</p>
        <p v-else-if="justSaved" class="ok" role="status">Saved.</p>
      </template>
    </section>

    <section class="usage">
      <h2>Plan usage</h2>
      <p class="muted note">
        Read off the runtime credential's own responses, so every shift keeps it
        current at no cost. The figures are for the whole account, your own use
        included. While nothing is running, one tiny call (Haiku, one output token)
        refreshes it once the reading is older than the interval below.
      </p>
      <p v-if="loadedType === 'apiKey'" class="faint note">
        The installation's default is an API key, and plan windows exist only for a
        subscription token — so there is no reading, and no refresh is sent.
      </p>
      <template v-else>
        <p v-if="shown.length" class="reading" role="status">
          <span v-for="w in shown" :key="w.name" class="win">
            <b>{{ w.pct }}%</b> <span class="muted">{{ w.name }}</span>
          </span>
          <span class="faint when">read {{ age }}</span>
        </p>
        <p v-else-if="usageErr" class="err" role="alert">Could not read plan usage.</p>
        <p v-else-if="!loading" class="faint note">No reading yet: it arrives with the first call on the installation's credential.</p>
      </template>

      <p v-if="loading" class="muted note">Loading…</p>
      <template v-else-if="pollMinutes !== null">
        <label class="fld-l" for="usage-poll">Refresh an idle reading after (minutes)</label>
        <input id="usage-poll" class="fld mins" v-model.number="pollMinutes" type="number"
               min="0" :max="pollMax" step="1" aria-describedby="usage-poll-why" @keydown.enter="savePoll" />
        <p id="usage-poll-why" class="hint faint">Up to {{ pollMax }}; 0 turns the refresh off, and the reading then updates only while shifts run.</p>
        <div class="row">
          <button class="save" :disabled="pollSaving || !pollDirty" :aria-busy="pollSaving"
                  aria-label="Save usage refresh" @click="savePoll">
            {{ pollSaving ? 'Saving…' : 'Save' }}
          </button>
        </div>
        <p v-if="pollErr" class="err" role="alert">{{ pollErr }}</p>
        <p v-else-if="pollSaved" class="ok" role="status">Saved.</p>
      </template>
    </section>
  </div>
</template>

<style scoped>
.wrap { overflow-y: auto; padding: 34px 44px 60px; max-width: 760px; }
.head { margin-bottom: 8px; }
h1 { font-size: 30px; }
.lede { margin: 6px 0 0; font-size: 14px; max-width: 58ch; }
h2 { font-size: 12px; letter-spacing: .07em; text-transform: uppercase; color: var(--faint);
  margin: 0 0 12px; font-weight: 600; }
section { margin-top: 26px; padding-top: 22px; border-top: 1px solid var(--line); }
.note { font-size: 13px; line-height: 1.6; margin: 0 0 16px; max-width: 62ch; }
.badge { display: inline-flex; align-items: center; gap: 8px; font-size: 13px;
  padding: 7px 12px; border-radius: 6px; margin: 0 0 16px; border: 1px solid; }
.badge .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.badge.is-set { color: var(--ok); background: color-mix(in srgb, var(--ok) 10%, transparent);
  border-color: color-mix(in srgb, var(--ok) 40%, transparent); }
.badge.is-set .dot { background: var(--ok); }
.badge.not-set { color: var(--gold); background: color-mix(in srgb, var(--gold) 10%, transparent);
  border-color: color-mix(in srgb, var(--gold) 40%, transparent); }
.badge.not-set .dot { background: var(--gold); }
.fld-l { display: block; font-size: 12px; color: var(--muted); margin: 0 0 5px; }
.fld { background: #15100d; color: var(--ink); border: 1px solid var(--line-2);
  border-radius: 5px; padding: 8px 10px; font: inherit; font-size: 13px; }
.fld.type { display: block; margin-bottom: 16px; min-width: 220px; }
.fld.val { display: block; width: 100%; max-width: 480px; margin-bottom: 8px;
  font-family: var(--mono, ui-monospace, monospace); }
.fld:focus { outline: none; border-color: var(--accent); }
.hint { font-size: 11px; line-height: 1.5; margin: 0 0 14px; }
.row { display: flex; gap: 8px; margin-top: 4px; }
.save { font: inherit; font-size: 13px; padding: 8px 16px; border-radius: 5px;
  border: 1px solid var(--line-2); background: var(--panel); color: var(--ink);
  cursor: pointer; white-space: nowrap; }
.save:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.save:disabled { opacity: .5; cursor: default; }
.danger, .ghost { font: inherit; font-size: 13px; padding: 8px 16px; border-radius: 5px;
  border: 1px solid var(--line-2); background: var(--panel); cursor: pointer; white-space: nowrap; }
.danger { color: var(--alert); }
.danger:hover:not(:disabled) { border-color: var(--alert); }
.ghost { color: var(--muted); }
.ghost:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.danger:disabled, .ghost:disabled { opacity: .5; cursor: default; }
.confirm { margin-top: 14px; padding: 12px 14px; border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--alert) 40%, transparent);
  background: color-mix(in srgb, var(--alert) 8%, transparent); max-width: 62ch; }
.confirm p { font-size: 13px; line-height: 1.55; margin: 0 0 12px; }
.err { color: var(--alert); font-size: 12px; margin-top: 10px; }
.ok { color: var(--gold); font-size: 12px; margin-top: 10px; }
.fld.mins { display: block; width: 110px; margin-bottom: 8px; }
.reading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 18px; margin: 0 0 18px;
  font-variant-numeric: tabular-nums; }
.reading .win b { font-size: 20px; color: var(--ink); font-weight: 600; }
.reading .win span { font-size: 12px; }
.reading .when { font-size: 12px; }
</style>
