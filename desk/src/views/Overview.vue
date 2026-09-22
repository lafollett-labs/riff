<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { api, type Event, type State } from '../api';
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

.seat { font-size: 14px; margin-top: 7px; }
.seat .nm { color: var(--ink); }
</style>
