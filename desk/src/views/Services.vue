<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue';
import { api, type Event, type State, type ServiceRoute } from '../api';

/**
 * A company's service routes: where the key-injecting proxy forwards a named
 * service, and which vault secret it injects on the way out. A route holds no
 * value — a secret NAME, an upstream host, a header — so unlike the Secrets
 * tab the whole thing reads back. The product calls
 * `http://keyproxy:8890/svc/<name>/…` with its `api_key_env` set to the secret
 * named here; the real key is added in the proxy's container and never enters
 * the factory. Every call carries the company on screen, so a route is always
 * set for exactly it.
 *
 * `events` is the uniform prop every view gets; routes emit none, so it is
 * declared and unused.
 */
defineProps<{ state: State; events: Event[] }>();

const routes = ref<Record<string, ServiceRoute>>({});
const secretNames = ref<string[]>([]);
/** Routes whose key was stored for somewhere else: refused until re-entered. */
const stale = ref<string[]>([]);
const warning = ref('');
const loading = ref(true);
const err = ref('');

const name = ref('');
const upstream = ref('');
const secret = ref('');
const header = ref('');
const schemeMode = ref<'bearer' | 'raw' | 'custom'>('bearer');
const customScheme = ref('');
// Static, non-secret headers as editable rows; empty-key rows are dropped on
// save. The credential is never here — it is the vault secret above. Each row
// carries a stable id so the v-for keys on identity, not index: without it,
// removing a row leaves the focused input rebound to a neighbour's data.
let hrSeq = 0;
const headerRows = ref<Array<{ id: number; k: string; v: string }>>([]);
const advanced = ref(false);
const saving = ref(false);
const justSaved = ref('');
const editing = ref('');
const pendingDelete = ref<string | null>(null);

const nameInput = ref<HTMLInputElement | null>(null);
const upstreamInput = ref<HTMLInputElement | null>(null);
// The static-headers group and its add button, so focus can follow a row being
// added or removed rather than falling to <body> — the focus discipline the rest
// of this view already keeps (askDelete/remove).
const hdrsEl = ref<HTMLElement | null>(null);
const addBtn = ref<HTMLButtonElement | null>(null);
// A function ref, not a string one: the Cancel button lives in a v-for, where a
// string ref resolves to an array whose `.focus()` is undefined and throws.
let cancelBtn: HTMLButtonElement | null = null;
const setCancel = (el: unknown): void => { cancelBtn = el as HTMLButtonElement | null; };

const sortedNames = computed(() => Object.keys(routes.value).sort());
const canSave = computed(() =>
  !!name.value.trim() && !!upstream.value.trim() && !!secret.value.trim() && !saving.value
  // A chosen "custom" prefix with no value would silently fall back to Bearer,
  // discarding the choice — require the value, or the operator picks "raw".
  && (schemeMode.value !== 'custom' || !!customScheme.value.trim()));
// A route can name a secret that has not been set yet — allowed, but it will 502
// at the proxy until the value exists, so say so rather than let it fail quietly.
const secretUnset = computed(() =>
  !!secret.value.trim() && !secretNames.value.includes(secret.value.trim()));
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const load = async (): Promise<void> => {
  try {
    const [svc, sec] = await Promise.all([api.services(), api.secrets()]);
    routes.value = svc.services;
    stale.value = svc.stale ?? [];
    secretNames.value = sec.names;
    err.value = '';
  } catch (e) { err.value = msg(e); }
  finally { loading.value = false; }
};

// Focus the name input of row `i` (clamped), or the add button when the list is
// empty, after the DOM settles.
const focusHeaderRow = async (i: number): Promise<void> => {
  await nextTick();
  const inputs = hdrsEl.value?.querySelectorAll<HTMLInputElement>('.srv.hk');
  if (!inputs || inputs.length === 0) { addBtn.value?.focus(); return; }
  inputs[Math.max(0, Math.min(i, inputs.length - 1))]?.focus();
};
const addHeaderRow = async (): Promise<void> => {
  headerRows.value.push({ id: hrSeq++, k: '', v: '' });
  await focusHeaderRow(headerRows.value.length - 1);
};
const removeHeaderRow = async (i: number): Promise<void> => {
  headerRows.value.splice(i, 1);
  // The row that slid into i (the next one), or the last, or the add button.
  await focusHeaderRow(i);
};
const staticHeaders = (r: ServiceRoute): Array<[string, string]> =>
  r.headers ? Object.entries(r.headers) : [];
// Keys are stored lower-cased by the server, so two rows differing only in case
// collapse to one on save (last wins). Warn rather than silently discard.
const dupHeader = computed(() => {
  const seen = new Set<string>();
  for (const hr of headerRows.value) {
    const k = hr.k.trim().toLowerCase();
    if (!k) continue;
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
});

const reset = (): void => {
  name.value = ''; upstream.value = ''; secret.value = '';
  header.value = ''; schemeMode.value = 'bearer'; customScheme.value = '';
  headerRows.value = []; advanced.value = false; editing.value = '';
};

const save = async (): Promise<void> => {
  if (!canSave.value) {
    if (!name.value.trim() || !upstream.value.trim() || !secret.value.trim())
      err.value = 'A name, an upstream URL and a secret are all required.';
    else if (schemeMode.value === 'custom' && !customScheme.value.trim())
      err.value = 'A custom scheme needs a value — or choose raw for no prefix.';
    return;
  }
  saving.value = true;
  try {
    const route: ServiceRoute = { upstream: upstream.value.trim(), secret: secret.value.trim() };
    if (header.value.trim()) route.header = header.value.trim();
    if (schemeMode.value === 'raw') route.scheme = '';
    else if (schemeMode.value === 'custom' && customScheme.value.trim()) route.scheme = customScheme.value.trim();
    // Build the static headers from the rows, dropping any with a blank name; the
    // server validates the names and refuses a credential/framing header.
    const built: Record<string, string> = {};
    for (const hr of headerRows.value) {
      const k = hr.k.trim();
      if (k) built[k] = hr.v;
    }
    if (Object.keys(built).length) route.headers = built;
    const r = await api.putService(name.value.trim(), route);
    justSaved.value = name.value.trim();
    warning.value = r.warning ?? '';
    err.value = '';
    reset();
    await load();
    await nextTick();
    nameInput.value?.focus();
  } catch (e) { err.value = msg(e); }
  finally { saving.value = false; }
};

// Edit re-uses the one form and the same PUT — set and edit are the same write.
const edit = async (n: string): Promise<void> => {
  const r = routes.value[n];
  if (!r) return;
  name.value = n; upstream.value = r.upstream; secret.value = r.secret;
  header.value = r.header ?? '';
  if (r.scheme === undefined) schemeMode.value = 'bearer';
  else if (r.scheme === '') schemeMode.value = 'raw';
  else { schemeMode.value = 'custom'; customScheme.value = r.scheme; }
  headerRows.value = r.headers ? Object.entries(r.headers).map(([k, v]) => ({ id: hrSeq++, k, v })) : [];
  advanced.value = !!r.header || r.scheme !== undefined || !!r.headers;
  editing.value = n; err.value = ''; justSaved.value = '';
  await nextTick();
  upstreamInput.value?.focus();
};

// Removing is destructive, so it confirms — and the confirm takes focus, with
// Escape to back out, so a keyboard user is never left with focus on nothing.
const askDelete = async (n: string): Promise<void> => {
  pendingDelete.value = n;
  await nextTick();
  cancelBtn?.focus();
};

const remove = async (n: string): Promise<void> => {
  try {
    await api.deleteService(n); pendingDelete.value = null; await load();
    // The removed row is gone and focus would fall to <body>; put it back on the
    // form so a keyboard user keeps their place.
    await nextTick();
    nameInput.value?.focus();
  } catch (e) { err.value = msg(e); }
};

// What the proxy will actually send, in words, so the route's effect is legible
// without reading the code: the default is `Authorization: Bearer <value>`.
const effect = (r: ServiceRoute): string => {
  const h = r.header || 'Authorization';
  const scheme = r.scheme === undefined ? 'Bearer ' : r.scheme ? `${r.scheme} ` : '';
  return `${h}: ${scheme}<${r.secret}>`;
};

onMounted(load);
</script>

<template>
  <div class="wrap">
    <header>
      <h1>Services</h1>
      <p class="who mono faint">{{ state.company.name }}</p>
      <p class="muted note">
        Where this company's product reaches an external API through the
        key-injecting proxy. A route maps a name to an upstream host and names the
        vault secret to inject — the real key is added in the proxy's container, so
        a running shift calls the API without ever holding the key. Point the
        product's adapter at <code>http://keyproxy:8890/svc/&lt;name&gt;</code> and
        set its <code>api_key_env</code> to the secret below.
      </p>
    </header>

    <section class="set">
      <h2>{{ editing ? `Edit ${editing}` : 'Add a route' }}</h2>
      <div class="row">
        <input ref="nameInput" class="srv name" v-model="name" aria-label="Service name"
               :readonly="!!editing" placeholder="Service name" spellcheck="false"
               autocapitalize="off" autocomplete="off" @keydown.enter="save" />
        <input ref="upstreamInput" class="srv up" v-model="upstream" aria-label="Upstream URL"
               placeholder="Upstream base URL" spellcheck="false"
               autocapitalize="off" autocomplete="off" @keydown.enter="save" />
      </div>
      <div class="row">
        <input class="srv secret" v-model="secret" aria-label="Vault secret name" list="secret-names"
               placeholder="Secret name (the identifier, not the value)" spellcheck="false"
               autocapitalize="off" autocomplete="off" @keydown.enter="save" />
        <datalist id="secret-names">
          <option v-for="s in secretNames" :key="s" :value="s" />
        </datalist>
        <button class="save" :disabled="!canSave" @click="save">
          {{ saving ? 'Saving…' : (editing ? 'Save' : 'Add') }}
        </button>
        <button v-if="editing" class="save ghost" @click="reset">Cancel</button>
      </div>
      <p class="hint faint">
        Example — name <code>openrouter</code>, upstream
        <code>https://openrouter.ai/api/v1</code>, secret <code>OPENROUTER_API_KEY</code>
        (the name you gave it in Secrets, never the <code>sk-…</code> value).
      </p>

      <p v-if="secretUnset" class="warn">
        No secret named <span class="mono">{{ secret.trim() }}</span> is set yet —
        add it in the Secrets tab, or calls to this route return 502 until you do.
      </p>

      <button class="adv" :aria-expanded="advanced" aria-controls="svc-advanced" @click="advanced = !advanced">
        {{ advanced ? '▾' : '▸' }} Header, scheme &amp; static headers
      </button>
      <div v-if="advanced" id="svc-advanced" class="advbody">
        <div class="row">
          <label class="lbl" for="svc-header">Header</label>
          <input id="svc-header" class="srv hdr" v-model="header"
                 placeholder="Authorization (default)" spellcheck="false" autocomplete="off" />
        </div>
        <div class="row">
          <label class="lbl" for="svc-scheme">Scheme</label>
          <select id="svc-scheme" class="srv sch" v-model="schemeMode">
            <option value="bearer">Bearer &lt;value&gt; (default)</option>
            <option value="raw">raw &lt;value&gt; (no prefix — e.g. X-Api-Key)</option>
            <option value="custom">custom prefix…</option>
          </select>
          <input v-if="schemeMode === 'custom'" class="srv sch-c" v-model="customScheme"
                 aria-label="Custom scheme prefix" placeholder="Token" spellcheck="false"
                 autocomplete="off" />
        </div>
        <div ref="hdrsEl" class="hdrs" role="group" aria-label="Static headers">
          <div class="hdrs-top">
            <span class="lbl">Static headers</span>
            <button ref="addBtn" type="button" class="mini" @click="addHeaderRow">+ Add header</button>
          </div>
          <p class="hint faint">
            Non-secret headers sent on every request — e.g. an OAuth/subscription
            upstream's <code>anthropic-beta</code> and <code>user-agent</code>. The
            credential is the secret above; a key naming it (or a connection header)
            is refused. Names are stored lower-cased.
          </p>
          <div v-for="(hr, i) in headerRows" :key="hr.id" class="row hdr-row">
            <input class="srv hk" v-model="hr.k" :aria-label="`Header name ${i + 1}`"
                   placeholder="header-name" spellcheck="false" autocapitalize="off" autocomplete="off" />
            <input class="srv hv" v-model="hr.v" :aria-label="`Header value ${i + 1}`"
                   placeholder="value" spellcheck="false" autocapitalize="off" autocomplete="off" />
            <button type="button" class="mini" @click="removeHeaderRow(i)" :aria-label="`Remove header ${i + 1}`">✕</button>
          </div>
          <p v-if="dupHeader" class="warn">Two headers share a name (case-insensitive) — only the last value is kept.</p>
        </div>
      </div>

      <p v-if="err" class="err">{{ err }}</p>
      <template v-else-if="justSaved">
        <p class="ok">Saved route <span class="mono">{{ justSaved }}</span>.</p>
        <p v-if="warning" class="warn">{{ warning }}</p>
      </template>
    </section>

    <section class="have">
      <h2>Routes for this company</h2>
      <p v-if="loading" class="muted note">Loading…</p>
      <p v-else-if="!sortedNames.length" class="muted note">No routes set for {{ state.company.name }} yet.</p>
      <ul v-else class="list">
        <li v-for="n in sortedNames" :key="n" class="route">
          <div class="rmain">
            <span class="rname mono">{{ n }}</span>
            <span class="rarrow faint">→</span>
            <span class="rup mono faint">{{ routes[n]!.upstream }}</span>
          </div>
          <div class="rmeta faint">
            <span class="mono">{{ effect(routes[n]!) }}</span>
            <span v-for="[hk, hv] in staticHeaders(routes[n]!)" :key="hk" class="hchip mono">{{ hk }}: {{ hv }}</span>
            <span v-if="!secretNames.includes(routes[n]!.secret)" class="badge">secret not set</span>
            <span v-else-if="stale.includes(n)" class="badge">key stored for elsewhere — replace it</span>
          </div>
          <div class="racts">
            <template v-if="pendingDelete === n">
              <span class="confirm faint">Remove?</span>
              <button class="mini danger" @click="remove(n)" @keydown.esc="pendingDelete = null">Yes</button>
              <button :ref="setCancel" class="mini" @click="pendingDelete = null" @keydown.esc="pendingDelete = null">Cancel</button>
            </template>
            <template v-else>
              <button class="mini" @click="edit(n)">Edit</button>
              <button class="mini" @click="askDelete(n)">Remove</button>
            </template>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.wrap { overflow-y: auto; padding: 34px 40px 60px; max-width: 820px; }
header { margin-bottom: 26px; }
h1 { font-size: 24px; }
.who { font-size: 12px; margin-top: 4px; text-transform: none; }
.note { font-size: 13px; line-height: 1.6; margin-top: 12px; max-width: 64ch; }
.note code, .rmeta code, .hint code { font-family: var(--mono, ui-monospace, monospace); font-size: 12px; }
.hint { font-size: 11px; line-height: 1.6; margin-top: 8px; }
.hint code { font-size: 11px; }
h2 { font-size: 12px; letter-spacing: .07em; text-transform: uppercase; color: var(--faint);
  margin: 0 0 12px; font-weight: 600; }
section { margin-top: 26px; padding-top: 22px; border-top: 1px solid var(--line); }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
.srv { background: #15100d; color: var(--ink); border: 1px solid var(--line-2);
  border-radius: 5px; padding: 8px 10px; font: inherit; font-size: 13px; }
.srv.name { flex: 1 1 180px; font-family: var(--mono, ui-monospace, monospace); }
.srv.up { flex: 2 1 320px; font-family: var(--mono, ui-monospace, monospace); }
.srv.secret { flex: 1 1 260px; font-family: var(--mono, ui-monospace, monospace); }
.srv.hdr { flex: 1 1 260px; }
.srv.sch { flex: 1 1 260px; }
.srv.sch-c { flex: 1 1 140px; }
.srv.hk { flex: 1 1 200px; font-family: var(--mono, ui-monospace, monospace); }
.srv.hv { flex: 2 1 240px; }
.srv[readonly] { opacity: .6; }
.srv:focus { outline: none; border-color: var(--accent); }
.lbl { font-size: 12px; color: var(--faint); flex: 0 0 64px; }
.save { font: inherit; font-size: 13px; padding: 8px 16px; border-radius: 5px;
  border: 1px solid var(--line-2); background: var(--panel); color: var(--ink);
  cursor: pointer; white-space: nowrap; }
.save:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.save:disabled { opacity: .5; cursor: default; }
.save.ghost { background: none; color: var(--faint); }
.adv { font: inherit; font-size: 12px; margin-top: 6px; padding: 4px 6px; border: none;
  background: none; color: var(--faint); cursor: pointer; }
.adv:hover { color: var(--ink); }
.advbody { margin-top: 8px; padding: 12px; border: 1px solid var(--line); border-radius: 6px; }
.advbody .row:last-child { margin-bottom: 0; }
.hdrs { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
.hdrs-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.hdrs .hint { margin-top: 6px; }
.hdr-row { margin-top: 8px; margin-bottom: 0; }
.hchip { font-size: 11px; border: 1px solid var(--line-2); border-radius: 4px; padding: 1px 6px;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.warn { color: var(--gold); font-size: 12px; margin-top: 8px; line-height: 1.5; }
.err { color: var(--alert); font-size: 12px; margin-top: 10px; }
.ok { color: var(--gold); font-size: 12px; margin-top: 10px; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.route { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 11px 10px;
  border-radius: 5px; }
.route:hover { background: #1a1512; }
.rmain { display: flex; align-items: baseline; gap: 8px; flex: 1 1 100%; min-width: 0; }
.rname { font-size: 13px; color: var(--ink); }
.rup { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rmeta { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-size: 12px; flex: 1 1 auto; }
.badge { font-size: 11px; color: var(--alert); border: 1px solid var(--alert);
  border-radius: 4px; padding: 1px 6px; }
.confirm { font-size: 12px; }
.racts { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.mini { font: inherit; font-size: 11px; padding: 3px 9px; border-radius: 4px;
  border: 1px solid transparent; background: none; color: var(--faint); cursor: pointer; }
.mini:hover { color: var(--ink); border-color: var(--line-2); }
.mini:focus-visible { outline: none; color: var(--ink); border-color: var(--accent); }
.mini.danger { color: var(--alert); }
.mini.danger:hover, .mini.danger:focus-visible { border-color: var(--alert); }
</style>
