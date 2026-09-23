<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { api, type Effort, type Event, type State, type RuntimeCredentialType } from '../api';
import { useModels, effortsFor, withStored, EFFORTS, EFFORT_HINTS } from '../models';
import { pressedByKeyboard, rehome } from '../focus';

// `events` is part of the shared per-company view contract App.vue binds; this
// view reads only `state`. Declaring it keeps it off the root as a fallthrough.
const props = defineProps<{ state: State; events: Event[] }>();
const emit = defineEmits<{ changed: [] }>();

/**
 * A company's settings: how hard it works, and which credential its own
 * inference runs on. This split out of the front page (Overview) once the
 * config here outgrew a panel behind a Tune toggle — a settings surface shows
 * its controls, it does not hide them.
 */

// --------------------------------------------------------------- thinking
/**
 * The model and effort every seat runs on unless it has its own (Staff). Saved
 * on its own, apart from the dials, because it is read at each wake: saving it
 * rebuilds nothing, so nobody mid-shift is cut off for it.
 */
const { models: catalog, status: catalogStatus, fallback: catalogFallback } = useModels();
const model = ref(props.state.staff.model);
const effort = ref<Effort>(props.state.staff.effort);
const mindSaving = ref(false);
const mindErr = ref('');
const mindSaved = ref(false);

const mindDirty = computed(() =>
  model.value !== props.state.staff.model || effort.value !== props.state.staff.effort);
/** The catalog's rows, plus the stored value when the CLI no longer lists it. */
const modelOptions = computed(() =>
  withStored(catalog.value, catalogStatus.value === 'ready', [props.state.staff.model, model.value]));
const modelNote = computed(() => catalog.value.find((m) => m.value === model.value)?.description ?? '');
/** null: unknown model, so every level stays offered and the server decides. */
const takes = computed(() => effortsFor(catalog.value, model.value));
const noEffort = computed(() => takes.value !== null && takes.value.length === 0);

const resetMind = () => {
  model.value = props.state.staff.model;
  effort.value = props.state.staff.effort;
  mindErr.value = '';
};
watch(() => props.state.staff, () => { if (!mindDirty.value) resetMind(); }, { deep: true });
watch(() => props.state.slug, () => { mindSaved.value = false; resetMind(); });
watch(mindDirty, (d) => { if (d) mindSaved.value = false; });

const saveMind = async (e?: UIEvent) => {
  const from = pressedByKeyboard(e);
  let landed = false;
  mindSaving.value = true;
  mindErr.value = '';
  try {
    await api.renameCompany(props.state.slug, { staff: { model: model.value, effort: effort.value } });
    const s = (await api.state()).staff;
    model.value = s.model;
    effort.value = s.effort;
    mindSaved.value = true;
    landed = true;
    emit('changed');
  } catch (e) {
    mindErr.value = e instanceof Error ? e.message : 'Could not save.';
  } finally {
    mindSaving.value = false;
    void rehome(from, 'co-model', landed);
  }
};

// ------------------------------------------------------------------ dials
/**
 * The dials, in the words of what they do rather than what they are called.
 *
 * `hint` is the thing worth knowing before you move it — every one of these
 * costs something, and none of the costs are obvious from the number.
 */
const DIALS = [
  { key: 'maxTurns', label: 'Turns a shift',
    hint: 'A tool call and its result is one turn. Coding burns five before anything works.',
    min: 1, max: 400, step: 1 },
  { key: 'concurrency', label: 'Working at once',
    hint: 'How many staff may be awake together.', min: 1, max: 16, step: 1 },
  { key: 'baseIntervalMinutes', label: 'Minutes between shifts',
    hint: 'Rank and throttling stretch this; nobody waits exactly this long.',
    min: 0.5, max: 720, step: 0.5 },
  { key: 'rotateAtContextPct', label: 'Fresh conversation at % full',
    hint: 'Mid-shift, the agent writes itself a note and starts over. A long conversation costs six times a short one for the same turn. 0 never rotates.',
    min: 0, max: 90, step: 5 },
  { key: 'rotateAtSessionTurns', label: 'Fresh conversation by turn count',
    hint: 'A second way to start over: a conversation this many turns long is retired even when it is not full, before its control stream ages out. Keep it well above a normal work span. 0 leaves it to % full.',
    min: 0, max: 100000, step: 50 },
  { key: 'commonsCeiling', label: 'Documents in the commons',
    hint: 'Rule 6. Past it, adding one means removing one.', min: 1, max: 500, step: 1 },
  { key: 'portfolioCeiling', label: 'Projects at once',
    hint: 'Rule 7. Continuing is always cheaper than starting, so without a cap a company ships point releases of its first idea forever. 0 turns the rule off.',
    min: 0, max: 200, step: 1 },
  { key: 'shiftTimeoutMinutes', label: 'Minutes a shift may run',
    hint: 'Wall clock before a stuck shift is stopped. Turns and money never advance while a shift waits on something that never answers, and it holds a slot the whole time. 0 disables it.',
    min: 0, max: 1440, step: 5 },
  { key: 'maxSessionHours', label: 'Max runtime (hours)',
    hint: 'The ceiling on a whole run, over any deadline a start asks for. 0 never stops — the safety net for a company left running unattended.',
    min: 0, max: 720, step: 0.5 },
] as const;

/**
 * The dials, grouped so a growing list reads as four short sections rather than
 * one long column. The flat DIALS above stays the single source the dirty-check
 * and the save map iterate — a group only picks which dials sit together — so a
 * dial cannot be shown and then not saved. `extras` marks the one group that
 * also carries the three hand-rendered fields (utilization %, dollars) whose
 * value is transformed in the field.
 */
// Constrained to the DIALS keys so tsgo rejects a stray or renamed key, which
// makes the `!` in groupDials provably safe. The other direction — a dial
// missing from every group, which types cannot catch — is guarded in policy.test.ts.
type DialKey = (typeof DIALS)[number]['key'];

const DIAL_GROUPS: {
  title: string; caption: string; keys: readonly DialKey[]; extras?: boolean;
}[] = [
  { title: 'Cadence', caption: 'How much work each shift, and how often.',
    keys: ['maxTurns', 'concurrency', 'baseIntervalMinutes'] },
  { title: 'Conversations',
    caption: 'When an agent hands its work over and carries on in a fresh conversation mid-shift.',
    keys: ['rotateAtContextPct', 'rotateAtSessionTurns'] },
  { title: 'Rationing', caption: 'What the company may hold at once.',
    keys: ['commonsCeiling', 'portfolioCeiling'] },
  { title: 'Safety limits',
    caption: 'The bounds that keep an unattended run from spending the plan.',
    keys: ['shiftTimeoutMinutes', 'maxSessionHours'], extras: true },
];

const groupDials = (keys: readonly DialKey[]) =>
  keys.map((k) => DIALS.find((d) => d.key === k)!);

// The editable dials are all numeric; shiftTrace is a diagnostic flag set
// elsewhere. Keep it out of the number map the dials bind to — the save merges
// server-side, so leaving it out here never resets it.
const numericDials = (p: Record<string, unknown>): Record<string, number> =>
  Object.fromEntries(Object.entries(p).filter(([, v]) => typeof v === 'number')) as Record<string, number>;

const policy = ref<Record<string, number>>(numericDials(props.state.policy));
const saving = ref(false);
const perr = ref('');
// A successful save shows "Saved." to assistive tech, mirroring the credential
// section — the button silently going disabled is no confirmation on its own.
const justSavedDials = ref(false);

const dirty = computed(() =>
  DIALS.some((d) => policy.value[d.key] !== props.state.policy[d.key])
  || pausePct.value !== Math.round(props.state.policy.pauseAboveUtilization * 100)
  || throttlePct.value !== Math.round(props.state.policy.throttleAboveUtilization * 100)
  || Math.round(capUsd.value * 100) !== props.state.policy.dailyCapCents);

// Utilization is a fraction everywhere it is used and a percentage everywhere
// it is read. Doing that conversion in the field is less confusing than
// asking anyone to type 0.92.
const throttlePct = ref(Math.round(props.state.policy.throttleAboveUtilization * 100));
const pausePct = ref(Math.round(props.state.policy.pauseAboveUtilization * 100));
// Cents in the schema (real money), dollars in the field — nobody edits a cap in cents.
const capUsd = ref(props.state.policy.dailyCapCents / 100);

const applyPolicy = (p: typeof props.state.policy) => {
  policy.value = numericDials(p);
  throttlePct.value = Math.round(p.throttleAboveUtilization * 100);
  pausePct.value = Math.round(p.pauseAboveUtilization * 100);
  capUsd.value = p.dailyCapCents / 100;
  perr.value = '';
};
const resetDials = () => applyPolicy(props.state.policy);

/** Reset disables itself and Save with it; a keyboard press keeps its place. */
const pressReset = (e: UIEvent, reset: () => void, fallback: string) => {
  const from = pressedByKeyboard(e);
  reset();
  void rehome(from, fallback, true);
};

// The dials are always editable now, so the poll must never wipe what is being
// typed. App.vue replaces the whole state object every twenty seconds, firing
// this watch on identity even when the policy came back byte-identical; without
// the dirty guard a paused edit vanished on the next poll and Save greyed out
// with it. A Save reads the clamped policy back itself (see saveDials), so once
// it lands the fields already match the server and this simply keeps them so.
watch(() => props.state.policy, () => {
  if (dirty.value) return;
  resetDials();
}, { deep: true });
watch(() => props.state.slug, () => { justSavedDials.value = false; resetDials(); });
// A fresh edit means the last "Saved." no longer describes the panel.
watch(dirty, (d) => { if (d) justSavedDials.value = false; });

// A blank number field reads back as '' from v-model.number. Treat that as
// "unchanged", never 0 — clearing maxSessionHours or the shift timeout to blank
// must not silently switch a safety bound off; typing 0 still does, on purpose.
const numOr = (v: unknown, fallback: number): number =>
  v === '' || v == null ? fallback : Number(v);

const saveDials = async (e?: UIEvent) => {
  const from = pressedByKeyboard(e);
  let landed = false;
  saving.value = true;
  perr.value = '';
  try {
    await api.renameCompany(props.state.slug, {
      policy: {
        ...(Object.fromEntries(DIALS.map((d) =>
          [d.key, numOr(policy.value[d.key], props.state.policy[d.key])]))),
        // A blanked % field reads back '' from v-model.number, and '' / 100 is 0
        // — which would silently switch off a safety bound. numOr treats blank as
        // "unchanged", the same guard the dials and the cap already carry.
        throttleAboveUtilization:
          numOr(throttlePct.value, Math.round(props.state.policy.throttleAboveUtilization * 100)) / 100,
        pauseAboveUtilization:
          numOr(pausePct.value, Math.round(props.state.policy.pauseAboveUtilization * 100)) / 100,
        dailyCapCents: Math.round(numOr(capUsd.value, props.state.policy.dailyCapCents / 100) * 100),
      },
    });
    // Read the authoritative, clamped policy straight back and show it, rather
    // than leaving the typed pre-clamp values on screen or racing whichever
    // concurrent poll happens to land next. renameCompany returns only { slug }.
    applyPolicy((await api.state()).policy);
    justSavedDials.value = true;
    landed = true;
    emit('changed');
  } catch (e) {
    perr.value = e instanceof Error ? e.message : 'Could not save.';
  } finally {
    saving.value = false;
    void rehome(from, 'dial-cap', landed);
  }
};

// ------------------------------------------------------ runtime credential
/**
 * Which credential this company's OWN Claude inference runs on. `runtimeCredential`
 * is its override (null means it inherits the installation default set in Riff
 * Settings); `runtimeCredentialSet` is whether a token value is stored for it. The
 * value is write-only — the panel only ever knows that one is set, never what it is.
 */
const rcType = ref<RuntimeCredentialType>(props.state.runtimeCredential?.type ?? 'subscription');
const rcValue = ref('');
const rcSaving = ref(false);
const rcJustSaved = ref(false);
const reverting = ref(false);
const rcErr = ref('');
// The hint tells the operator to pick the type BEFORE pasting the token, so at
// that moment rcDirty (a typed value) is still false and the poll-sync below
// would revert the picker. Reverting the type is not cosmetic: it would save the
// next token under the wrong shape. This marks a deliberate pick so the poll
// leaves it alone until the credential is saved or the company is switched.
const rcTypeTouched = ref(false);

const rcOwn = computed(() =>
  props.state.runtimeCredential !== null || props.state.runtimeCredentialSet);
// A save always carries a token: the stored value is provider-specific, so the
// type is picked alongside the value it applies to, never on its own. Client half
// of the server's type+value atomicity — Save stays inert until a token is
// entered, so a stray click can't flip an inheriting company onto a valueless
// override, nor re-type an existing one to a shape its stored token doesn't match.
const rcDirty = computed(() => !!rcValue.value);
const rcCanSave = computed(() => rcDirty.value && !rcSaving.value);
const rcLabel = (t: RuntimeCredentialType): string =>
  t === 'subscription' ? 'Subscription token' : 'API key';

// The 20s poll replaces the whole state; sync the picker from it unless the
// operator is mid-edit, the same protection the dials keep. Switching company
// resets the fields so an unsaved value never retargets the new company.
watch(() => props.state.runtimeCredential, () => {
  if (!rcDirty.value && !rcTypeTouched.value) {
    rcType.value = props.state.runtimeCredential?.type ?? 'subscription';
  }
}, { deep: true });
// A fresh keystroke means the last "Saved." no longer describes the field.
watch(rcValue, (v) => { if (v) rcJustSaved.value = false; });
watch(() => props.state.slug, () => {
  rcType.value = props.state.runtimeCredential?.type ?? 'subscription';
  rcValue.value = ''; rcErr.value = ''; rcJustSaved.value = false; rcTypeTouched.value = false;
});

const saveRc = async (e?: UIEvent) => {
  if (!rcCanSave.value) return;
  const from = pressedByKeyboard(e);
  let landed = false;
  rcSaving.value = true;
  rcJustSaved.value = false;
  try {
    // rcDirty guarantees a value; type and value are sent together.
    await api.putRuntimeCredential({ type: rcType.value, value: rcValue.value });
    rcValue.value = '';
    rcJustSaved.value = true;
    rcErr.value = '';
    // The picked type is now the stored type, so the poll may track it again.
    rcTypeTouched.value = false;
    landed = true;
    emit('changed');
  } catch (e) {
    rcErr.value = e instanceof Error ? e.message : 'Could not save.';
  } finally {
    rcSaving.value = false;
    void rehome(from, 'co-rc-type', landed);
  }
};

const useDefault = async () => {
  reverting.value = true;
  try {
    await api.deleteRuntimeCredential();
    rcValue.value = '';
    rcJustSaved.value = false;
    rcErr.value = '';
    // Back to inheriting: let the poll resync the picker to the default.
    rcTypeTouched.value = false;
    emit('changed');
    // The revert button removes itself (v-if="rcOwn" goes false), so move focus to
    // a control that survives rather than dropping it to <body>.
    await nextTick();
    document.getElementById('co-rc-type')?.focus();
  } catch (e) {
    rcErr.value = e instanceof Error ? e.message : 'Could not revert.';
  } finally {
    reverting.value = false;
  }
};
</script>

<template>
  <div class="wrap">
    <header class="head">
      <h1>Settings</h1>
      <p class="faint mono line">{{ state.company.name }} · {{ state.slug }}</p>
    </header>

    <section class="mind">
      <h2>Thinking</h2>
      <p class="muted intro">
        The model every seat runs on, and how hard it thinks, unless a seat has its
        own on the Staff page. Read at each wake, so a change reaches everyone's
        next shift and nothing restarts.
      </p>

      <div class="dial">
        <label class="k" for="co-model">Model</label>
        <select id="co-model" v-model="model" class="pick" aria-describedby="why-model">
          <option v-for="o in modelOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <span class="why faint" id="why-model">
          {{ modelNote || 'Default is Claude Code’s own default: the latest Opus the bundled CLI knows.' }}
        </span>
      </div>
      <div class="dial">
        <label class="k" for="co-effort">Effort</label>
        <select id="co-effort" v-model="effort" class="pick" :disabled="noEffort"
                aria-describedby="why-effort">
          <option v-for="e in EFFORTS" :key="e" :value="e"
                  :disabled="takes !== null && !takes.includes(e)">{{ e }}</option>
        </select>
        <span class="why faint" id="why-effort">
          {{ noEffort ? 'This model takes no effort setting; it is ignored.' : EFFORT_HINTS[effort] }}
        </span>
      </div>

      <p v-if="catalogStatus === 'failed'" class="faint note">
        The model list could not be loaded, so only the current setting is offered.
      </p>
      <p v-else-if="catalogFallback" class="faint note">
        The bundled CLI could not be asked for its models, so these are the common ones every account has.
      </p>
      <p v-if="mindErr" class="err" role="alert">{{ mindErr }}</p>
      <div class="row">
        <button class="go" :disabled="mindSaving || !mindDirty" :aria-busy="mindSaving"
                aria-label="Save thinking" @click="saveMind">
          {{ mindSaving ? 'Saving…' : 'Save' }}
        </button>
        <button class="ghost" :disabled="mindSaving || !mindDirty" @click="pressReset($event, resetMind, 'co-model')">Reset</button>
      </div>
      <p v-if="!mindErr && mindSaved" class="ok" role="status">Saved.</p>
    </section>

    <section class="dials">
      <h2>How hard it works</h2>
      <p class="muted intro">
        The scheduler reads these once when the company starts, so saving lets it
        go and builds it again. Anyone mid-shift finishes first, and it comes back
        working if it was.
      </p>

      <div v-for="g in DIAL_GROUPS" :key="g.title" class="group">
        <h3 class="group-title">{{ g.title }}</h3>
        <p class="group-caption faint">{{ g.caption }}</p>

        <div v-for="d in groupDials(g.keys)" :key="d.key" class="dial">
          <label class="k" :for="`dial-${d.key}`">{{ d.label }}</label>
          <input :id="`dial-${d.key}`" v-model.number="policy[d.key]" type="number"
                 :min="d.min" :max="d.max" :step="d.step" :aria-describedby="`why-${d.key}`" />
          <span class="why faint" :id="`why-${d.key}`">{{ d.hint }}</span>
        </div>

        <template v-if="g.extras">
          <div class="dial">
            <label class="k" for="dial-throttle">Slow down at</label>
            <span class="pct"><input id="dial-throttle" v-model.number="throttlePct" type="number"
                  min="0" max="100" aria-describedby="why-throttle" />%</span>
            <span class="why faint" id="why-throttle">
              Of the rate-limit window. Past this the gaps between shifts stretch, rather than the
              company coasting into the wall and losing the rest of the window to retries.
            </span>
          </div>
          <div class="dial">
            <label class="k" for="dial-pause">Stop at</label>
            <span class="pct"><input id="dial-pause" v-model.number="pausePct" type="number"
                  min="5" max="100" aria-describedby="why-pause" />%</span>
            <span class="why faint" id="why-pause">
              Your headroom. Slowing down still spends the window, only later — a company that
              never stops takes all of it, and you find it gone when you sit down to work.
              100 means never stop.
            </span>
          </div>
          <div class="dial">
            <label class="k" for="dial-cap">Daily spend cap</label>
            <span class="pct">$<input id="dial-cap" v-model.number="capUsd" type="number"
                  min="0" max="100000" step="1" aria-describedby="why-cap" /></span>
            <span class="why faint" id="why-cap">
              Rule 4. A per-treasurer, per-day ceiling on spend. 0 is no cap. On a subscription
              the figure is imputed list price, not money billed — set it as a daily work ceiling,
              or leave 0 and pace by the window instead.
            </span>
          </div>
        </template>
      </div>

      <p v-if="perr" class="err" role="alert">{{ perr }}</p>
      <div class="row">
        <button class="go" :disabled="saving || !dirty" :aria-busy="saving"
                aria-label="Save settings" @click="saveDials">
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
        <button class="ghost" :disabled="saving || !dirty" @click="pressReset($event, resetDials, 'dial-cap')">Reset</button>
      </div>
      <p v-if="!perr && justSavedDials" class="ok" role="status">Saved.</p>
    </section>

    <section class="rc">
      <h2>Runtime credential</h2>
      <p class="muted rc-note">
        Which credential this company's own Claude inference runs on. Leave it on
        the installation default, or override it here. The token value is
        write-only — set once, never shown again.
      </p>

      <p class="rc-status faint">
        <template v-if="rcOwn">
          Using its own credential<template v-if="state.runtimeCredential"> —
          <span class="mono">{{ rcLabel(state.runtimeCredential.type) }}</span></template><template
            v-if="!state.runtimeCredentialSet"> (type set, but no token value stored yet)</template>.
        </template>
        <template v-else>
          Inheriting the installation default.
        </template>
      </p>

      <label class="rc-l" for="co-rc-type">Credential type</label>
      <select id="co-rc-type" class="rc-fld type" v-model="rcType" @change="rcTypeTouched = true">
        <option value="subscription">Subscription token</option>
        <option value="apiKey">API key</option>
      </select>

      <label class="rc-l" for="co-rc-value">Token value</label>
      <input id="co-rc-value" class="rc-fld val" v-model="rcValue" type="password"
             placeholder="Paste the token — write-only, never shown again"
             spellcheck="false" autocapitalize="off" autocomplete="new-password"
             data-1p-ignore data-lpignore="true" @keydown.enter="saveRc" />
      <p class="hint faint">Pick the type, then paste its token — saved together. Use the installation default to clear an override.</p>

      <div class="row">
        <button class="go" :disabled="!rcCanSave" :aria-busy="rcSaving"
                aria-label="Save credential" @click="saveRc">
          {{ rcSaving ? 'Saving…' : 'Save' }}
        </button>
        <button v-if="rcOwn" class="ghost" :disabled="reverting" @click="useDefault">
          {{ reverting ? 'Reverting…' : 'Use installation default' }}
        </button>
      </div>

      <p v-if="rcErr" class="err" role="alert">{{ rcErr }}</p>
      <p v-else-if="rcJustSaved" class="ok" role="status">Saved.</p>
    </section>
  </div>
</template>

<style scoped>
.wrap { padding: 34px 44px 60px; max-width: 820px; }
h1 { font-size: 30px; }
h2 { font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.line { font-size: 12px; margin-top: 6px; }
.head { margin-bottom: 26px; }

.err { color: var(--alert); font-size: 13px; margin-top: 6px; }
.ok { color: var(--gold); font-size: 13px; margin-top: 6px; }
.row { display: flex; gap: 8px; margin-top: 16px; }

.dials, .mind { border: 1px solid var(--line); border-radius: 8px; background: var(--panel);
  padding: 16px 18px 18px; margin-bottom: 26px; }
.dials h2, .mind h2 { margin-bottom: 8px; }
.mind .dial { grid-template-columns: 190px minmax(0, 300px) 1fr; }
.pick { font: inherit; font-size: 13px; background: #15100d; color: var(--ink); min-width: 0;
  border: 1px solid var(--line-2); border-radius: 5px; padding: 5px 8px; max-width: 100%; }
.pick:focus { outline: none; border-color: var(--accent); }
.note { font-size: 11.5px; line-height: 1.5; margin-top: 6px; }
.intro { font-size: 12.5px; line-height: 1.6; margin-bottom: 6px; max-width: 62ch; }
.group-title { font-size: 11px; letter-spacing: .07em; text-transform: uppercase; color: var(--faint);
  margin: 0; padding-top: 13px; border-top: 1px solid var(--line); }
.group:first-of-type .group-title { border-top: 0; padding-top: 8px; }
.group-caption { font-size: 11.5px; line-height: 1.5; margin: 2px 0 6px; }
.dial { display: grid; grid-template-columns: 190px 96px 1fr; align-items: baseline;
  gap: 12px; padding: 6px 0; }
.dial .k { font-size: 13px; color: var(--ink); }
.dial .why { font-size: 11.5px; line-height: 1.5; }
.dial input { width: 74px; font: inherit; font-size: 13px; background: #15100d; color: var(--ink);
  border: 1px solid var(--line-2); border-radius: 5px; padding: 5px 8px; }
.dial .pct { white-space: nowrap; color: var(--faint); font-size: 12px; }
@media (max-width: 560px) {
  .dial, .mind .dial { grid-template-columns: 1fr; gap: 3px; padding: 8px 0; }
  .dial input { width: 100%; max-width: 160px; }
}

.rc { border: 1px solid var(--line); border-radius: 8px; background: var(--panel);
  padding: 16px 18px 18px; margin-bottom: 26px; }
.rc h2 { margin-bottom: 8px; }
.rc-note { font-size: 13px; line-height: 1.6; margin-bottom: 12px; max-width: 62ch; }
.rc-status { font-size: 12.5px; line-height: 1.5; margin-bottom: 16px; }
.rc-l { display: block; font-size: 12px; color: var(--muted); margin: 0 0 5px; }
.rc-fld { background: #15100d; color: var(--ink); border: 1px solid var(--line-2);
  border-radius: 5px; padding: 8px 10px; font: inherit; font-size: 13px; }
.rc-fld.type { display: block; margin-bottom: 16px; min-width: 220px; }
.rc-fld.val { display: block; width: 100%; max-width: 460px; margin-bottom: 8px;
  font-family: var(--mono, ui-monospace, monospace); }
.rc-fld:focus { outline: none; border-color: var(--accent); }
.hint { font-size: 11.5px; line-height: 1.5; margin: 0 0 12px; }
</style>
