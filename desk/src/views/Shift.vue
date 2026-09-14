<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { api, type Event, type State, type Turn, type SessionSummary } from '../api';
import { onEvents } from '../live';

const props = defineProps<{ state: State; events: Event[] }>();

// Board members are people, not staff — they run no shifts and record nothing.
const staff = computed(() => props.state.agents.filter((a) => a.tier !== 'board'));

const who = ref<string>('');
const session = ref<string | null>(null);
const sessions = ref<SessionSummary[]>([]);
const turns = ref<Turn[]>([]);
const more = ref(false);       // the server has rows past the cursor — still backfilling
const loading = ref(false);    // a fresh (clearing) load is in flight
const paging = ref(false);     // an append (drain step / live tail) is in flight
const error = ref('');

// A monotonic token so a slow response for a just-abandoned agent/session cannot
// overwrite the one now on screen — pick A then B and only B's data may land.
// An append reads it without bumping it, so a mid-flight switch discards the
// append instead of stapling one agent's turns onto another's.
let reqId = 0;
// The last seq on screen — the forward cursor for both paging and the live tail.
let cursor = 0;
// Cleared on unmount so a drain already in flight stops fetching into a detached
// component instead of looping (with backoff) until the server says done.
let alive = true;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Fresh load: clears the view and reads the first page of an agent+session.
const load = async (pickSession?: string) => {
  if (!who.value) return;
  const mine = ++reqId;
  loading.value = true;
  error.value = '';
  try {
    const t = await api.transcript(who.value, { session: pickSession });
    if (mine !== reqId) return;            // a newer load superseded this one
    sessions.value = t.sessions;
    session.value = t.sessionId;
    turns.value = t.turns;
    more.value = t.more;
    cursor = t.nextAfter;
    if (more.value) void drain(true);      // pull the rest without a button
  } catch (e) {
    if (mine !== reqId) return;
    // An audit surface must not answer a failed request with "nothing happened".
    error.value = e instanceof Error ? e.message : String(e);
    sessions.value = []; turns.value = []; session.value = null; more.value = false; cursor = 0;
  } finally {
    if (mine === reqId) loading.value = false;
  }
};

// One append past the cursor, without clearing the view or the picks. Reports
// `done` (the server says no rows remain) and `progressed` (rows actually
// landed) as separate facts, because a `false`/quiet return has three causes a
// caller must tell apart: genuinely finished, the paging guard is held by
// another in-flight step, or the fetch failed. Only strictly-newer turns land,
// so a drain step racing a live tick cannot double up a block.
type Step = { done: boolean; progressed: boolean };
const extend = async (): Promise<Step> => {
  if (!who.value || !session.value) return { done: true, progressed: false };
  if (paging.value) return { done: false, progressed: false };  // busy — not finished, retry
  const mine = reqId;                       // belongs to the current view; do not bump
  paging.value = true;
  try {
    const t = await api.transcript(who.value, { session: session.value, after: cursor });
    if (mine !== reqId) return { done: true, progressed: false };  // switched away — end this drain
    sessions.value = t.sessions;            // keep the picker (and "newest") fresh, cheaply
    const fresh = t.turns.filter((x) => x.seq > cursor);
    if (fresh.length) { turns.value = [...turns.value, ...fresh]; cursor = fresh[fresh.length - 1]!.seq; }
    more.value = t.more;
    return { done: !t.more, progressed: fresh.length > 0 };
  } catch { return { done: false, progressed: false }; }  // failed — not finished; drain backs off
  finally { paging.value = false; }
};

// Pull the rest of a shift straight through so the whole thing lands without a
// button, and keep a live shift caught up. Only a `done` from the server ends
// it; a step that made no progress (guard held, or a page failed) backs off and
// retries rather than stopping short with the record half-read — bounded, so a
// persistently failing server cannot spin. An agent/session switch (reqId moves)
// aborts. One loop per view: a second caller for the same view rides the first,
// but a new view always starts its own (the old loop's reqId no longer matches).
let drainReq = -1;
const drain = async (surfaceError = false): Promise<void> => {
  const mine = reqId;
  if (drainReq === mine) return;
  drainReq = mine;
  let stalls = 0;
  try {
    while (alive && reqId === mine) {
      const step = await extend();
      if (!alive || reqId !== mine) return;
      if (step.done) return;
      if (step.progressed) { stalls = 0; continue; }
      if (++stalls > 8) {
        // The backfill could not finish. Say so on an initial load; a quiet live
        // tick that misses is not an error and gets the next tick to retry.
        if (surfaceError && more.value) error.value = 'the rest of this shift could not be read — showing what loaded';
        return;
      }
      await sleep(200 * stalls);
    }
  } finally { if (drainReq === mine) drainReq = -1; }
};

const pickAgent = (id: string) => { who.value = id; void load(); };
const pickSession = (id: string) => { void load(id); };

onMounted(() => { const first = staff.value[0]; if (first) pickAgent(first.id); });
// A shift woke or ended — backfill the trailing turns (a long final burst can be
// more than one page) and refresh the picker, without snapping away from the
// session on screen.
onEvents(() => props.events, /^agent\.(woke|slept)$/, () => { void drain(false); });

// The selected session is this agent's most recent one, and the agent is awake
// right now — so we are watching a shift as it happens and should tail it.
const following = computed(() =>
  !!session.value && sessions.value[0]?.sessionId === session.value && props.state.awake.includes(who.value));

let timer: ReturnType<typeof setInterval> | undefined;
watch(following, (on) => {
  clearInterval(timer); timer = undefined;
  // The SSE tick already drains on wake/sleep; this catches the turns in between
  // while the shift is mid-flight, when no company event lands.
  if (on) timer = setInterval(() => { void drain(false); }, 3000);
});
onUnmounted(() => { alive = false; clearInterval(timer); });

// Content filters — a shift is mostly tool traffic, so let the operator collapse
// the reasoning and the tool I/O down to the narrative. Remembered per browser.
const readPref = (k: string, d: boolean): boolean => {
  try { const v = localStorage.getItem(k); return v === null ? d : v === '1'; } catch { return d; }
};
const showThinking = ref(readPref('riff.shift.thinking', true));
const showTools = ref(readPref('riff.shift.tools', true));
// Errors-only: the reason to open a recorded shift is often "what went wrong" —
// a denied tool call, a failed result — so let the operator strip everything else.
const errorsOnly = ref(readPref('riff.shift.errors', false));
watch([showThinking, showTools, errorsOnly], ([th, to, er]) => {
  try {
    localStorage.setItem('riff.shift.thinking', th ? '1' : '0');
    localStorage.setItem('riff.shift.tools', to ? '1' : '0');
    localStorage.setItem('riff.shift.errors', er ? '1' : '0');
  } catch { /* no storage — the filter still works for this session */ }
});

const nameOf = (id: string) => props.state.agents.find((a) => a.id === id)?.name ?? id;
const roleOf = (id: string) => props.state.agents.find((a) => a.id === id)?.role ?? '';
const short = (id: string | null) => (id ? id.slice(0, 8) : '');
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
const fmtWhen = (iso: string) => `${fmtDay(iso)}, ${fmtTime(iso)}`;
const durationMs = (a: string, b: string) => Math.max(0, new Date(b).getTime() - new Date(a).getTime());
// A shift is seconds-to-minutes of wall clock; show the largest two units so a
// three-second tool call and a forty-minute shift both read at a glance.
const fmtDur = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
};

// The picked session's own summary — the block count, and the span it covers.
// endedAt is MAX(at), so on a live tail it advances as new turns land.
const current = computed(() => sessions.value.find((s) => s.sessionId === session.value) ?? null);
const spanMs = computed(() => current.value ? durationMs(current.value.startedAt, current.value.endedAt) : 0);

// costUsd is imputed subscription list price nobody is billed — never shown.
// Turns are the real unit of a shift's effort.
const asObj = (m: unknown) => (m && typeof m === 'object' ? m as Record<string, unknown> : {});
// The model is stamped on every assistant/tool block; take the first one on
// record for the shift's header rather than repeat it on every line.
const modelOf = computed(() => {
  for (const t of turns.value) { const m = asObj(t.meta)['model']; if (m) return String(m); }
  return '';
});
const resultLine = (t: Turn) => {
  const m = asObj(t.meta);
  const parts: string[] = [];
  if (m['subtype']) parts.push(String(m['subtype']));
  if (m['turns'] != null) parts.push(`${m['turns']} turns`);
  return parts.join(' · ');
};
const isError = (t: Turn) => asObj(t.meta)['isError'] === true;
// What counts as an error worth surfacing: a tool result the engine flagged
// (a denied/failed call — the "Unknown company tool" refusals live here), or a
// shift that ended on anything other than success.
const isErrorTurn = (t: Turn) => isError(t)
  || (t.kind === 'result' && !!asObj(t.meta)['subtype'] && asObj(t.meta)['subtype'] !== 'success');
const errorCount = computed(() => turns.value.filter(isErrorTurn).length);
// The call ids behind an errored result, so the errors-only view can keep the
// tool_use that caused each error beside it — the error text alone is thin.
const erroredCallIds = computed(() => new Set(
  turns.value.filter((t) => t.kind === 'tool_result' && isError(t))
    .map((t) => t.name).filter((n): n is string => !!n)));
const prettyInput = (text: string) => {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
};

// Precompute the expensive per-block work (the tool-input JSON reparse) keyed on
// `turns` alone, so it does not re-run every time App.vue swaps in fresh `state`
// on its poll. A stable key per (session, seq) keeps each <details> disclosure
// attached to its own turn across a refetch instead of by list position. `gap` is
// the wall-clock since the previous block (the full sequence, not the filtered
// view) — how long that step took to produce.
const rows = computed(() => turns.value.map((t, i) => {
  const prev = turns.value[i - 1];
  return {
    t,
    key: `${t.sessionId}:${t.seq}`,
    display: t.kind === 'tool_use' ? prettyInput(t.text) : t.text,
    time: fmtTime(t.at),
    gapMs: prev ? durationMs(prev.at, t.at) : 0,
  };
}));
const shown = computed(() => {
  if (errorsOnly.value) {
    // Errors, and the tool call that produced each — nothing else.
    return rows.value.filter((r) => isErrorTurn(r.t)
      || (r.t.kind === 'tool_use' && erroredCallIds.value.has(String(asObj(r.t.meta)['id']))));
  }
  return rows.value.filter((r) => {
    if (r.t.kind === 'thinking') return showThinking.value;
    if (r.t.kind === 'tool_use' || r.t.kind === 'tool_result') return showTools.value;
    return true;
  });
});
</script>

<template>
  <div class="wrap">
    <header class="head">
      <div>
        <h1>Review a Shift</h1>
        <p class="muted lede">What a staff member actually did — recorded from the engine as they worked.</p>
      </div>
      <span v-if="following" class="livepill" aria-live="polite"><span class="dot" aria-hidden="true"></span>Live</span>
    </header>

    <div class="controls">
      <div class="pick">
        <label class="faint" for="shift-agent">Staff</label>
        <select id="shift-agent" :value="who"
                @change="pickAgent(($event.target as HTMLSelectElement).value)">
          <option v-for="a in staff" :key="a.id" :value="a.id">{{ a.name }} — {{ a.role }}</option>
        </select>
      </div>

      <div v-if="sessions.length > 1" class="pick">
        <label class="faint" for="shift-session">Shift</label>
        <select id="shift-session" :value="session ?? ''"
                @change="pickSession(($event.target as HTMLSelectElement).value)">
          <option v-for="s in sessions" :key="s.sessionId" :value="s.sessionId">
            {{ fmtWhen(s.startedAt) }} · {{ s.turns }} blocks · {{ fmtDur(durationMs(s.startedAt, s.endedAt)) }}
          </option>
        </select>
      </div>

      <div class="facet" role="group" aria-label="Show">
        <span class="faint lbl">Show</span>
        <button class="ghost sm" :class="{ on: showThinking }" :aria-pressed="showThinking"
                :disabled="errorsOnly" @click="showThinking = !showThinking">Thinking</button>
        <button class="ghost sm" :class="{ on: showTools }" :aria-pressed="showTools"
                :disabled="errorsOnly" @click="showTools = !showTools">Tools</button>
        <button class="ghost sm errbtn" :class="{ on: errorsOnly }" :aria-pressed="errorsOnly"
                @click="errorsOnly = !errorsOnly">
          Errors<span v-if="errorCount" class="cnt">{{ errorCount }}</span>
        </button>
      </div>
    </div>

    <section v-if="current && turns.length" class="summary" aria-label="Shift summary">
      <div class="who">
        <span class="nm">{{ nameOf(current.agentId) }}</span>
        <span class="faint">· {{ roleOf(current.agentId) }}</span>
      </div>
      <dl class="facts">
        <div><dt>Started</dt><dd>{{ fmtWhen(current.startedAt) }}</dd></div>
        <div>
          <dt>{{ following ? 'Last block' : 'Ended' }}</dt>
          <dd>{{ following ? fmtTime(current.endedAt) : fmtWhen(current.endedAt) }}</dd>
        </div>
        <div><dt>{{ following ? 'Elapsed' : 'Duration' }}</dt><dd>{{ fmtDur(spanMs) }}</dd></div>
        <div><dt>Blocks</dt><dd class="tnum">{{ current.turns }}</dd></div>
        <div v-if="errorCount"><dt>Errors</dt>
          <dd class="tnum errfact"><button class="linkbtn" @click="errorsOnly = true">{{ errorCount }}</button></dd>
        </div>
        <div v-if="modelOf"><dt>Model</dt><dd class="mono">{{ modelOf }}</dd></div>
        <div><dt>Session</dt><dd class="mono">{{ short(current.sessionId) }}</dd></div>
      </dl>
    </section>

    <!-- The only live region is this short status line; the log below is not one,
         so a drain backfill or a live tick does not read the whole transcript
         aloud block by block. -->
    <p class="feed-status" aria-live="polite" :class="{ err: !!error }">
      <template v-if="loading">Reading the record…</template>
      <template v-else-if="error">Could not read the record: {{ error }}</template>
      <template v-else-if="!turns.length">No recorded shifts for {{ nameOf(who) }} yet.</template>
      <template v-else-if="more">Reading the rest of the shift…</template>
    </p>

    <div class="results" :aria-busy="loading || more">
      <ol v-if="!loading && turns.length" class="log">
        <li v-for="r in shown" :key="r.key" class="turn" :class="r.t.kind">
          <div class="stamp mono">
            <span :title="fmtWhen(r.t.at)">{{ r.time }}</span>
            <span v-if="r.gapMs >= 1000" class="gap faint">+{{ fmtDur(r.gapMs) }}</span>
          </div>
          <div class="body">
            <template v-if="r.t.kind === 'text' && r.t.role === 'user'">
              <div class="role faint">woke · prompt</div>
              <div class="prompt">{{ r.display }}</div>
            </template>

            <template v-else-if="r.t.kind === 'text'">
              <div class="role">{{ nameOf(r.t.agentId) }}</div>
              <div class="say">{{ r.display }}</div>
            </template>

            <template v-else-if="r.t.kind === 'thinking'">
              <details class="think">
                <summary class="faint">thinking</summary>
                <div class="say faint">{{ r.display }}</div>
              </details>
            </template>

            <template v-else-if="r.t.kind === 'tool_use'">
              <details class="tool">
                <summary><span class="chip mono">{{ r.t.name }}</span></summary>
                <pre class="mono io">{{ r.display }}</pre>
              </details>
            </template>

            <template v-else-if="r.t.kind === 'tool_result'">
              <details class="tool" :class="{ err: isError(r.t) }" :open="errorsOnly && isError(r.t)">
                <summary><span class="chip mono result" :class="{ err: isError(r.t) }">{{ isError(r.t) ? 'error' : 'result' }}</span></summary>
                <pre class="mono io">{{ r.display }}</pre>
              </details>
            </template>

            <template v-else-if="r.t.kind === 'result'">
              <div class="tally faint mono" :class="{ err: isErrorTurn(r.t) }">— shift ended · {{ resultLine(r.t) }} —</div>
            </template>
          </div>
        </li>
      </ol>

      <p v-if="!loading && turns.length && errorsOnly && !shown.length" class="muted err-empty">
        No errors recorded in this shift. 🎯
      </p>
    </div>
  </div>
</template>

<style scoped>
.wrap { padding: 34px 44px; max-width: 1000px; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.livepill { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; margin-top: 6px;
  font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--accent);
  border: 1px solid var(--accent); border-radius: 999px; padding: 3px 10px; }
.livepill .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
@media (prefers-reduced-motion: reduce) { .livepill .dot { animation: none; } }
h1 { font-size: 30px; }
.lede { margin: 6px 0 0; font-size: 14px; }

.controls { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px 18px; margin-bottom: 18px; }
.pick { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.pick label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
.pick select { background: var(--panel); color: inherit; border: 1px solid var(--line);
  border-radius: 6px; padding: 6px 9px; font-size: 13px; max-width: 320px; }
.facet { display: flex; align-items: center; gap: 6px; }
.facet .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
.ghost.sm { font-size: 12px; padding: 4px 10px; }
.ghost.on { border-color: var(--accent); color: var(--accent); }
.ghost.sm:disabled { opacity: 0.4; cursor: not-allowed; }
.errbtn { display: inline-flex; align-items: center; gap: 6px; }
.errbtn.on { border-color: var(--alert); color: var(--alert); }
.errbtn .cnt { font-variant-numeric: tabular-nums; font-weight: 600; background: var(--alert);
  color: #fff; border-radius: 999px; min-width: 16px; height: 16px; padding: 0 5px;
  display: inline-flex; align-items: center; justify-content: center; font-size: 10.5px; }

.summary { background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  padding: 14px 18px; margin-bottom: 18px; }
.summary .who { font-size: 15px; margin-bottom: 10px; }
.summary .who .nm { font-weight: 600; }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px 20px; margin: 0; }
.facts div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.facts dt { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--faint); }
.facts dd { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
.tnum { font-variant-numeric: tabular-nums; }
.errfact .linkbtn { font: inherit; color: var(--alert); background: none; border: none; padding: 0;
  cursor: pointer; font-weight: 600; text-decoration: underline; text-underline-offset: 2px; }
.err-empty { text-align: center; padding: 24px 0; font-size: 14px; }

.feed-status { margin: 0 0 10px; font-size: 13px; color: var(--muted); min-height: 1em; }
.feed-status.err { color: var(--alert); }
.err { color: var(--alert); }
.log { list-style: none; display: flex; flex-direction: column; gap: 12px; }
/* A timeline: the clock in a fixed left gutter, the block on the right, so the
   eye runs straight down the times and every block lines up under them. */
.turn { display: grid; grid-template-columns: 66px minmax(0, 1fr); gap: 12px; align-items: start; }
.stamp { display: flex; flex-direction: column; align-items: flex-end; gap: 1px;
  font-size: 11px; color: var(--muted); padding-top: 2px; text-align: right; }
.stamp .gap { font-size: 10px; }
.body { min-width: 0; }
.role { font-size: 12px; color: var(--accent); margin-bottom: 3px; }
.prompt { background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--faint);
  border-radius: 6px; padding: 10px 14px; font-size: 13px; white-space: pre-wrap;
  color: var(--muted); max-height: 220px; overflow: auto; }
.say { font-family: var(--serif); font-size: 15px; line-height: 1.5; white-space: pre-wrap; }
.think summary, .tool summary { cursor: pointer; }
.chip { display: inline-block; font-size: 12px; padding: 2px 8px; border-radius: 5px;
  background: var(--panel); border: 1px solid var(--line); }
.chip.result { color: var(--gold); }
.chip.err { color: var(--alert); border-color: var(--alert); }
.io { background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
  padding: 10px 12px; margin-top: 6px; font-size: 12px; white-space: pre-wrap;
  max-height: 340px; overflow: auto; }
.tool.err .io { border-color: var(--alert); }
.tally { text-align: center; padding: 8px 0; font-size: 12px; }
.tally.err { color: var(--alert); }
</style>
