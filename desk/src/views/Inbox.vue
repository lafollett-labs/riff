<script setup lang="ts">
import { ref, onMounted, computed, watch, nextTick } from 'vue';
import { api, type Inbox, type Message, type Event, type State } from '../api';
import { render } from '../markdown';
import { onEvents } from '../live';
import { namer } from '../names';
import Pager from '../Pager.vue';
import Toolbar, { type SortOption } from '../Toolbar.vue';
import MarkdownEditor from '../MarkdownEditor.vue';

const props = defineProps<{ state: State; events: Event[] }>();
const emit = defineEmits<{ changed: [] }>();

/** Page sizes worth offering. A message is a wall of prose, so the default is
 *  small; the larger ones exist for scanning rather than reading. */
const SIZES = [10, 15, 25, 50];
const perPage = ref(Number(localStorage.getItem('riff.inboxPerPage')) || 15);
watch(perPage, (n) => { try { localStorage.setItem('riff.inboxPerPage', String(n)); } catch { /* no storage */ } });

/** Whose mail: what reached you, or everything the company said. */
const scope = ref<'mine' | 'all'>(
  (localStorage.getItem('riff.inboxScope') as 'mine' | 'all' | null) ?? 'mine');
watch(scope, async (v) => { try { localStorage.setItem('riff.inboxScope', v); } catch { /* no storage */ } await load(); });

const box = ref<Inbox | null>(null);
const open = ref(new Set<string>());
const replyTo = ref<string | null>(null);
const draft = ref('');
const sending = ref(false);
const page = ref(0);
const filter = ref('');

const load = async () => { box.value = await api.inbox(scope.value); };
onMounted(load);
onEvents(() => props.events, /^message\.sent$/, load);

const nameOf = computed(() => namer(props.state));
const roleOf = (id: string) => props.state.agents.find((a) => a.id === id)?.role ?? '';

const all = computed(() => box.value?.messages ?? []);
/**
 * Unread is a fact about your own mail, and it stays true whichever view you
 * are in. Confining it to the narrow scope kept a colleague's mail to another
 * colleague from being painted orange — right — but it also hid YOUR unread
 * mail the moment you widened the view, which is worse. `yours` is the real
 * distinction, so it does the work in both scopes.
 */
const mine = computed(() => scope.value === 'mine');
const isNew = (m: Message) => m.yours && !m.readAt;
const unread = computed(() => all.value.filter(isNew));

const matching = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) return all.value;
  return all.value.filter((m) =>
    (nameOf.value(m.from) + ' ' + m.body).toLowerCase().includes(q));
});

/**
 * Orderings worth having on mail. "Unread first" is the one that earns its
 * place: a fortnight away leaves the things that need you buried under the
 * things that do not.
 */
const SORTS: SortOption[] = [
  { key: 'newest', label: 'Newest' },
  { key: 'oldest', label: 'Oldest' },
  { key: 'unread', label: 'Unread first' },
  { key: 'sender', label: 'Sender' },
];
const sort = ref<string>(localStorage.getItem('riff.inboxSort') ?? 'newest');
watch(sort, (v) => { try { localStorage.setItem('riff.inboxSort', v); } catch { /* no storage */ } });

const ordered = computed(() => {
  const list = [...matching.value];
  const newest = (a: Message, b: Message) => b.sentAt.localeCompare(a.sentAt) || b.id.localeCompare(a.id);
  if (sort.value === 'oldest') list.sort((a, b) => -newest(a, b));
  else if (sort.value === 'sender') {
    list.sort((a, b) => nameOf.value(a.from).localeCompare(nameOf.value(b.from)) || newest(a, b));
  } else if (sort.value === 'unread') {
    list.sort((a, b) => Number(!isNew(a)) - Number(!isNew(b)) || newest(a, b));
  } else list.sort(newest);
  return list;
});

const pages = computed(() => Math.max(1, Math.ceil(ordered.value.length / perPage.value)));
const shown = computed(() =>
  ordered.value.slice(page.value * perPage.value, page.value * perPage.value + perPage.value));

// New mail arriving must not slide the page out from under you, but a filter
// that shortens the list past where you are should.
watch(pages, (n) => { if (page.value >= n) page.value = n - 1; });
// Re-ordering resets the page for the same reason filtering does: page three
// of a list that has just been re-sorted shows you items you never asked for.
watch([filter, sort, perPage, scope], () => { page.value = 0; closeAll(); });

/**
 * The first line worth showing, for a message nobody has opened yet.
 *
 * Bodies here run to three or four thousand characters. Rendered in full and
 * all at once, twenty-six of them is ninety thousand characters of scroll —
 * so the list shows one line each and opens on request.
 */
const preview = (body: string): string => {
  for (const raw of body.split('\n')) {
    const line = raw.replace(/^#+\s*/, '').replace(/[*_`>]/g, '').trim();
    if (line) return line;
  }
  return '(empty)';
};

const isOpen = (m: Message) => open.value.has(m.id);

/** Expanding does not mark anything read — that stays an explicit act. */
const toggle = (m: Message) => {
  const next = new Set(open.value);
  if (next.has(m.id)) { next.delete(m.id); if (replyTo.value === m.id) replyTo.value = null; }
  else next.add(m.id);
  open.value = next;
};

const openAll = () => { open.value = new Set(shown.value.map((m) => m.id)); };
const closeAll = () => { open.value = new Set(); replyTo.value = null; };

const setRead = async (m: Message, read: boolean) => {
  await api.markRead([m.id], read);
  await load();
  emit('changed');
};

const readAll = async () => { await api.markRead(); await load(); emit('changed'); };

// ------------------------------------------------------------------ compose
/**
 * Starting a conversation, rather than answering one.
 *
 * Reply needs something to hang off, so the only way to reach somebody who
 * had not written first was to find their card on the Staff page. Nothing
 * could be addressed to two people at once, and nothing could be said to the
 * whole company at all — agents could broadcast and the founder could not.
 */
const composing = ref(false);
const audience = ref<string[]>([]);
const toEveryone = ref(false);
const note = ref('');
const posting = ref(false);
// True while the editor has an image upload in flight — the note then still
// holds an `![uploading…]` placeholder, which must not be sent.
const editorBusy = ref(false);

/** Everyone you could write to. Not yourself, and not anyone who has left. */
const roster = computed(() => props.state.agents
  .filter((a) => a.id !== box.value?.me && a.status !== 'departed'));

/**
 * The To line: type, and pick from what matches.
 *
 * This was a row of toggles, one per member of staff. A company that hires
 * well outgrows that — forty toggles is not a control, it is a wall you read
 * before you may write. Typing narrows; every choice becomes a tag you can
 * take back off.
 */
const EVERYONE = '*everyone';   // '*' is not legal in an agent id, so it cannot collide
type Option = { id: string; label: string; hint: string };

const query = ref('');
const menuOpen = ref(false);
const highlight = ref(0);
const toField = ref<HTMLInputElement | null>(null);

const matches = computed<Option[]>(() => {
  const q = query.value.trim().toLowerCase();
  const hit = (...fields: string[]) => !q || fields.some((f) => f.toLowerCase().includes(q));
  const company: Option[] = !toEveryone.value && hit('everyone', 'all')
    ? [{ id: EVERYONE, label: 'Everyone', hint: `one broadcast to all ${roster.value.length}` }]
    : [];
  const people = roster.value
    .filter((a) => !audience.value.includes(a.id))
    .filter((a) => hit(a.name, a.role, a.department, a.id))
    .map((a) => ({ id: a.id, label: a.name, hint: a.role }));
  return [...company, ...people];
});

// A long roster must not become a long menu. Eight is what fits without
// covering the message you came here to write.
const SHOWN = 8;
const options = computed(() => matches.value.slice(0, SHOWN));
const hidden = computed(() => Math.max(0, matches.value.length - SHOWN));
watch(options, (o) => { if (highlight.value >= o.length) highlight.value = 0; });

/** What is currently addressed, as removable tags. */
const tags = computed(() => (toEveryone.value
  ? [{ id: EVERYONE, label: 'Everyone' }]
  : audience.value.map((id) => ({ id, label: nameOf.value(id) }))));

// Addressing the company is its own thing, not the roster with every name
// ticked: a broadcast reads as "→ everyone" and names nobody.
const choose = (o: { id: string }) => {
  if (o.id === EVERYONE) { toEveryone.value = true; audience.value = []; }
  else {
    toEveryone.value = false;
    if (!audience.value.includes(o.id)) audience.value = [...audience.value, o.id];
  }
  query.value = '';
  highlight.value = 0;
  menuOpen.value = true;   // stay open: addressing several is the common case
};

const drop = (id: string) => {
  if (id === EVERYONE) toEveryone.value = false;
  else audience.value = audience.value.filter((x) => x !== id);
};

const onKey = (e: KeyboardEvent) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    menuOpen.value = true;
    const n = options.value.length;
    if (n) highlight.value = (highlight.value + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
    return;
  }
  if (e.key === 'Enter' || e.key === ',') {
    const o = menuOpen.value ? options.value[highlight.value] : undefined;
    if (o) { e.preventDefault(); choose(o); }
    return;
  }
  if (e.key === 'Escape') { menuOpen.value = false; return; }
  // Backspace on an empty field takes the last one back off, as every other
  // recipient field on earth does.
  if (e.key === 'Backspace' && !query.value) {
    const last = tags.value.at(-1);
    if (last) drop(last.id);
  }
};

watch(query, () => { menuOpen.value = true; highlight.value = 0; });
watch(composing, async (on) => {
  if (!on) return;
  await nextTick();
  toField.value?.focus();
});

const canPost = computed(() =>
  Boolean(note.value.trim()) && !editorBusy.value && (toEveryone.value || audience.value.length > 0));

const discard = () => {
  composing.value = false;
  note.value = '';
  audience.value = [];
  toEveryone.value = false;
  query.value = '';
  menuOpen.value = false;
  // The editor unmounts with the panel, so its final busy(false) may never
  // arrive; clear it here or the next compose opens with Send stuck disabled.
  editorBusy.value = false;
};

// Which board member is speaking. A board of two had one voice, because this
// view always sent as board[0] — so the second seat existed on the roster and
// nowhere the company could hear it. Only the board is offered: the console is
// authenticated as the operator, not as any agent, and speaking as a colleague
// would be putting words in their mouth.
const speaker = ref<string>(
  localStorage.getItem('riff.speaker') ?? '');
watch(speaker, (v) => {
  try { localStorage.setItem('riff.speaker', v); } catch { /* no storage */ }
});
const speakers = computed(() => props.state.board ?? []);
/** The chair unless someone else is chosen, and never a seat that has gone. */
const speakingAs = computed(() =>
  speakers.value.find((m) => m.id === speaker.value)?.id ?? speakers.value[0]?.id ?? '');

const post = async () => {
  if (!canPost.value || posting.value) return;
  posting.value = true;
  await api.say(toEveryone.value ? null : audience.value, note.value.trim(), speakingAs.value);
  posting.value = false;
  discard();
  await load();
  emit('changed');
};

/** Everyone a message was addressed to, worded for whoever is reading. */
const recipients = (m: Message) => [m.to, ...(m.alsoTo ?? [])].filter(Boolean);
const toLabel = (m: Message) =>
  recipients(m).map((id) => (id === box.value?.me ? 'you' : nameOf.value(id))).join(', ');
const toMe = (m: Message) => !m.broadcast && recipients(m).includes(box.value?.me ?? '');
const fromMe = (m: Message) => m.from === box.value?.me;

/**
 * Everyone a reply has to reach.
 *
 * Replying to mail between two colleagues used to go to the sender alone, and
 * each agent's inbox is only its own rows — so the other half of the
 * conversation could never learn the founder had weighed in. Answering a
 * broadcast stays a reply to the sender: the company does not need to hear it.
 */
const replyAudience = (m: Message): string[] => {
  const me = box.value?.me;
  const both = m.broadcast || m.to === me ? [m.from] : [m.from, m.to];
  // Reading your own sent mail back in the whole-company view still offers a
  // reply; without this it would be addressed to you.
  return both.filter((id) => id && id !== me);
};

const audienceLabel = (m: Message) =>
  replyAudience(m).map((id) => nameOf.value(id)).join(' and ');

const startReply = (m: Message) => {
  replyTo.value = replyTo.value === m.id ? null : m.id;
  draft.value = '';
  if (!isOpen(m)) toggle(m);
};

const send = async (m: Message) => {
  if (!draft.value.trim()) return;
  sending.value = true;
  await api.say(replyAudience(m), draft.value.trim(), speakingAs.value);
  draft.value = '';
  replyTo.value = null;
  sending.value = false;
  emit('changed');
};

const when = (iso: string) => {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return d.toLocaleDateString();
};
</script>

<template>
  <div class="wrap">
    <header class="head">
      <div>
        <h1>Inbox</h1>
        <p class="muted lede">
          What the staff have written to you, and what you have written to
          them. Unread ones are marked <span class="new inline">New</span>, and
          you can put one back to unread to keep it in front of you.
        </p>
      </div>
      <button class="go compose-open" @click="composing ? discard() : (composing = true)">
        {{ composing ? 'Cancel' : 'Compose' }}
      </button>
    </header>

    <section v-if="composing" class="compose">
      <div class="to" @click="toField?.focus()">
        <span class="faint mono lbl">to</span>
        <span v-for="t in tags" :key="t.id" class="tag" :class="{ all: t.id === EVERYONE }">
          {{ t.label }}
          <button class="x" :aria-label="`Remove ${t.label}`" @click.stop="drop(t.id)">×</button>
        </span>
        <span class="field">
          <input ref="toField" v-model="query" type="text" class="typeahead"
                 role="combobox" aria-autocomplete="list" aria-controls="to-options"
                 :aria-expanded="menuOpen"
                 :aria-activedescendant="menuOpen && options.length ? `to-opt-${highlight}` : undefined"
                 :placeholder="tags.length ? '' : 'Type a name, or Everyone'"
                 aria-label="Recipients"
                 @focus="menuOpen = true" @blur="menuOpen = false" @keydown="onKey" />
          <ul v-if="menuOpen && options.length" id="to-options" class="options" role="listbox">
            <li v-for="(o, i) in options" :id="`to-opt-${i}`" :key="o.id" role="option"
                class="opt" :class="{ on: i === highlight, all: o.id === EVERYONE }"
                :aria-selected="i === highlight"
                @mousedown.prevent="choose(o)" @mouseenter="highlight = i">
              <span class="opt-name">{{ o.label }}</span>
              <span class="opt-hint faint">{{ o.hint }}</span>
            </li>
            <li v-if="hidden" class="opt more faint" aria-hidden="true">
              +{{ hidden }} more — keep typing
            </li>
          </ul>
        </span>
      </div>
      <MarkdownEditor v-model="note" @busy="editorBusy = $event"
        placeholder="Markdown is fine. They read it when they next wake — you do not wait here for an answer." />
      <div class="actions">
        <button class="go" :disabled="!canPost || posting" @click="post">
          {{ posting ? 'Sending…' : 'Send' }}
        </button>
        <button class="ghost" @click="discard">Discard</button>
        <label v-if="speakers.length > 1" class="as faint mono">
          as
          <select v-model="speaker" aria-label="Who is speaking">
            <option v-for="m in speakers" :key="m.id" :value="m.id">{{ m.name }}</option>
          </select>
        </label>
        <span class="faint mono hint">
          <template v-if="toEveryone">One broadcast to all {{ roster.length }}.</template>
          <template v-else-if="audience.length">
            {{ audience.length }} {{ audience.length === 1 ? 'person' : 'people' }}, by name.
          </template>
          <template v-else>Pick who hears it.</template>
        </span>
      </div>
    </section>

    <Toolbar v-if="box" v-model:filter="filter" v-model:sort="sort"
             v-model:per-page="perPage" :sizes="SIZES"
             :sorts="SORTS" label="Filter messages"
             :count="`${matching.length} message${matching.length === 1 ? '' : 's'}`
                     + (unread.length ? `, ${unread.length} unread${mine ? '' : ' to you'}` : '')">
      <button class="ghost scope" :class="{ on: scope === 'mine' }"
              @click="scope = 'mine'">To you</button>
      <button class="ghost scope" :class="{ on: scope === 'all' }"
              title="Every message anyone here sent, not only what reached you."
              @click="scope = 'all'">Everyone's</button>
      <button class="ghost" @click="openAll">Expand page</button>
      <button class="ghost" @click="closeAll">Collapse all</button>
      <button v-if="unread.length" class="ghost" @click="readAll">Mark all read</button>
    </Toolbar>

    <p v-if="box && !all.length" class="muted empty">
      <template v-if="mine">
        Nothing addressed to you, and nothing sent by you.
        <b>Everyone's</b> shows the whole company's mail.
      </template>
      <template v-else>Nothing yet. Nobody here has written to anyone.</template>
    </p>
    <p v-else-if="box && !matching.length" class="muted empty">
      No message matches “{{ filter }}”.
    </p>

    <article v-for="m in shown" :key="m.id" class="msg"
             :class="{ unread: isNew(m), open: isOpen(m) }">
      <button class="row" :aria-expanded="isOpen(m)" @click="toggle(m)">
        <span class="chev" :class="{ down: isOpen(m) }">▸</span>
        <span class="who">{{ nameOf(m.from) }}</span>
        <span class="role faint">{{ roleOf(m.from) }}</span>
        <span v-if="m.broadcast" class="addressed all"
              title="Sent to the whole company.">→ everyone</span>
        <span v-else-if="toMe(m)" class="addressed you"
              title="Written to you specifically.">→ {{ toLabel(m) }}</span>
        <span v-else-if="fromMe(m)" class="addressed sent"
              title="You wrote this.">→ {{ toLabel(m) }}</span>
        <span v-else class="addressed other"
              title="Between colleagues. You are reading over their shoulder.">
          → {{ toLabel(m) }}
        </span>
        <span v-if="!isOpen(m)" class="preview muted">{{ preview(m.body) }}</span>
        <span class="grow" />
        <span v-if="isNew(m)" class="new">New</span>
        <span class="when faint mono">{{ when(m.sentAt) }}</span>
      </button>

      <template v-if="isOpen(m)">
        <p class="envelope faint mono">
          {{ nameOf(m.from) }}<template v-if="roleOf(m.from)"> ({{ roleOf(m.from) }})</template>
          →
          <template v-if="m.broadcast">everyone at {{ state.company.name }}</template>
          <template v-else>{{ toLabel(m) }}</template>
          · {{ new Date(m.sentAt).toLocaleString() }}
        </p>
        <div class="body" v-html="render(m.body)" />
        <div v-if="replyTo === m.id" class="reply">
          <textarea v-model="draft" rows="3"
            :placeholder="`Reply to ${audienceLabel(m)} — they read it on their next waking.`" />
          <div class="actions">
            <button class="go" :disabled="sending || !draft.trim()" @click="send(m)">Send</button>
            <button class="ghost" @click="replyTo = null">Cancel</button>
          </div>
        </div>
        <div v-else class="actions">
          <button class="ghost" @click="startReply(m)">Reply</button>
          <button v-if="m.yours" class="ghost" @click="setRead(m, !m.readAt)">
            {{ m.readAt ? 'Mark unread' : 'Mark read' }}
          </button>
        </div>
      </template>
    </article>

    <Pager :page="page" :pages="pages" @update:page="page = $event; closeAll()" />
  </div>
</template>

<style scoped>
.wrap { padding: 34px 44px 60px; max-width: 940px; }
.compose-open { flex: none; }

.compose { border: 1px solid var(--line-2); border-radius: 8px; background: var(--panel);
  padding: 14px 16px; margin-bottom: 18px; display: flex; flex-direction: column; gap: 10px; }
.compose .to { display: flex; align-items: center; flex-wrap: wrap; gap: 5px;
  background: #15100d; border: 1px solid var(--line-2); border-radius: 6px;
  padding: 7px 10px; cursor: text; }
.compose .to:focus-within { border-color: var(--line-2); box-shadow: 0 0 0 1px var(--line-2); }
.compose .lbl { font-size: 10px; letter-spacing: .06em; text-transform: uppercase; margin-right: 3px; }

.tag { display: inline-flex; align-items: center; gap: 5px; font-size: 12px;
  color: var(--gold); border: 1px solid color-mix(in srgb, var(--gold) 45%, transparent);
  background: color-mix(in srgb, var(--gold) 8%, transparent);
  border-radius: 999px; padding: 2px 4px 2px 9px; white-space: nowrap; }
.tag.all { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  background: color-mix(in srgb, var(--accent) 8%, transparent); }
.tag .x { font: inherit; font-size: 13px; line-height: 1; color: inherit; opacity: .55;
  background: none; border: 0; border-radius: 999px; padding: 1px 4px; cursor: pointer; }
.tag .x:hover { opacity: 1; background: color-mix(in srgb, currentColor 18%, transparent); }

/* The menu hangs off the input, not the row, so wrapped tags do not move it. */
.compose .field { position: relative; flex: 1; min-width: 140px; }
.typeahead { width: 100%; font: inherit; font-size: 13px; color: var(--ink);
  background: none; border: 0; padding: 2px 0; }
.typeahead:focus { outline: none; }

.options { position: absolute; z-index: 5; top: calc(100% + 6px); left: -6px; min-width: 260px;
  max-width: 340px; margin: 0; padding: 4px; list-style: none; background: #1b1512;
  border: 1px solid var(--line-2); border-radius: 6px; box-shadow: 0 10px 28px #0009; }
.opt { display: flex; align-items: baseline; gap: 8px; padding: 6px 9px; border-radius: 4px;
  font-size: 13px; cursor: pointer; }
.opt.on { background: #2a211b; }
.opt.all .opt-name { color: var(--accent); }
.opt-hint { font-size: 11px; margin-left: auto; white-space: nowrap; }
.opt.more { cursor: default; font-size: 11px; justify-content: center; }
.opt.more:hover { background: none; }
.compose .actions { display: flex; align-items: center; gap: 8px; }
.compose .hint { font-size: 11px; }
.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
h1 { font-size: 30px; }
.lede { margin: 6px 0 20px; font-size: 14px; max-width: 58ch; }
.empty { font-size: 15px; margin-top: 20px; }
input { background: #15100d; color: var(--ink); border: 1px solid var(--line-2);
  border-radius: 5px; padding: 7px 10px; font: inherit; font-size: 13px; width: 180px; }

.grow { flex: 1; }

.msg { border: 1px solid var(--line); border-left: 3px solid var(--line);
  border-radius: 6px; background: var(--panel); margin-bottom: 6px; overflow: hidden; }
.msg.unread { border-left-color: var(--accent); }
.msg.open { margin-bottom: 14px; }

.row { display: flex; align-items: baseline; gap: 10px; width: 100%; text-align: left;
  background: none; border: 0; border-radius: 0; padding: 11px 16px; }
.row:hover { background: #1a1512; }
.chev { color: var(--faint); font-size: 10px; align-self: center; flex: none;
  transition: transform .12s ease; }
.chev.down { transform: rotate(90deg); }
.who { font-family: var(--serif); font-size: 16px; color: var(--ink); white-space: nowrap; }
.msg.unread .who { font-weight: 500; }
.role { font-size: 12px; white-space: nowrap; }
/* A label, not a control. It carries no border precisely so it stops looking
   like something to press. */
/* Who it was addressed to, on every row — not only on broadcasts. Without a
   marker on direct mail there was no positive signal that something was
   actually written to you. */
.addressed { font-size: 10px; letter-spacing: .06em; text-transform: uppercase;
  padding: 1px 6px; border-radius: 999px; white-space: nowrap; cursor: help; flex: none; }
.addressed.you { color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); }
.addressed.all { color: var(--faint); border: 1px solid var(--line-2); }
.addressed.other { color: var(--muted); border: 1px solid var(--line); }
.addressed.sent { color: var(--gold); border: 1px solid color-mix(in srgb, var(--gold) 35%, transparent); }
.as { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; }
.as select { font: inherit; font-size: 11.5px; background: #15100d; color: var(--ink);
  border: 1px solid var(--line-2); border-radius: 4px; padding: 3px 6px; }
.scope { font-size: 10px; letter-spacing: .06em; text-transform: uppercase;
  border: 1px solid transparent; border-radius: 4px; padding: 3px 7px; }
.scope.on { color: var(--gold); border-color: var(--line-2); }
.envelope { font-size: 11px; padding: 0 14px 10px; }
.preview { font-size: 13.5px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; min-width: 0; flex: 1 1 auto; }
.new { font-size: 10px; letter-spacing: .07em; text-transform: uppercase;
  color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  border-radius: 9px; padding: 1px 8px; font-family: var(--sans); flex: none; }
.new.inline { display: inline-block; vertical-align: baseline; }
.when { font-size: 11px; white-space: nowrap; flex: none; }

.body { font-size: 15px; padding: 4px 18px 0; }
.reply { padding: 14px 18px 4px; }
.reply textarea { width: 100%; font: inherit; font-size: 13px; line-height: 1.6;
  background: #15100d; color: var(--ink); border: 1px solid var(--line-2);
  border-radius: 5px; padding: 10px; resize: vertical; }
.actions { display: flex; gap: 8px; padding: 12px 18px 16px; }

@media (prefers-reduced-motion: reduce) { .chev { transition: none; } }
</style>
