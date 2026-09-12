<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from 'vue';
import { api, stream, setCompany, type State, type Event, type CompanyRef } from './api';
import Envelope from './views/Envelope.vue';
import Record from './views/Record.vue';
import Staff from './views/Staff.vue';
import Feed from './views/Feed.vue';
import Commons from './views/Commons.vue';
import Work from './views/Work.vue';
import Companies from './views/Companies.vue';
import Inbox from './views/Inbox.vue';
import Overview from './views/Overview.vue';
import Secrets from './views/Secrets.vue';
import Vitals from './views/Vitals.vue';
import Splitter, { rememberedWidth } from './Splitter.vue';

const VIEWS = [
  { id: 'overview', label: 'Overview', comp: Overview },
  { id: 'envelope', label: 'Envelope', comp: Envelope },
  { id: 'inbox',    label: 'Inbox',    comp: Inbox },
  { id: 'record',   label: 'Record',   comp: Record },
  { id: 'staff',    label: 'Staff',    comp: Staff },
  { id: 'work',     label: 'Work',     comp: Work },
  { id: 'commons',  label: 'Commons',  comp: Commons },
  { id: 'secrets',  label: 'Secrets',  comp: Secrets },
  { id: 'vitals',   label: 'Vitals',   comp: Vitals },
  { id: 'feed',     label: 'Feed',     comp: Feed },
] as const;

const view = ref<string>('envelope');
const state = ref<State | null>(null);
const events = ref<Event[]>([]);
const err = ref('');

const railWidth = ref(rememberedWidth('riff.railWidth', 208));
const companies = ref<CompanyRef[]>([]);
const active = ref('');
const picking = ref(false);

const current = computed(() => VIEWS.find((v) => v.id === view.value)?.comp ?? Envelope);

let stop: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

const refresh = async () => {
  if (!active.value) { state.value = null; return; }
  try { state.value = await api.state(); err.value = ''; }
  catch (e) { err.value = e instanceof Error ? e.message : String(e); }
};

/** Just the list. Kept separate so select() can refresh it without recursing. */
const fetchList = async () => { companies.value = (await api.companies()).companies; };

/**
 * The company you were last looking at, so the console reopens where you left
 * it. Without this a reload lands on whichever company happens to have the
 * freshest ledger file, which is not a choice anyone made.
 */
const REMEMBERED = 'riff.company';
const remembered = (): string => {
  try { return localStorage.getItem(REMEMBERED) ?? ''; } catch { return ''; }
};
const remember = (slug: string): void => {
  try { slug ? localStorage.setItem(REMEMBERED, slug) : localStorage.removeItem(REMEMBERED); }
  catch { /* private mode, or no storage — the picker just forgets */ }
};

const loadCompanies = async () => {
  const r = await api.companies();
  companies.value = r.companies;
  if (!companies.value.some((c) => c.slug === active.value)) {
    const known = (s: string) => companies.value.some((c) => c.slug === s);
    const last = remembered();
    select((known(last) && last) || r.active || companies.value[0]?.slug || '');
  }
};

/**
 * Switching company tears down the event stream and starts a new one. Leaving
 * the old one open would mix one company's events into another's feed.
 */
const select = (slug: string) => {
  if (slug === active.value) return;
  active.value = slug;
  setCompany(slug);
  remember(slug);
  events.value = [];
  state.value = null;
  stop?.(); stop = null;
  if (slug) {
    // Seed the feed with what already happened, then follow along live.
    void api.recent().then((r) => { events.value = r.events.slice().reverse(); }).catch(() => {});
    stop = stream(onBatch);
    void refresh();
    // Switching away unmounts the Companies view, so anything it still had to
    // tell us would be lost. Refresh the list here instead of relying on an
    // emit from a component that is about to disappear.
    void fetchList();
    if (view.value === 'companies') view.value = 'envelope';
  }
};

const boardIds = computed(() => new Set((state.value?.board ?? []).map((b) => b.id)));
const nameFor = (id: string) => state.value?.agents.find((a) => a.id === id)?.name ?? id;

const onBatch = (batch: Event[]) => {
  // Announce the things that are the operator's to act on, before the batch is
  // reversed into the feed.
  for (const e of batch) {
    if (e.kind === 'message.sent' && e.subject && boardIds.value.has(e.subject)) {
      let text = 'wrote to you';
      try { text = String(JSON.parse(e.dataJson ?? '{}').text ?? text).slice(0, 140); } catch { /* no body */ }
      notify('mail', nameFor(e.actor), text);
    } else if (e.kind.startsWith('gate.escalate')) {
      notify('board', nameFor(e.actor), 'needs a decision from the board');
    } else if (e.kind === 'agent.failed') {
      notify('note', nameFor(e.actor), 'a shift failed');
    }
  }
  events.value = [...batch.reverse(), ...events.value].slice(0, 300);
  // Any event at all. This drives the status bar, the rail counts and who is
  // awake — filtering to a few kinds meant the console sat visibly stale
  // through everything the filter had not anticipated.
  void refresh();
  void fetchList();
};

onMounted(async () => {
  await loadCompanies();
  timer = setInterval(refresh, 20_000);
});
onUnmounted(() => { stop?.(); if (timer) clearInterval(timer); });

const working = ref(false);
const toggle = async () => {
  if (!state.value || working.value) return;
  working.value = true;
  try {
    if (state.value.running) await api.pause(); else await api.start();
    await refresh();
  } finally { working.value = false; }
};

/** Names, not ids, for whoever is mid-shift this second. */
const awakeNames = computed(() => {
  const s = state.value;
  if (!s) return [];
  return s.awake.map((id) => s.agents.find((a) => a.id === id)?.name ?? id);
});

/** A company nobody has ever started looks identical to an idle one. */
const neverRun = computed(() => !!state.value && state.value.ticks === 0 && !state.value.running);

/**
 * Everything the person at this desk has to deal with, across every company.
 * The tab title carries it, because the whole problem was not knowing without
 * looking — and the console is usually not the window you are looking at.
 */
const needsYou = computed(() => (state.value?.pendingBoard ?? 0) + (state.value?.unread ?? 0));

watch(needsYou, (n) => {
  document.title = n > 0 ? `(${n}) The Desk` : 'The Desk';
}, { immediate: true });

/** Transient arrival notices. They fade; the badges are the durable record. */
type Toast = { id: number; kind: 'mail' | 'board' | 'note'; text: string; who: string };
const toasts = ref<Toast[]>([]);
let toastId = 0;

const notify = (kind: Toast['kind'], who: string, text: string) => {
  const t = { id: ++toastId, kind, who, text };
  toasts.value = [...toasts.value, t].slice(-4);
  setTimeout(() => { toasts.value = toasts.value.filter((x) => x.id !== t.id); }, 9000);
};

const dismiss = (id: number) => { toasts.value = toasts.value.filter((t) => t.id !== id); };

const openFor = (t: Toast) => {
  view.value = t.kind === 'board' ? 'envelope' : t.kind === 'mail' ? 'inbox' : 'feed';
  dismiss(t.id);
};

const util = computed(() => {
  const u = state.value?.rateLimit?.utilization;
  return u == null ? null : Math.round(u * 100);
});
</script>

<template>
  <div class="shell" :style="{ '--rail-w': railWidth + 'px' }">
    <nav class="rail">
      <div class="brand">
        <button class="switcher" @click="picking = !picking" :aria-expanded="picking">
          <span class="names">
            <span class="co">{{ state?.company.name ?? (companies.length ? 'Pick a company' : 'The Desk') }}</span>

          </span>
          <span class="chev" :class="{ up: picking }">▾</span>
        </button>
        <div v-if="picking" class="menu">
          <div class="menuhead faint mono">
            {{ companies.filter((c) => c.running).length }} of {{ companies.length }} working
          </div>
          <button v-for="c in companies" :key="c.slug" class="menuitem"
                  :class="{ on: c.slug === active }"
                  @click="select(c.slug); picking = false">
            <span class="led" :class="{ live: c.running, busy: c.awake.length }" />
            <span class="mname">{{ c.name }}</span>
            <span v-if="c.awake.length" class="faint mono count">{{ c.awake.length }}</span>
          </button>
          <div class="sep" />
          <button class="menuitem manage" @click="view = 'companies'; picking = false">
            Manage companies…
          </button>
        </div>
      </div>
      <button v-for="v in VIEWS" :key="v.id" class="navitem"
              :class="{ on: view === v.id }" @click="view = v.id">
        <span>{{ v.label }}</span>
        <span v-if="v.id === 'envelope' && state?.pendingBoard" class="pill">{{ state.pendingBoard }}</span>
      <span v-else-if="v.id === 'inbox' && state?.unread" class="pill">{{ state.unread }}</span>
        <span v-else-if="v.id === 'staff' && state" class="faint">{{ state.headcount }}</span>
      <span v-else-if="v.id === 'work' && state?.tasks" class="faint">{{ state.tasks }}</span>
        <span v-else-if="v.id === 'commons' && state" class="faint">
          {{ state.commons.held }}/{{ state.commons.ceiling }}
        </span>
      </button>
      <div class="grow" />
      <div class="who faint" v-if="state">
        <div v-for="b in state.board" :key="b.id">{{ b.name }} · {{ b.role }}</div>
      </div>
    </nav>

    <Splitter v-model="railWidth" :min="170" :max="420"
              storage-key="riff.railWidth" label="Sidebar width" />

    <main class="main">
      <Companies v-if="view === 'companies'" :list="companies" :active="active"
                 @switch="select" @changed="loadCompanies" />
      <div v-else-if="err" class="err">Can't reach the company — {{ err }}</div>
      <component v-else-if="state" :is="current" :state="state" :events="events" @changed="refresh" />
        <!-- A second machine's first act is usually importing, not founding.
             Offering only one of them made the other look unsupported. -->
        <div v-else-if="!companies.length" class="pad blank">
          <h1>Nothing here yet</h1>
          <p class="muted">
            Found a company and its CEO will hire the rest — or bring one over
            from another machine as a single file.
          </p>
          <div class="row">
            <button class="go" @click="view = 'companies'">Found a company</button>
            <button class="ghost" @click="view = 'companies'">Import one</button>
          </div>
        </div>
      <div v-else class="muted pad">Opening the books…</div>
    </main>

    <div class="toasts" role="status" aria-live="polite">
      <button v-for="t in toasts" :key="t.id" class="toast" :class="t.kind" @click="openFor(t)">
        <span class="tkind mono">{{ t.kind === 'mail' ? 'message' : t.kind === 'board' ? 'for the board' : 'attention' }}</span>
        <span class="twho">{{ t.who }}</span>
        <span class="ttext">{{ t.text }}</span>
      </button>
    </div>

    <footer class="status mono" v-if="state">
      <button class="run" :class="{ on: state.running }" :disabled="working" @click="toggle">
        <span class="led" />
        {{ state.running ? 'Pause' : (neverRun ? 'Start work' : 'Resume') }}
      </button>
      <span v-if="awakeNames.length" class="awake">
        {{ awakeNames.join(', ') }} {{ awakeNames.length > 1 ? 'are' : 'is' }} working
      </span>
      <span v-else-if="state.running" class="faint">waiting for the next shift</span>
      <span v-else-if="neverRun" class="faint">nobody has started yet</span>
      <span>{{ state.pendingBoard }} waiting on you</span>
      <span>{{ state.headcount }} staff</span>
      <span>commons {{ state.commons.held }}/{{ state.commons.ceiling }}</span>
      <span v-if="util !== null">{{ state.rateLimit?.rateLimitType ?? 'limit' }} {{ util }}%</span>
      <span class="grow" />
      <span class="faint">{{ state.seq }} events</span>
    </footer>
  </div>
</template>

<style scoped>
.shell { display: grid; grid-template-columns: var(--rail-w, 208px) 1fr;
  grid-template-rows: 1fr 34px; height: 100%; position: relative;
  /* The shell is the viewport and never scrolls; only .main does. Without
     this the document itself scrolled and carried the rail and the status
     bar up off the top of the window. */
  overflow: hidden; }
.rail {
  grid-row: 1 / span 2; background: var(--rail);
  padding: 22px 0 14px; display: flex; flex-direction: column; overflow: hidden;
}
.brand { padding: 0 12px 20px; position: relative; }
.switcher { display: flex; align-items: flex-start; gap: 8px; width: 100%;
  background: none; border: 1px solid transparent; border-radius: 5px;
  padding: 8px; text-align: left; color: inherit; }
.switcher:hover { border-color: var(--line); background: #1a1512; }
.switcher .names { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.co { font-family: var(--serif); font-size: 17px; color: var(--ink); line-height: 1.2; }

.chev { margin-left: auto; color: var(--faint); font-size: 11px; padding-top: 3px; }
.chev.up { transform: rotate(180deg); }
.menu { position: absolute; left: 12px; right: 12px; top: 100%; z-index: 10;
  background: var(--panel); border: 1px solid var(--line-2); border-radius: 6px;
  padding: 5px; box-shadow: 0 10px 30px rgba(0,0,0,.5); }
.menuitem { display: flex; align-items: center; gap: 9px; width: 100%; text-align: left;
  background: none; border: 0; border-radius: 4px; padding: 7px 10px;
  font-size: 14px; color: var(--muted); }
.mname { flex: 1; }
.count { font-size: 10px; }
.menuhead { padding: 4px 10px 7px; font-size: 10px; letter-spacing: .09em; text-transform: uppercase; }
.menu .led { width: 6px; height: 6px; border-radius: 50%; background: var(--line-2); flex: none; }
.menu .led.live { background: var(--gold); }
.menu .led.busy { background: var(--ok); }
.menuitem:hover { background: #241d18; color: var(--ink); }
.menuitem.on { color: var(--accent); }
.menuitem.manage { font-size: 13px; color: var(--faint); }
.sep { height: 1px; background: var(--line); margin: 5px 0; }
.navitem {
  background: none; border: 0; border-radius: 0; text-align: left;
  padding: 9px 20px; display: flex; align-items: center; gap: 8px;
  color: var(--muted); font-size: 14px; width: 100%;
}
.navitem:hover { background: #1a1512; color: var(--ink-2); }
.navitem.on { background: var(--panel); color: var(--ink); box-shadow: inset 2px 0 0 var(--accent); }
.navitem span:first-child { flex: 1; }
.pill { background: var(--alert); color: #fff; border-radius: 10px; padding: 1px 8px; font-size: 11px; font-weight: 600; }
.grow { flex: 1; }
.who { padding: 0 20px; font-size: 12px; line-height: 1.7; }
/* min-height:0 is what makes overflow-y actually bite. A grid row sized 1fr
   still has min-height:auto, so a long view — Vitals is the longest — grew
   the row past the viewport instead of scrolling inside it, and the whole
   shell slid up out of the window. */
.main { overflow-y: auto; min-height: 0; }
.blank { max-width: 46ch; }
.blank h1 { font-size: 26px; margin-bottom: 8px; }
.blank p { font-size: 14px; line-height: 1.6; margin-bottom: 18px; }
.blank .row { display: flex; gap: 10px; }
.toasts { position: fixed; right: 20px; bottom: 48px; z-index: 30;
  display: flex; flex-direction: column; gap: 8px; max-width: 360px; }
.toast { display: flex; flex-direction: column; gap: 3px; text-align: left;
  background: var(--panel); border: 1px solid var(--line-2);
  border-left: 3px solid var(--accent); border-radius: 6px;
  padding: 11px 14px; box-shadow: 0 8px 26px rgba(0,0,0,.45); }
.toast:hover { border-color: var(--accent); }
.toast.board { border-left-color: var(--gold); }
.toast.note { border-left-color: var(--alert); }
.tkind { font-size: 9px; letter-spacing: .12em; text-transform: uppercase; color: var(--faint); }
.twho { font-family: var(--serif); font-size: 15px; color: var(--ink); }
.ttext { font-size: 13px; color: var(--muted); line-height: 1.45;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
@media (prefers-reduced-motion: no-preference) {
  .toast { animation: slidein .28s cubic-bezier(.2,.9,.3,1) both; }
  @keyframes slidein { from { transform: translateX(18px); opacity: 0; } }
}
.pad { padding: 40px; }
.err { margin: 40px; padding: 16px; border: 1px solid #5c2f26; background: #241611; border-radius: 6px; }
.status {
  grid-column: 2; background: var(--rail); border-top: 1px solid var(--line);
  display: flex; align-items: center; gap: 18px; padding: 0 26px; font-size: 11px; color: var(--faint);
}
.run {
  display: flex; align-items: center; gap: 7px; font-family: var(--mono); font-size: 11px;
  background: none; border: 1px solid var(--line-2); border-radius: 3px;
  padding: 3px 10px; color: var(--muted);
}
.run:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.run.on { border-color: color-mix(in srgb, var(--ok) 50%, transparent); color: var(--ok); }
.led { width: 6px; height: 6px; border-radius: 50%; background: var(--faint); }
.run.on .led { background: var(--ok); }
.awake { color: var(--ok); }
@media (prefers-reduced-motion: no-preference) {
  .run.on .led { animation: pulse 1.8s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .35; } }
}
</style>
