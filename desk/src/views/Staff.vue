<script setup lang="ts">
import { ref, computed } from 'vue';
import { api, type Agent, type Event, type State } from '../api';
import { render } from '../markdown';
import { onEvents } from '../live';

const props = defineProps<{ state: State; events: Event[] }>();
const emit = defineEmits<{ changed: [] }>();
const open = ref<string | null>(null);
const persona = ref('');
const loading = ref(false);
const draft = ref('');
const sending = ref(false);

/** Report lines, walked from the board down. Depth is for the indent. */
const tree = computed(() => {
  const out: Array<{ a: Agent; depth: number }> = [];
  const walk = (parent: string | null, depth: number) => {
    for (const a of props.state.agents.filter((x) => x.reportsTo === parent)) {
      out.push({ a, depth });
      walk(a.id, depth + 1);
    }
  };
  walk(null, 0);
  // Anyone orphaned by a rename still deserves a line rather than vanishing.
  for (const a of props.state.agents) if (!out.some((o) => o.a.id === a.id)) out.push({ a, depth: 0 });
  return out;
});

const select = async (a: Agent) => {
  open.value = open.value === a.id ? null : a.id;
  persona.value = '';
  redefining.value = null; // never carry an open editor across a seat switch
  if (!open.value) return;
  loading.value = true;
  try { persona.value = (await api.doc(`staff/${a.id}/persona.md`)).body; }
  catch { persona.value = a.mandate; }
  finally { loading.value = false; }
};

onEvents(() => props.events, /^(agent\.slept|remember)/, async () => {
  const id = open.value;
  // Not while an editor is open: moving persona.value under it would desync the
  // preview from the textarea. The redefine diff is frozen at open regardless.
  if (!id || redefining.value === id) return;
  const a = props.state.agents.find((x) => x.id === id);
  if (a) { try { persona.value = (await api.doc(`staff/${id}/persona.md`)).body; } catch { /* keep */ } }
});

// Renaming moves an id that is a foreign key in six tables and a folder name
// in the world, so it is one call to the server and never an edit here.
const renaming = ref<string | null>(null);
const newName = ref('');
const renameErr = ref('');

const openRename = (a: Agent) => {
  renaming.value = renaming.value === a.id ? null : a.id;
  newName.value = a.name;
  renameErr.value = '';
};

const renamed = ref('');

const doRename = async (a: Agent) => {
  const name = newName.value.trim();
  if (!name || name === a.name) { renaming.value = null; return; }
  renameErr.value = '';
  try {
    // The server decides the id, so it is reported back rather than guessed
    // here — the rule reducing a name to an id lives in one place.
    const r = await api.renameAgent(props.state.slug, a.id, name);
    renamed.value = `${r.from} → ${r.to}`;
    renaming.value = null;
    open.value = null;
    emit('changed');
  } catch (e) { renameErr.value = e instanceof Error ? e.message : String(e); }
};

// Retiring from here, rather than waiting for the CEO to propose it. A tool
// the staff hold is the wrong instrument when the seat in question is the one
// that would have to hold it. Two clicks and a stated reason, because a
// removal nobody wrote a reason for is one nobody can review later.
const retiring = ref<string | null>(null);
const why = ref('');
const retireErr = ref('');

const openRetire = (a: Agent) => {
  retiring.value = retiring.value === a.id ? null : a.id;
  why.value = '';
  retireErr.value = '';
};

const doRetire = async (a: Agent) => {
  const reason = why.value.trim();
  if (!reason) { retireErr.value = 'say why'; return; }
  retireErr.value = '';
  try {
    const r = await api.retireAgent(props.state.slug, a.id, reason);
    retiring.value = null;
    open.value = null;
    // Mid-shift they are not stopped, only never woken again — say so, because
    // the feed will show them finishing and that looks like the click failed.
    renamed.value = r.finishing
      ? `${r.name} has left; their shift is still finishing`
      : `${r.name} has left the company`;
    emit('changed');
  } catch (e) { retireErr.value = e instanceof Error ? e.message : String(e); }
};

// Redefining what an agent *is* — the role line and the persona brief the
// system prompt reads each shift, plus the mandate on record. Set once at
// founding with no way to change them since, so this is the seat's editor:
// change a few fields, say why, and it lands as a world commit the next shift
// reads. Only fields that actually changed are sent.
const redefining = ref<string | null>(null);
const rRole = ref('');
const rMandate = ref('');
const rPersona = ref('');
// The persona body as it was when the editor opened — the diff baseline. The
// live persona.value moves under the editor (a fetch resolving, or the agent's
// own shift rewriting its brief), so diffing an untouched field against it
// would send it as a change and overwrite the file — worst case the empty
// string captured before the fetch resolved. Frozen here, an untouched field
// never sends.
const rPersonaBase = ref('');
const rWhy = ref('');
const redefineErr = ref('');

const openRedefine = (a: Agent) => {
  redefining.value = redefining.value === a.id ? null : a.id;
  rRole.value = a.role;
  rMandate.value = a.mandate;
  rPersona.value = persona.value; // the body already loaded when the seat opened
  rPersonaBase.value = persona.value;
  rWhy.value = '';
  redefineErr.value = '';
};

const doRedefine = async (a: Agent) => {
  const why = rWhy.value.trim();
  if (!why) { redefineErr.value = 'say why'; return; }
  const changes: { role?: string; mandate?: string; persona?: string } = {};
  // Role and mandate are trimmed to match the server's own change check; persona
  // is not — its leading and trailing whitespace is meaningful body content.
  if (rRole.value.trim() !== a.role) changes.role = rRole.value.trim();
  if (rMandate.value.trim() !== a.mandate) changes.mandate = rMandate.value.trim();
  if (rPersona.value !== rPersonaBase.value) changes.persona = rPersona.value;
  if (Object.keys(changes).length === 0) { redefining.value = null; return; }
  redefineErr.value = '';
  try {
    const r = await api.redefineAgent(props.state.slug, a.id, why, changes);
    redefining.value = null;
    persona.value = rPersona.value;
    renamed.value = `redefined ${r.name}: ${r.changed.join(', ')}`;
    emit('changed');
  } catch (e) { redefineErr.value = e instanceof Error ? e.message : String(e); }
};

const send = async (a: Agent) => {
  if (!draft.value.trim()) return;
  sending.value = true;
  await api.say(a.id, draft.value.trim());
  draft.value = '';
  sending.value = false;
};
</script>

<template>
  <div class="wrap">
    <h1>Staff</h1>
    <p class="muted lede">
      Everyone here was hired by someone here. The only two seats not chosen from inside are the board and the CEO.
    </p>

    <div v-for="{ a, depth } in tree" :key="a.id" class="row" :style="{ marginLeft: depth * 24 + 'px' }">
      <button class="card" :class="{ on: open === a.id }" @click="select(a)">
        <span class="dot" :class="[a.status, { awake: state.awake.includes(a.id) }]" />
        <span class="name">{{ a.name }}</span>
        <span class="role">{{ a.role }}</span>
        <span class="faint tier mono">{{ a.tier }}</span>
        <span class="grow" />
        <span v-if="state.awake.includes(a.id)" class="now mono">working now</span>
        <span class="activity muted">{{ a.activity || '—' }}</span>
      </button>

      <div v-if="open === a.id" class="detail">
        <div class="meta faint mono">
          {{ a.department }} · hired {{ new Date(a.hiredAt).toLocaleDateString() }}
          <template v-if="a.hiredBy"> by {{ a.hiredBy }}</template>
        </div>
        <div class="persona body" v-html="render(persona || 'No persona on file.')" />
        <div class="say">
          <textarea v-model="draft" rows="2" placeholder="Leave word. They read it when they next wake." />
          <button class="go" :disabled="sending" @click="send(a)">Send</button>
        </div>
        <div class="renaming">
          <template v-if="renaming === a.id">
            <input v-model="newName" class="rn" aria-label="New name"
                   @keyup.enter="doRename(a)" @keyup.esc="renaming = null" />
            <button class="ghost" @click="doRename(a)">Save</button>
            <button class="ghost" @click="renaming = null">Cancel</button>
            <span class="faint hint">
              Their id changes with the name, and their folder, their notes and
              every line of the record move with it.
            </span>
          </template>
          <button v-else class="ghost" @click="openRename(a)">Rename…</button>
          <button v-if="a.tier !== 'board' && renaming !== a.id && retiring !== a.id" class="ghost"
                  :disabled="loading" @click="openRedefine(a)">
            {{ redefining === a.id ? 'Cancel' : 'Redefine…' }}
          </button>
          <button v-if="a.tier !== 'board' && renaming !== a.id && redefining !== a.id" class="ghost danger"
                  @click="openRetire(a)">
            {{ retiring === a.id ? 'Keep them' : 'Retire…' }}
          </button>
          <span v-if="renameErr" class="err">{{ renameErr }}</span>
          <span v-else-if="renamed" class="faint mono hint">{{ renamed }}</span>
        </div>
        <div v-if="redefining === a.id" class="redefining">
          <label class="fld">
            <span class="lbl faint mono">Role</span>
            <input v-model="rRole" class="rn grow" aria-label="Role"
                   placeholder="The role line — e.g. Founder and Principal Engineer"
                   @keyup.esc="redefining = null" />
          </label>
          <label class="fld">
            <span class="lbl faint mono">Mandate</span>
            <textarea v-model="rMandate" rows="2" aria-label="Mandate"
                      placeholder="Why this seat exists (on record; not in the shift prompt)" />
          </label>
          <label class="fld">
            <span class="lbl faint mono">Persona</span>
            <textarea v-model="rPersona" rows="10" aria-label="Persona brief"
                      placeholder="The brief the shift reads each time it wakes" />
          </label>
          <label class="fld">
            <span class="lbl faint mono">Why</span>
            <input v-model="rWhy" class="rn grow" aria-label="Why this change"
                   placeholder="Why — this goes in the record, and outlives the decision"
                   @keyup.enter="doRedefine(a)" @keyup.esc="redefining = null" />
          </label>
          <div class="acts">
            <button class="go" @click="doRedefine(a)">Save definition</button>
            <button class="ghost" @click="redefining = null">Cancel</button>
            <span class="faint hint">
              Role and persona are what the next shift reads; the change lands as
              a world commit. Takes effect when they next wake.
            </span>
          </div>
          <span v-if="redefineErr" class="err">{{ redefineErr }}</span>
        </div>
        <div v-if="retiring === a.id" class="retiring">
          <input v-model="why" class="rn grow" aria-label="Why they are leaving"
                 placeholder="Why — this goes in the record, and outlives the decision"
                 @keyup.enter="doRetire(a)" @keyup.esc="retiring = null" />
          <button class="go danger" @click="doRetire(a)">Retire {{ a.name }}</button>
          <span class="faint hint">
            The seat closes now. Work already written stays; a shift in flight
            finishes and they are not woken again.
          </span>
          <span v-if="retireErr" class="err">{{ retireErr }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap { padding: 34px 44px; max-width: 1000px; }
.renaming { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.rn { font: inherit; font-size: 14px; background: #15100d; color: var(--ink);
  border: 1px solid var(--line-2); border-radius: 5px; padding: 6px 9px; }
.renaming .hint { font-size: 11.5px; }
.renaming .err { color: var(--alert); font-size: 12px; }
.retiring { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.retiring .hint { font-size: 11.5px; flex-basis: 100%; }
.retiring .err { color: var(--alert); font-size: 12px; }
.retiring .grow { flex: 1; min-width: 260px; }
.redefining { display: flex; flex-direction: column; gap: 10px; margin-top: 10px;
  border-top: 1px solid var(--line); padding-top: 12px; }
.fld { display: flex; flex-direction: column; gap: 4px; }
.fld .lbl { font-size: 10px; letter-spacing: .1em; text-transform: uppercase; }
.redefining textarea { font: inherit; font-size: 13px; background: #15100d; color: var(--ink);
  border: 1px solid var(--line-2); border-radius: 5px; padding: 8px; resize: vertical; }
.redefining .rn { width: 100%; box-sizing: border-box; }
.acts { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.acts .hint { font-size: 11.5px; }
.redefining .err { color: var(--alert); font-size: 12px; }
.danger { color: var(--alert); }
.go.danger { border-color: color-mix(in srgb, var(--alert) 45%, transparent); }
h1 { font-size: 30px; }
.lede { margin: 6px 0 26px; font-size: 14px; max-width: 64ch; }
.row { margin-bottom: 6px; }
.card { width: 100%; display: flex; align-items: baseline; gap: 12px; text-align: left;
  background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 11px 15px; }
.card:hover { border-color: var(--line-2); }
.card.on { border-color: var(--accent); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); align-self: center; flex: none; }
.dot.working, .dot.active { background: var(--ok); }
.dot.departed { background: #5a463c; }
.dot.awake { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent); }
.now { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--ok); }
@media (prefers-reduced-motion: no-preference) {
  .dot.awake { animation: pulse 1.8s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .45; } }
}
.name { font-family: var(--serif); font-size: 17px; color: var(--ink); white-space: nowrap; }
.role { color: var(--accent); font-size: 13px; white-space: nowrap; }
.tier { white-space: nowrap; font-size: 10px; letter-spacing: .1em; text-transform: uppercase; }
.grow { flex: 1; }
.activity { font-size: 12px; font-style: italic; max-width: 40ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail { border: 1px solid var(--line); border-top: 0; border-radius: 0 0 6px 6px;
  background: #191411; padding: 16px 18px; margin: -6px 0 14px; }
.meta { font-size: 11px; margin-bottom: 12px; }
.persona { font-size: 14px; color: var(--ink-2); max-height: 380px; overflow-y: auto; }
.say { display: flex; gap: 8px; margin-top: 14px; }
.say textarea { flex: 1; font: inherit; font-size: 13px; background: #15100d; color: var(--ink);
  border: 1px solid var(--line-2); border-radius: 5px; padding: 8px; resize: vertical; }
</style>
