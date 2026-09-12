<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue';
import { api, type Event, type State } from '../api';

/**
 * A company's secrets, managed like GitHub's: you set a value and can never read
 * it back — the list shows names only, because the endpoint returns names only.
 * The real key lives in the key-injecting proxy's container, not the factory, so
 * there is nothing here that could hand a value back even if it wanted to. Every
 * call carries the company on screen, so a secret is always set for exactly it.
 *
 * `events` is the uniform prop every view gets from App.vue; secrets emit none
 * (a secret name must not surface in the feed), so it is declared and unused.
 */
defineProps<{ state: State; events: Event[] }>();

const names = ref<string[]>([]);
const loading = ref(true);
const err = ref('');

const name = ref('');
const value = ref('');
const saving = ref(false);
const justSaved = ref('');
const pendingDelete = ref<string | null>(null);

const nameInput = ref<HTMLInputElement | null>(null);
const valueInput = ref<HTMLInputElement | null>(null);
// A FUNCTION ref, not a string one: the Cancel button lives in a v-for, where a
// string ref resolves to an array (Vue's ref_for) whose `.focus()` is undefined
// and throws. Only one confirm is open at a time, so capture that one element.
let cancelBtn: HTMLButtonElement | null = null;
const setCancel = (el: unknown): void => { cancelBtn = el as HTMLButtonElement | null; };

const canSave = computed(() => !!name.value.trim() && !!value.value && !saving.value);
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const load = async (): Promise<void> => {
  try { names.value = (await api.secrets()).names; err.value = ''; }
  catch (e) { err.value = msg(e); }
  finally { loading.value = false; }
};

const save = async (): Promise<void> => {
  // Guards the Enter paths too, so a fast double-Enter cannot fire a second PUT
  // before the fields clear.
  if (!canSave.value) {
    if (!name.value.trim() || !value.value) err.value = 'A name and a value are both required.';
    return;
  }
  saving.value = true;
  try {
    await api.putSecret(name.value.trim(), value.value);
    justSaved.value = name.value.trim();
    name.value = ''; value.value = ''; err.value = '';
    await load();
    // The Save button is now disabled and would swallow focus; put it back where
    // the operator types next.
    await nextTick();
    nameInput.value?.focus();
  } catch (e) { err.value = msg(e); }
  finally { saving.value = false; }
};

// Replace re-uses the one form: fill the name, focus the value. The write is a
// PUT either way — set and replace are the same operation.
const replace = async (n: string): Promise<void> => {
  name.value = n; value.value = ''; err.value = '';
  await nextTick();
  valueInput.value?.focus();
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
    await api.deleteSecret(n); pendingDelete.value = null; await load();
    // The removed row is gone and focus would fall to <body>; put it back on the
    // form so a keyboard user keeps their place (matches the Services view).
    await nextTick();
    nameInput.value?.focus();
  } catch (e) { err.value = msg(e); }
};

onMounted(load);
</script>

<template>
  <div class="wrap">
    <header>
      <h1>Secrets</h1>
      <p class="who mono faint">{{ state.company.name }}</p>
      <p class="muted note">
        Set once, never shown again. A company's product reads these through the
        key-injecting proxy, so a running shift can use a key without ever holding
        it. Values are write-only here — to change one, set it again.
      </p>
    </header>

    <section class="set">
      <h2>Set a secret</h2>
      <div class="row">
        <input ref="nameInput" class="fld name" v-model="name" aria-label="Secret name"
               placeholder="Secret name" spellcheck="false" autocapitalize="off"
               autocomplete="off" @keydown.enter="save" />
        <input ref="valueInput" class="fld val" v-model="value" type="password"
               aria-label="Secret value" placeholder="Secret value" spellcheck="false"
               autocomplete="new-password" data-1p-ignore data-lpignore="true"
               @keydown.enter="save" />
        <button class="save" :disabled="!canSave" @click="save">
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
      </div>
      <p class="hint faint">
        Names are environment identifiers — letters, digits, underscore, e.g.
        <code>OPENROUTER_API_KEY</code>. The product reads this name; its adapter's
        <code>api_key_env</code>, and the Services route, must match it.
      </p>
      <p v-if="err" class="err">{{ err }}</p>
      <p v-else-if="justSaved" class="ok">Saved <span class="mono">{{ justSaved }}</span>.</p>
    </section>

    <section class="have">
      <h2>Set for this company</h2>
      <p v-if="loading" class="muted note">Loading…</p>
      <p v-else-if="!names.length" class="muted note">No secrets set for {{ state.company.name }} yet.</p>
      <ul v-else class="list">
        <li v-for="n in names" :key="n" class="item">
          <span class="key mono">{{ n }}</span>
          <span class="dots faint" aria-hidden="true">••••••••</span>
          <template v-if="pendingDelete === n">
            <span class="confirm faint">Remove?</span>
            <button class="mini danger" @click="remove(n)" @keydown.esc="pendingDelete = null">Yes</button>
            <button :ref="setCancel" class="mini" @click="pendingDelete = null" @keydown.esc="pendingDelete = null">Cancel</button>
          </template>
          <template v-else>
            <button class="mini" @click="replace(n)">Replace</button>
            <button class="mini" @click="askDelete(n)">Remove</button>
          </template>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.wrap { overflow-y: auto; padding: 34px 40px 60px; max-width: 760px; }
header { margin-bottom: 26px; }
h1 { font-size: 24px; }
.who { font-size: 12px; margin-top: 4px; text-transform: none; }
.note { font-size: 13px; line-height: 1.6; margin-top: 12px; max-width: 62ch; }
h2 { font-size: 12px; letter-spacing: .07em; text-transform: uppercase; color: var(--faint);
  margin: 0 0 12px; font-weight: 600; }
section { margin-top: 26px; padding-top: 22px; border-top: 1px solid var(--line); }
.row { display: flex; flex-wrap: wrap; gap: 8px; }
.fld { background: #15100d; color: var(--ink); border: 1px solid var(--line-2);
  border-radius: 5px; padding: 8px 10px; font: inherit; font-size: 13px; }
.fld.name { flex: 1 1 220px; font-family: var(--mono, ui-monospace, monospace); }
.fld.val { flex: 2 1 260px; }
.fld:focus { outline: none; border-color: var(--accent); }
.save { font: inherit; font-size: 13px; padding: 8px 16px; border-radius: 5px;
  border: 1px solid var(--line-2); background: var(--panel); color: var(--ink);
  cursor: pointer; white-space: nowrap; }
.save:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.save:disabled { opacity: .5; cursor: default; }
.hint { font-size: 11px; line-height: 1.5; margin-top: 8px; }
.hint code { font-family: var(--mono, ui-monospace, monospace); font-size: 11px; }
.err { color: var(--alert); font-size: 12px; margin-top: 10px; }
.ok { color: var(--gold); font-size: 12px; margin-top: 10px; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.item { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 5px; }
.item:hover { background: #1a1512; }
.key { font-size: 13px; color: var(--ink); }
.dots { flex: 1; font-size: 12px; letter-spacing: 2px; }
.confirm { font-size: 12px; }
.mini { font: inherit; font-size: 11px; padding: 3px 9px; border-radius: 4px;
  border: 1px solid transparent; background: none; color: var(--faint); cursor: pointer; }
.mini:hover { color: var(--ink); border-color: var(--line-2); }
.mini:focus-visible { outline: none; color: var(--ink); border-color: var(--accent); }
.mini.danger { color: var(--alert); }
.mini.danger:hover, .mini.danger:focus-visible { border-color: var(--alert); }
</style>
