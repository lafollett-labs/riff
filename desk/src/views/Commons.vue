<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue';
import { api, type CommonsDoc, type Event, type State } from '../api';
import { render } from '../markdown';
import { onEvents } from '../live';
import { namer } from '../names';
import Splitter, { rememberedWidth } from '../Splitter.vue';
import Toolbar, { type SortOption } from '../Toolbar.vue';

const props = defineProps<{ state: State; events: Event[] }>();
const who = computed(() => namer(props.state));
const listWidth = ref(rememberedWidth('riff.commonsWidth', 268));
const docs = ref<CommonsDoc[]>([]);
const open = ref<CommonsDoc | null>(null);
const body = ref('');
// The document's own path, so a relative image resolves from where it was written.
const html = computed(() => render(body.value, open.value?.path ?? ''));

const load = async () => { docs.value = (await api.commons()).documents; };

/**
 * The commons arrives in the order it was written. That is the order a
 * newcomer should read it in, so it is the default — but someone catching up
 * after a week away wants the other end, and someone hunting a half-remembered
 * title wants neither.
 */
type Order = 'written' | 'recent' | 'title';
const ORDERS: SortOption[] = [
  { key: 'written', label: 'Order written' },
  { key: 'recent', label: 'Recently changed' },
  { key: 'title', label: 'A–Z' },
];
const order = ref<Order>(
  (localStorage.getItem('riff.commonsOrder') as Order | null) ?? 'written');
watch(order, (o) => localStorage.setItem('riff.commonsOrder', o));

const stamp = (d: CommonsDoc) => d.updated ?? d.created ?? '';
const sorted = computed(() => {
  const list = [...docs.value];
  if (order.value === 'title') list.sort((a, b) => a.title.localeCompare(b.title));
  if (order.value === 'recent') list.sort((a, b) => stamp(b).localeCompare(stamp(a)));
  return list;  // 'written' is the order the server sends
});

/** Its place in the sequence, which does not change when you re-sort. */
const seq = computed(() => new Map(docs.value.map((d, i) => [d.path, i + 1])));

/**
 * A company can write its whole commons between breakfast and dinner, so
 * "today" on all thirty-three tells the reader nothing. Same day gets a
 * clock; anything older gets a date.
 */
const day = (iso: string | null) => {
  if (!iso) return 'before the log';
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const days = Math.floor((today.getTime() - d.getTime()) / 86_400_000);
  if (days < 2) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const read = async (d: CommonsDoc) => {
  open.value = d; body.value = '…';
  try { body.value = (await api.doc(d.path)).body; } catch (e) { body.value = String(e); }
};
onMounted(load);
onEvents(() => props.events, /^commons\./, async () => {
  await load();
  // Keep whatever is open readable; it may have just been rewritten.
  if (open.value) await read(open.value);
});

const pressure = computed(() => props.state.commons.held / props.state.commons.ceiling);
const shelf = (path: string) => path.replace(/^commons\//, '').split('/').slice(0, -1).join(' / ');

/**
 * Forty documents is the ceiling, and a company gets there. An index is for
 * scanning, though, not for turning pages — paging it would mean clicking
 * through to reach number thirty. Narrowing it is the useful move, and the
 * numbering means a filtered list still says where each one sits in the whole.
 */
const find = ref('');
const listed = computed(() => {
  const q = find.value.trim().toLowerCase();
  if (!q) return sorted.value;
  return sorted.value.filter((d) =>
    (d.title + ' ' + d.path + ' ' + who.value(d.author)).toLowerCase().includes(q));
});
</script>

<template>
  <div class="wrap" :style="{ '--list-w': listWidth + 'px' }">
    <aside class="list">
      <header>
        <h1>Commons</h1>
        <div class="gauge">
          <div class="bar"><div class="fill" :style="{ width: Math.min(100, pressure * 100) + '%',
            background: pressure > 0.85 ? 'var(--alert)' : 'var(--gold)' }" /></div>
          <span class="faint mono">{{ state.commons.held }}/{{ state.commons.ceiling }}</span>
        </div>
        <p class="muted note">
          A ceiling, not a quota. At the top, adding means removing something that stopped being true.
        </p>
      </header>
      <Toolbar v-model:filter="find" :sort="order" :sorts="ORDERS"
               label="Filter documents"
               @update:sort="order = $event as Order" />
      <button v-for="d in listed" :key="d.path" class="doc" :class="{ on: open?.path === d.path }" @click="read(d)">
        <span class="n faint mono">{{ seq.get(d.path) }}</span>
        <span class="lines">
          <span class="shelf faint mono">{{ shelf(d.path) }}</span>
          <span class="t">{{ d.title }}</span>
          <span class="stamp faint mono">
            {{ day(d.created) }}<template v-if="d.revisions > 1"> · revised {{ d.revisions - 1 }}×</template>
          </span>
        </span>
      </button>
      <p v-if="!docs.length" class="muted note">Nothing posted yet.</p>
      <p v-else-if="!listed.length" class="muted note">Nothing matches “{{ find }}”.</p>
    </aside>

    <Splitter v-model="listWidth" :min="200" :max="520"
              storage-key="riff.commonsWidth" label="Document list width" />

    <article class="reader">
      <template v-if="open">
        <h2 class="title">{{ open.title }}</h2>
        <div class="faint mono meta">
          #{{ seq.get(open.path) }} of {{ docs.length }} · {{ open.path }}
          <template v-if="open.author"> · {{ who(open.author) }}</template>
          <template v-if="open.created"> · written {{ new Date(open.created).toLocaleString() }}</template>
          <template v-if="open.revisions > 1"> · revised {{ open.revisions - 1 }}×</template>
        </div>
        <div class="body" v-html="html" />
      </template>
      <p v-else class="muted center">Pick a document.</p>
    </article>
  </div>
</template>

<style scoped>
/* A screenshot is evidence, so it gets room — but never more than the
   column it sits in, and it stays clickable to open full size. */
.body :deep(img) { max-width: 100%; height: auto; display: block;
  margin: 14px 0; border: 1px solid var(--line); border-radius: 4px;
  background: var(--ground-2, #100c0a); }
.wrap { display: grid; grid-template-columns: var(--list-w, 268px) 1fr;
  height: 100%; position: relative; }
/* Below this the reader gets squeezed to a word per line, which is worse than
   no reader at all. Stack the index above it and let the page scroll. */
/* Stacked below this, so the splitter has nothing to split. */
@media (max-width: 780px) {
  .wrap { grid-template-columns: 1fr; height: auto; }
  .wrap :deep(.splitter) { display: none; }
  .list { border-right: 0; border-bottom: 1px solid var(--line); padding-bottom: 14px; }
  .reader { padding: 24px 22px 50px; }
}
.list { padding: 30px 0 20px; overflow-y: auto; }
.list header { padding: 0 22px 16px; }
h1 { font-size: 24px; }
.gauge { display: flex; align-items: center; gap: 9px; margin-top: 10px; }
.bar { flex: 1; height: 5px; background: #2a221c; border-radius: 3px; overflow: hidden; }
.fill { display: block; height: 100%; }
.note { font-size: 12px; line-height: 1.6; margin-top: 10px; }
.find { display: block; width: calc(100% - 36px); margin: 0 18px 8px; background: #15100d;
  color: var(--ink); border: 1px solid var(--line-2); border-radius: 5px;
  padding: 6px 9px; font: inherit; font-size: 12px; }
.sorts { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 18px 10px; }
.sort { font: inherit; font-size: 10px; letter-spacing: .06em; text-transform: uppercase;
  color: var(--faint); background: none; border: 1px solid transparent; border-radius: 4px;
  padding: 3px 6px; cursor: pointer; white-space: nowrap; }
.sort:hover { color: var(--ink); }
.sort.on { color: var(--gold); border-color: var(--line-2); }
.doc { display: flex; gap: 10px; width: 100%; text-align: left; background: none; border: 0; border-radius: 0; padding: 8px 22px; }
.n { flex: none; width: 2.2ch; text-align: right; font-size: 11px; padding-top: 3px; }
.doc.on .n { color: var(--accent); }
.lines { display: flex; flex-direction: column; min-width: 0; }
.stamp { font-size: 10px; margin-top: 2px; }
.doc:hover { background: #1a1512; }
.doc.on { background: var(--panel); box-shadow: inset 2px 0 0 var(--accent); }
.doc.on .t { color: var(--accent); }
.shelf { display: block; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }
.t { display: block; font-family: var(--serif); font-size: 15px; color: var(--muted); line-height: 1.35; margin-top: 2px; }
.doc:hover .t { color: var(--ink); }
.reader { overflow-y: auto; padding: 34px 46px 60px; }
.reader .title { font-size: 26px; margin-bottom: 0; }
.meta { font-size: 11px; margin: 8px 0 22px; }
/* Only the measure and size are local. Everything else comes from the shared
   .body rules — this used to carry white-space: pre-wrap from before the
   markdown renderer existed, which preserved the newline BETWEEN every pair of
   rendered blocks as a real blank line. */
.body { font-size: 16px; max-width: 74ch; }
.center { margin-top: 60px; text-align: center; }
</style>
