<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { api, type Event, type State, type Turn, type SessionSummary } from '../api';
import { onEvents } from '../live';

const props = defineProps<{ state: State; events: Event[] }>();

// Board members are people, not staff — they run no shifts and record nothing.
const staff = computed(() => props.state.agents.filter((a) => a.tier !== 'board'));

const who = ref<string>('');
const session = ref<string | null>(null);
const sessions = ref<SessionSummary[]>([]);
const turns = ref<Turn[]>([]);
const loading = ref(false);
const error = ref('');

// A monotonic token so a slow response for a just-abandoned agent/session cannot
// overwrite the one now on screen — click A then B and only B's data may land.
let reqId = 0;

const load = async (pickSession?: string) => {
  if (!who.value) return;
  const mine = ++reqId;
  loading.value = true;
  error.value = '';
  try {
    const t = await api.transcript(who.value, pickSession);
    if (mine !== reqId) return;            // a newer load superseded this one
    sessions.value = t.sessions;
    session.value = t.sessionId;
    turns.value = t.turns;
  } catch (e) {
    if (mine !== reqId) return;
    // An audit surface must not answer a failed request with "nothing happened".
    error.value = e instanceof Error ? e.message : String(e);
    sessions.value = []; turns.value = []; session.value = null;
  } finally {
    if (mine === reqId) loading.value = false;
  }
};

const pickAgent = (id: string) => { who.value = id; void load(); };
const pickSession = (id: string) => { void load(id); };

onMounted(() => { const first = staff.value[0]; if (first) pickAgent(first.id); });
// A shift ended — refresh, keeping the session the operator is looking at rather
// than snapping back to the latest.
onEvents(() => props.events, /^agent\.slept$/, () => { void load(session.value ?? undefined); });

const nameOf = (id: string) => props.state.agents.find((a) => a.id === id)?.name ?? id;
const short = (id: string | null) => (id ? id.slice(0, 8) : '');
const when = (iso: string) => new Date(iso).toLocaleString();

// costUsd is imputed subscription list price nobody is billed — never shown.
// Turns are the real unit of a shift's effort.
const asObj = (m: unknown) => (m && typeof m === 'object' ? m as Record<string, unknown> : {});
const resultLine = (t: Turn) => {
  const m = asObj(t.meta);
  const parts: string[] = [];
  if (m['subtype']) parts.push(String(m['subtype']));
  if (m['turns'] != null) parts.push(`${m['turns']} turns`);
  return parts.join(' · ');
};
const isError = (t: Turn) => asObj(t.meta)['isError'] === true;
const prettyInput = (text: string) => {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
};

// Precompute the expensive per-block work (the tool-input JSON reparse) keyed on
// `turns` alone, so it does not re-run every time App.vue swaps in fresh `state`
// on its poll. A stable key per (session, seq) keeps each <details> disclosure
// attached to its own turn across a refetch instead of by list position.
const rows = computed(() => turns.value.map((t) => ({
  t,
  key: `${t.sessionId}:${t.seq}`,
  display: t.kind === 'tool_use' ? prettyInput(t.text) : t.text,
})));
</script>

<template>
  <div class="wrap">
    <header class="head">
      <div>
        <h1>Review a Shift</h1>
        <p class="muted lede">What a staff member actually did — recorded from the engine as they worked.</p>
      </div>
    </header>

    <nav class="agents" aria-label="Staff">
      <button v-for="a in staff" :key="a.id" class="ghost" :class="{ on: a.id === who }"
              :aria-pressed="a.id === who" @click="pickAgent(a.id)">
        {{ a.name }} <span class="faint">· {{ a.role }}</span>
      </button>
    </nav>

    <div v-if="sessions.length > 1" class="sessions">
      <label class="faint" for="shift-session">Session</label>
      <select id="shift-session" :value="session ?? ''"
              @change="pickSession(($event.target as HTMLSelectElement).value)">
        <option v-for="s in sessions" :key="s.sessionId" :value="s.sessionId">
          {{ short(s.sessionId) }} — {{ s.turns }} blocks · {{ when(s.endedAt) }}
        </option>
      </select>
    </div>

    <div class="results" aria-live="polite" :aria-busy="loading">
      <div v-if="loading" class="muted">Reading the record…</div>
      <p v-else-if="error" class="err">Could not read the record: {{ error }}</p>
      <p v-else-if="!turns.length" class="muted">No recorded shifts for {{ nameOf(who) }} yet.</p>

      <ol v-else class="log">
        <li v-for="r in rows" :key="r.key" class="turn" :class="r.t.kind">
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
            <details class="tool" :class="{ err: isError(r.t) }">
              <summary><span class="chip mono result" :class="{ err: isError(r.t) }">{{ isError(r.t) ? 'error' : 'result' }}</span></summary>
              <pre class="mono io">{{ r.display }}</pre>
            </details>
          </template>

          <template v-else-if="r.t.kind === 'result'">
            <div class="tally faint mono">— shift ended · {{ resultLine(r.t) }} —</div>
          </template>
        </li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.wrap { padding: 34px 44px; max-width: 1000px; }
.head { margin-bottom: 18px; }
h1 { font-size: 30px; }
.lede { margin: 6px 0 0; font-size: 14px; }
.agents { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
.ghost.on { border-color: var(--accent); color: var(--accent); }
.sessions { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }
.sessions select { background: var(--panel); color: inherit; border: 1px solid var(--line);
  border-radius: 6px; padding: 5px 8px; font-size: 13px; }
.err { color: var(--alert); }
.log { list-style: none; display: flex; flex-direction: column; gap: 12px; }
.turn { display: block; }
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
</style>
