<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { api, type Event, type State, type RuntimeCredentialType } from '../api';
import { render } from '../markdown';

const props = defineProps<{ state: State; events: Event[] }>();
const emit = defineEmits<{ changed: [] }>();

/**
 * The company's front page: who it is, what it was founded to do, and how
 * much of it exists.
 *
 * The brief lived in one place — a line under the company name in the rail —
 * back when it was three words. It is a paragraph now, and a paragraph does
 * not belong in a navigation rail. It belongs here, whole and legible, where
 * it can also be changed.
 */
const editing = ref(false);
const draft = ref('');
const busy = ref(false);
const err = ref('');

const business = computed(() => props.state.company.business.trim());
const ceo = computed(() => props.state.ceo.name);

const start = () => { draft.value = props.state.company.business; err.value = ''; editing.value = true; };

/**
 * The power button. Pause drains — nobody new is woken and whoever is working
 * finishes writing — which is right almost always and is why it is the footer
 * button. This is the other one: it kills the shifts in flight and loses
 * everything they have done since their last journal entry, and it exists
 * because an operator watching a run go wrong should not have to wait out a
 * ten-minute shift to stop it.
 *
 * It asks first. A misread icon that silently destroys a shift is the failure
 * this button would otherwise introduce.
 */
const killing = ref(false);
const halting = ref(false);
const live = computed(() => props.state.running || props.state.draining);
const shutdown = async () => {
  halting.value = true;
  try { await api.shutdown(); killing.value = false; emit('changed'); }
  finally { halting.value = false; }
};
const cancel = () => { editing.value = false; err.value = ''; };

// Switching companies while the editor is open would silently retarget the
// save at whichever company you just switched to.
watch(() => props.state.slug, cancel);

const save = async () => {
  busy.value = true;
  err.value = '';
  try {
    await api.renameCompany(props.state.slug, { business: draft.value });
    editing.value = false;
    emit('changed');
  } catch (e) {
    // Keeping the editor open keeps the text the founder just wrote.
    err.value = e instanceof Error ? e.message : 'Could not save the brief.';
  } finally {
    busy.value = false;
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
const tuning = ref(false);
const saving = ref(false);
const perr = ref('');

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

const resetDials = () => {
  policy.value = numericDials(props.state.policy);
  throttlePct.value = Math.round(props.state.policy.throttleAboveUtilization * 100);
  pausePct.value = Math.round(props.state.policy.pauseAboveUtilization * 100);
  capUsd.value = props.state.policy.dailyCapCents / 100;
  perr.value = '';
};
// The poll in App.vue replaces the whole state object every twenty seconds, so
// this fires on identity even when the policy came back byte-identical.
// Resetting from it wiped whatever had been typed the moment the operator
// paused between moving a dial and saving — and Save greyed out with it,
// because `dirty` compares against the value that had just been restored.
//
// Only an open panel is protected. Once it closes the dials are display again,
// and the reset is what shows the clamped figures the server actually kept
// rather than the ones that were typed at it.
watch(() => props.state.policy, () => {
  if (tuning.value && dirty.value) return;
  resetDials();
}, { deep: true });
watch(() => props.state.slug, () => { tuning.value = false; resetDials(); });

// A blank number field reads back as '' from v-model.number. Treat that as
// "unchanged", never 0 — clearing maxSessionHours or the shift timeout to blank
// must not silently switch a safety bound off; typing 0 still does, on purpose.
const numOr = (v: unknown, fallback: number): number =>
  v === '' || v == null ? fallback : Number(v);

const saveDials = async () => {
  saving.value = true;
  perr.value = '';
  try {
    await api.renameCompany(props.state.slug, {
      policy: {
        ...(Object.fromEntries(DIALS.map((d) =>
          [d.key, numOr(policy.value[d.key], props.state.policy[d.key])]))),
        throttleAboveUtilization: throttlePct.value / 100,
        pauseAboveUtilization: pausePct.value / 100,
        dailyCapCents: Math.round(numOr(capUsd.value, props.state.policy.dailyCapCents / 100) * 100),
      },
    });
    // Closing shows what was actually saved, clamped, rather than what was typed.
    tuning.value = false;
    emit('changed');
  } catch (e) {
    perr.value = e instanceof Error ? e.message : 'Could not save.';
  } finally {
    saving.value = false;
  }
};

const used = computed(() => {
  const u = props.state.rateLimit?.utilization;
  return u == null ? null : Math.round(u * 100);
});

/**
 * What the plan has left, by window.
 *
 * The five-hour one first: it is the window that decides whether the operator
 * can do their own work this afternoon, and it was invisible here until now —
 * the page showed one figure, taken from whichever window reported last, and
 * that was usually the seven-day.
 */
const NAMED: Array<[string, string]> = [
  ['five_hour', 'five-hour'],
  ['seven_day', 'seven-day'],
];
const plan = computed(() => NAMED.flatMap(([kind, label]) => {
  const w = props.state.windows?.find((x) => x.kind === kind);
  if (!w || w.utilization == null) return [];
  const mins = w.resetsAt == null ? null : Math.round((w.resetsAt * 1000 - Date.now()) / 60_000);
  const age = w.readAt ? Math.round((Date.now() - w.readAt) / 60_000) : null;
  return [{
    kind, label,
    pct: Math.round(w.utilization * 100),
    hot: w.utilization >= 0.75,
    back: mins == null || mins <= 0 ? '' : mins < 90 ? `back in ${mins}m` : `back in ${(mins / 60).toFixed(1)}h`,
    // A paused company keeps its last reading, and a five-hour window resets
    // under it. The age is what tells a live figure from one taken before the
    // window it describes came back.
    age: age == null ? '' : age < 1 ? 'just read' : age < 90 ? `read ${age}m ago` : `read ${(age / 60).toFixed(1)}h ago`,
    stale: mins != null && mins <= 0,
  }];
}));

const facts = computed(() => [
  { label: 'staff', value: String(props.state.headcount) },
  { label: 'commons', value: `${props.state.commons.held}/${props.state.commons.ceiling}` },
  { label: 'open work', value: String(props.state.tasks) },
  { label: 'notes', value: String(props.state.notes) },
  { label: 'waiting on you', value: String(props.state.pendingBoard) },
]);

const working = computed(() => props.state.awake.length);

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

const rcOwn = computed(() =>
  props.state.runtimeCredential !== null || props.state.runtimeCredentialSet);
const rcLoadedType = computed<RuntimeCredentialType | null>(() =>
  props.state.runtimeCredential?.type ?? null);
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
  if (!rcDirty.value) rcType.value = props.state.runtimeCredential?.type ?? 'subscription';
}, { deep: true });
// A fresh keystroke means the last "Saved." no longer describes the field.
watch(rcValue, (v) => { if (v) rcJustSaved.value = false; });
watch(() => props.state.slug, () => {
  rcType.value = props.state.runtimeCredential?.type ?? 'subscription';
  rcValue.value = ''; rcErr.value = ''; rcJustSaved.value = false;
});

const saveRc = async () => {
  if (!rcCanSave.value) return;
  rcSaving.value = true;
  rcJustSaved.value = false;
  try {
    // rcDirty guarantees a value; type and value are sent together.
    await api.putRuntimeCredential({ type: rcType.value, value: rcValue.value });
    rcValue.value = '';
    rcJustSaved.value = true;
    rcErr.value = '';
    emit('changed');
  } catch (e) {
    rcErr.value = e instanceof Error ? e.message : 'Could not save.';
  } finally {
    rcSaving.value = false;
  }
};

const useDefault = async () => {
  reverting.value = true;
  try {
    await api.deleteRuntimeCredential();
    rcValue.value = '';
    rcJustSaved.value = false;
    rcErr.value = '';
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
      <h1>{{ state.company.name }}</h1>
      <p class="faint mono line">
        {{ state.slug }} · {{ ceo }}, CEO ·
        {{ state.draining ? `finishing ${working}`
         : working ? `${working} working now` : (state.running ? 'idle' : 'paused') }}
      </p>
      <button v-if="live" class="power" :disabled="halting" :aria-label="`Shut down ${state.company.name}`"
              title="Shut down: kill the shifts in flight. Everything they have done since their last journal entry is lost. Pause drains instead."
              @click="killing = true">
        <svg viewBox="0 0 24 24" aria-hidden="true" width="18" height="18">
          <path d="M12 3v9" /><path d="M18.4 6.6a9 9 0 1 1-12.8 0" />
        </svg>
        Shutdown
      </button>
    </header>

    <div v-if="killing" class="confirm">
      <p>
        <strong>Shut {{ state.company.name }} down?</strong>
        <span v-if="working"> {{ working }} mid-shift now — everything since their
        last journal entry is lost.</span>
        <span v-else> Nobody is mid-shift, so this costs nothing that Pause would
        have saved.</span>
      </p>
      <div class="row">
        <button class="go danger" :disabled="halting" @click="shutdown">
          {{ halting ? 'Shutting down…' : 'Shut down' }}
        </button>
        <button class="ghost" :disabled="halting" @click="killing = false">Cancel</button>
      </div>
    </div>

    <section class="brief">
      <div class="bar">
        <h2>The brief</h2>
        <span class="grow" />
        <button v-if="!editing" class="ghost" @click="start">Edit</button>
      </div>

      <template v-if="!editing">
        <!-- Focusable region: the max-height clip below has no focusable child
             for a plain-prose brief, so without this a keyboard user cannot
             scroll past the fold to read the rest. -->
        <div v-if="business" class="body" tabindex="0" role="region"
             aria-label="The brief" v-html="render(business)" />
        <p v-else class="muted none">
          Nothing was written down when this company was founded, so its CEO
          decided what it was for on their own.
        </p>
      </template>

      <template v-else>
        <textarea v-model="draft" rows="10"
          placeholder="What this company is for, who it is for, and what it should not become." />
        <p class="muted warn">
          Saving sends {{ ceo }} the new brief as a message. It does not rewrite the
          constitution or {{ ceo }}'s founding papers — those were written at founding
          and are the company's to amend, not yours.
        </p>
        <p v-if="err" class="err">{{ err }}</p>
        <div class="row">
          <button class="go" :disabled="busy" @click="save">{{ busy ? 'Saving…' : 'Save' }}</button>
          <button class="ghost" :disabled="busy" @click="cancel">Cancel</button>
        </div>
      </template>
    </section>

    <section class="facts">
      <div v-for="f in facts" :key="f.label" class="fact">
        <span class="n mono">{{ f.value }}</span>
        <span class="l faint">{{ f.label }}</span>
      </div>
    </section>

    <section v-if="plan.length" class="plan">
      <h2>What the plan has left</h2>
      <div class="meters">
        <div v-for="w in plan" :key="w.kind" class="meter">
          <div class="mtop">
            <span class="l faint">{{ w.label }}</span>
            <span class="n mono" :class="{ hot: w.hot }">{{ w.pct }}%</span>
          </div>
          <div class="track"><div class="fill" :class="{ hot: w.hot, stale: w.stale }"
                                  :style="{ width: w.pct + '%' }" /></div>
          <span class="l faint">{{ w.stale ? 'window has since reset' : [w.back, w.age].filter(Boolean).join(' · ') }}</span>
        </div>
      </div>
      <p class="muted note">
        The subscription window, not money. This is what runs out, and running it
        out stops your own work as well as the company's. Read while the company
        works — a paused one keeps whatever it last saw, so the age is part of
        the figure. The record over time is in Vitals.
      </p>
    </section>

    <section class="dials">
      <div class="bar">
        <h2>How hard it works</h2>
        <span class="grow" />
        <button class="ghost" @click="tuning ? (tuning = false, resetDials()) : (tuning = true)">
          {{ tuning ? 'Done' : 'Tune' }}
        </button>
      </div>

      <p v-if="!tuning" class="muted summary">
        {{ state.policy.maxTurns }} turns a shift · {{ state.policy.concurrency }} working at once ·
        a shift about every {{ state.policy.baseIntervalMinutes }} min ·
        rests at {{ Math.round(state.policy.pauseAboveUtilization * 100) }}% of the window<template
          v-if="used !== null"> · <strong>{{ used }}% used now</strong></template>
      </p>

      <template v-else>
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

        <p class="muted note">
          Saving lets the company go and builds it again, because the scheduler reads these once.
          Anyone mid-shift finishes first, and it comes back working if it was.
        </p>
        <p v-if="perr" class="err">{{ perr }}</p>
        <div class="row">
          <button class="go" :disabled="saving || !dirty" @click="saveDials">
            {{ saving ? 'Saving…' : 'Save' }}
          </button>
          <button class="ghost" :disabled="saving" @click="resetDials">Reset</button>
        </div>
      </template>
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
      <select id="co-rc-type" class="rc-fld type" v-model="rcType">
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
        <button class="go" :disabled="!rcCanSave" @click="saveRc">
          {{ rcSaving ? 'Saving…' : 'Save' }}
        </button>
        <button v-if="rcOwn" class="ghost" :disabled="reverting" @click="useDefault">
          {{ reverting ? 'Reverting…' : 'Use installation default' }}
        </button>
      </div>

      <p v-if="rcErr" class="err" role="alert">{{ rcErr }}</p>
      <p v-else-if="rcJustSaved" class="ok" role="status">Saved.</p>
    </section>

    <section class="who">
      <h2>Who answers for it</h2>
      <p v-for="b in state.board" :key="b.id" class="seat">
        <span class="nm">{{ b.name }}</span> <span class="faint">{{ b.role }}</span>
      </p>
      <p class="seat"><span class="nm">{{ ceo }}</span> <span class="faint">CEO</span></p>
    </section>
  </div>
</template>

<style scoped>
.plan { margin-bottom: 22px; }
.plan h2 { font-size: 15px; margin-bottom: 12px; }
.meters { display: flex; gap: 20px; flex-wrap: wrap; }
.meter { flex: 1 1 200px; display: flex; flex-direction: column; gap: 5px; }
.mtop { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.meter .n { font-size: 22px; color: var(--ink); }
.meter .n.hot { color: var(--alert); }
.meter .l { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
.track { height: 5px; border-radius: 3px; background: var(--line); overflow: hidden; }
.fill { height: 100%; background: var(--accent); }
.fill.hot { background: var(--alert); }
.fill.stale { background: var(--line-2); }
.plan .note { font-size: 12px; margin-top: 12px; max-width: 58ch; }
.wrap { padding: 34px 44px 60px; max-width: 820px; }
h1 { font-size: 30px; }
h2 { font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.line { font-size: 12px; margin-top: 6px; }
.head { margin-bottom: 26px; display: grid; grid-template-columns: 1fr auto;
  align-items: center; column-gap: 16px; }
.head h1 { grid-column: 1; grid-row: 1; }
.head .line { grid-column: 1; grid-row: 2; }

/* Quiet until you reach for it, then it reads as the destructive one. */
.power { grid-column: 2; grid-row: 1 / span 2; display: inline-flex; align-items: center;
  gap: 7px; font-size: 12px; letter-spacing: .04em; padding: 7px 13px; border-radius: 999px;
  border: 1px solid var(--line); background: transparent; color: var(--muted); }
.power svg { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
.power:hover:not(:disabled) { color: var(--alert);
  border-color: color-mix(in srgb, var(--alert) 55%, transparent); }
.power:disabled { opacity: .55; }

.confirm { border: 1px solid color-mix(in srgb, var(--alert) 45%, transparent);
  border-radius: 8px; background: color-mix(in srgb, var(--alert) 8%, var(--panel));
  padding: 14px 16px; margin-bottom: 22px; display: flex; flex-direction: column; gap: 12px; }
.confirm p { font-size: 13px; max-width: 62ch; }
.confirm .row { display: flex; gap: 8px; }
.confirm .go.danger { background: #5a2a20; border-color: #7a3a2c; color: #f3ded8; }

.brief { border: 1px solid var(--line); border-radius: 8px; background: var(--panel);
  padding: 16px 18px 18px; margin-bottom: 22px; }
/* A long brief scrolls within the panel instead of pushing the overview down
   the page. A page-length brief is normal — Fathom's fifth was 3,755 chars. */
.body { max-height: 40vh; overflow-y: auto; padding-right: 6px; }
.bar { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.grow { flex: 1; }
.none { font-size: 14px; }
.warn { font-size: 12px; line-height: 1.55; margin-top: 8px; }
.err { color: var(--alert); font-size: 13px; margin-top: 6px; }
.row { display: flex; gap: 8px; margin-top: 12px; }
textarea { width: 100%; font: inherit; font-size: 14px; line-height: 1.55; background: #15100d;
  color: var(--ink); border: 1px solid var(--line-2); border-radius: 6px; padding: 10px 12px;
  resize: vertical; }
textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }

.facts { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 26px; }
.fact { display: flex; flex-direction: column; gap: 3px; border: 1px solid var(--line);
  border-radius: 6px; padding: 10px 14px; min-width: 96px; }
.fact .n { font-size: 19px; color: var(--ink); }
.fact .l { font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }

.dials { border: 1px solid var(--line); border-radius: 8px; background: var(--panel);
  padding: 16px 18px 18px; margin-bottom: 26px; }
.summary { font-size: 13px; line-height: 1.6; }
.summary strong { color: var(--gold); font-weight: normal; }
.note { font-size: 12px; line-height: 1.55; margin-top: 12px; }
.group-title { font-size: 11px; letter-spacing: .07em; text-transform: uppercase; color: var(--faint);
  margin: 0; padding-top: 13px; border-top: 1px solid var(--line); }
.group:first-of-type .group-title { border-top: 0; padding-top: 2px; }
.group-caption { font-size: 11.5px; line-height: 1.5; margin: 2px 0 6px; }
.dial { display: grid; grid-template-columns: 190px 96px 1fr; align-items: baseline;
  gap: 12px; padding: 6px 0; }
.dial .k { font-size: 13px; color: var(--ink); }
.dial .why { font-size: 11.5px; line-height: 1.5; }
.dial input { width: 74px; font: inherit; font-size: 13px; background: #15100d; color: var(--ink);
  border: 1px solid var(--line-2); border-radius: 5px; padding: 5px 8px; }
.dial .pct { white-space: nowrap; color: var(--faint); font-size: 12px; }
@media (max-width: 560px) {
  .dial { grid-template-columns: 1fr; gap: 3px; padding: 8px 0; }
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
.ok { color: var(--gold); font-size: 13px; margin-top: 6px; }

.seat { font-size: 14px; margin-top: 7px; }
.seat .nm { color: var(--ink); }
</style>
