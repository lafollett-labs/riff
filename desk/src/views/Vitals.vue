<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue';
import { api, type Vitals, type Trend, type State, type Event } from '../api';
import { onEvents } from '../live';

const props = defineProps<{ state: State; events: Event[] }>();

const WINDOWS = ['24.hours', '7.days', '30.days'] as const;
const spec = ref<string>('7.days');
const v = ref<Vitals | null>(null);
const err = ref('');

const load = async () => {
  // Which window this request is for. A slow answer to a window the reader has
  // already moved off must not overwrite the one they are looking at now.
  const want = spec.value;
  try {
    const next = await api.vitals(want);
    if (want !== spec.value) return;
    v.value = next;
    err.value = '';
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  }
};
onMounted(load);
watch(spec, load);
// A report that goes stale while you read it invites the wrong conclusion, but
// recomputing on every gate allow would recompute constantly. Shift boundaries
// are the beat that actually moves these numbers.
onEvents(() => props.events, /^(agent\.slept|agent\.failed|commons\.|role\.)/, load);

const usd = (n: number): string => `$${n.toFixed(2)}`;
const pct = (n: number): string => `${Math.round(n * 100)}%`;
/** Millions once it is millions. Nobody reads 41,283,904. */
const tok = (n: number): string => (n >= 1e6
  ? `${(n / 1e6).toFixed(1)}M`
  : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));
const whole = (n: number): string => String(Math.round(n));
const hrs = (n: number | null): string => (n == null ? '—' : `${n.toFixed(1)}h`);

/**
 * The same figure a window earlier. Direction is the whole point: a company
 * that landed twelve commits is doing well or badly depending entirely on
 * what it did the week before, and the level alone cannot say which.
 */
type Dir = { text: string; way: 'good' | 'bad' | 'flat' } | null;

/**
 * The arrow says which way the figure moved; the colour says whether that is
 * good news. They are not the same question, and colouring by direction alone
 * painted a week that cost forty dollars more than the last one in the success
 * colour — as it did a week with more barren shifts.
 */
const delta = (key: keyof Trend, now: number, better: 'up' | 'down', fmt = whole): Dir => {
  const was = v.value?.previous?.[key];
  if (was == null) return null;
  const d = now - was;
  if (Math.abs(d) < 0.005) return { text: 'level', way: 'flat' };
  // The tile's own formatter, handed over rather than guessed at from a unit
  // string: a token delta printed as a raw integer is nine digits of noise.
  const size = fmt(Math.abs(d));
  const rose = d > 0;
  return {
    text: `${rose ? '▲' : '▼'} ${size}`,
    way: rose === (better === 'up') ? 'good' : 'bad',
  };
};

/**
 * What the numbers say, in words, at the top — because a wall of figures is
 * something to scroll past and a sentence is something to act on. Only
 * findings that are actually true of this window appear.
 */
const findings = computed<Array<{ severity: 'warn' | 'note'; text: string }>>(() => {
  const d = v.value;
  if (!d) return [];
  const out: Array<{ severity: 'warn' | 'note'; text: string }> = [];

  if (d.shifts.troubleRate > 0.2) {
    out.push({ severity: 'warn', text:
      `${pct(d.shifts.troubleRate)} of shifts failed or overran. That is the loop, not the work.` });
  }
  if (d.shifts.barren) {
    out.push({ severity: d.shifts.barren > d.shifts.slept / 3 ? 'warn' : 'note', text:
      `${d.shifts.barren} of ${d.shifts.slept} shifts woke, spent money and left nothing behind.` });
  }
  if (d.commons.added && !d.commons.removed) {
    out.push({ severity: 'warn', text:
      `${d.commons.added} document${d.commons.added > 1 ? 's' : ''} added and none removed — ` +
      `accretion with no selection, ` +
      `which is the failure Rule 6 exists to prevent.` });
  }
  if (d.org.hired && !d.org.retired) {
    out.push({ severity: 'note', text:
      `${d.org.hired} hired and nobody retired. Rule 6 bounds the shelf; nothing bounds the payroll.` });
  }
  if (d.commons.held >= d.commons.ceiling && !d.commons.refused) {
    out.push({ severity: 'note', text:
      'The commons is at its ceiling but has never refused a posting — the pressure is untested, not proven.' });
  }
  if (d.envelope.oldestPendingHours != null && d.envelope.oldestPendingHours > 24) {
    out.push({ severity: 'warn', text:
      `A draft has waited ${hrs(d.envelope.oldestPendingHours)} on the board. ` +
      `The staff cannot route around you.` });
  }
  // `d.run.hours` guards the division as much as it reads: a company with
  // shifts but no scheduler lifecycle in the window has a duty cycle of zero,
  // and 1/0 put "wrong by Infinity×" on the page.
  if (d.shifts.slept && d.run.hours > 0 && d.run.dutyCycle < 0.25) {
    out.push({ severity: 'note', text:
      `The company worked ${d.run.hours.toFixed(1)} hours of this ${d.window.spec} window. ` +
      `Read the rates per running hour — per day they are wrong by ${(1 / d.run.dutyCycle).toFixed(0)}×.` });
  }
  // Every other figure in this report rewards throughput, so a company
  // shipping the sixteenth point release of its first idea outscores one that
  // launched something. Rule 7 exists to make that expensive; this is what
  // says whether it worked.
  // Counted in hours the company actually worked, never in days elapsed. It
  // runs when the operator runs it — one company here worked 21.4 hours
  // across 30 calendar days — so a calendar measure would tell a team that
  // was simply switched off that it had stopped having ideas.
  if (d.novelty.carrying > 0 && d.run.hours > 20 && !d.novelty.started && !d.novelty.retired) {
    out.push({ severity: 'warn', text:
      `${d.run.hours.toFixed(1)} hours of work in this window, and nothing was ` +
      `begun or retired. The newest project has been carried for ` +
      `${d.novelty.newestAgeHours ?? 0} worked hours.` });
  }
  if (d.novelty.carrying > 1 && d.novelty.concentration > 0.9) {
    out.push({ severity: 'note', text:
      `${pct(d.novelty.concentration)} of the work went into one project. ` +
      `That is focus or a rut, and how old it is says which.` });
  }
  // The weekly window is the one worth a sentence: it is what the company is
  // actually paced against, and the only ceiling that cannot recover overnight.
  if (d.limits.week && d.limits.week.latest >= 0.75) {
    out.push({ severity: 'warn', text:
      `${pct(d.limits.week.latest)} of the weekly subscription window is gone, ` +
      `leaving ${pct(1 - d.limits.week.latest)}. That ceiling stops the work; ` +
      `the dollar figures do not.` });
  } else if (d.limits.seen && d.limits.peak >= 0.8) {
    out.push({ severity: 'warn', text:
      `The company reached ${pct(d.limits.peak)} of the ` +
      `${d.limits.type ? d.limits.type.replace(/_/g, ' ') : 'subscription'} window. ` +
      `That ceiling stops the work; the dollar figures do not.` });
  }
  if (d.tokens.measured && d.tokens.cacheHitRate < 0.5) {
    out.push({ severity: 'note', text:
      `Only ${pct(d.tokens.cacheHitRate)} of input came from cache. ` +
      `Rotating conversations pays for the whole prompt again.` });
  }
  if (d.shifts.costShareTop > 0.5 && d.people.length > 1) {
    out.push({ severity: 'note', text:
      `${pct(d.shifts.costShareTop)} of the imputed cost is one person.` });
  }
  if (d.talk.byStaff && d.talk.perCommit > 8) {
    out.push({ severity: 'warn', text:
      `${d.talk.perCommit.toFixed(1)} messages for every commit that landed.` });
  }
  if (d.org.orphans) {
    out.push({ severity: 'warn', text:
      `${d.org.orphans} reporting line${d.org.orphans > 1 ? 's point' : ' points'} at somebody who does not work here.` });
  }
  return out;
});

/**
 * Each tile names a figure in this window and the key holding the same figure
 * in the window before it. They are declared together because both halves are
 * `number` and any pairing of them typechecks: `Trend.posted` is the server's
 * `commons.added`, so reading it against `commons.posted` compiles, renders,
 * and quietly compares two different things.
 */
type Tile = {
  label: string;
  key: keyof Trend;
  now: (d: Vitals) => number;
  fmt: (n: number) => string;
  sub: (d: Vitals) => string;
  better: 'up' | 'down';
  /**
   * Nothing measured this figure in the window, so there is no number to
   * show. A 0 here is a claim — "the company consumed nothing" — and an
   * arrow beside it compares two absences and calls them level. The section
   * below already reports the gap; the tile has to agree with it.
   */
  absent?: (d: Vitals) => boolean;
};

const TILES: Tile[] = [
  { label: 'shifts', key: 'shifts', better: 'up',
    now: (d) => d.shifts.slept, fmt: String,
    sub: (d) => `${d.shifts.turnsPerShift.toFixed(1)} turns each` },
  { label: 'tokens', key: 'tokens', better: 'down',
    now: (d) => d.tokens.total, fmt: tok, absent: (d) => !d.tokens.measured,
    sub: (d) => (d.tokens.measured ? `${tok(d.tokens.perShift)} a shift` : 'no shift reported usage') },
  // The label carries "list price"; repeating "not a bill" in the sub-line
  // wrapped the tile onto a second row next to a delta.
  { label: 'list price', key: 'costUsd', better: 'down',
    now: (d) => d.shifts.costUsd, fmt: usd,
    sub: (d) => `${usd(d.shifts.costPerShift)} a shift` },
  { label: 'landed', key: 'commits', better: 'up',
    now: (d) => d.talk.byStaff, fmt: String,
    sub: (d) => (d.talk.byStaff ? `${usd(d.talk.costPerCommit)} a commit` : 'nothing reached the world') },
  { label: 'barren', key: 'barren', better: 'down',
    now: (d) => d.shifts.barren, fmt: String,
    sub: () => 'woke and left nothing' },
];

const tiles = computed(() => {
  const d = v.value;
  if (!d) return [];
  return TILES.map((t) => {
    const now = t.now(d);
    const absent = t.absent?.(d) ?? false;
    return {
      label: t.label,
      value: absent ? '—' : t.fmt(now),
      sub: t.sub(d),
      dir: absent ? null : delta(t.key, now, t.better, t.fmt),
    };
  });
});
</script>

<template>
  <div class="wrap">
    <header class="top">
      <div>
        <h1>Vitals</h1>
        <p class="muted lede">
          Whether any of this is working, as numbers. Nothing here is recorded —
          every figure is read back out of the event log, the ledger and the
          world's git history, so the window costs nothing to widen.
        </p>
      </div>
      <div class="windows">
        <button v-for="w in WINDOWS" :key="w" class="win" :class="{ on: spec === w }"
                :aria-pressed="spec === w"
                @click="spec = w">{{ w.replace('.', ' ') }}</button>
      </div>
    </header>

    <!-- A refresh that fails while you are reading is a banner, not a blank
         page: the figures on screen were true when they were read. -->
    <p v-if="err" class="failed">{{ err }}</p>
    <p v-if="!v && !err" class="muted empty">Reading the record…</p>

    <template v-if="v">
      <div class="tiles">
        <div v-for="t in tiles" :key="t.label" class="tile">
          <span class="tlabel">{{ t.label }}</span>
          <span class="tvalue">{{ t.value }}</span>
          <span class="tsub">
            {{ t.sub }}
            <em v-if="t.dir" :class="t.dir.way">{{ t.dir.text }}</em>
          </span>
        </div>
      </div>

      <section v-if="findings.length" class="findings">
        <p v-for="(f, i) in findings" :key="i" class="finding" :class="f.severity">{{ f.text }}</p>
      </section>
      <p v-else-if="v.shifts.slept" class="muted clean">
        Nothing in this window is out of order.
      </p>
      <p v-else class="muted clean">
        Nobody worked a shift in this window. Start the company, or widen it.
      </p>

      <div class="cols">
        <section>
          <h2>What it consumed</h2>
          <dl v-if="v.tokens.measured">
            <dt>tokens</dt><dd>{{ tok(v.tokens.total) }}</dd>
            <dt>output</dt><dd>{{ tok(v.tokens.output) }}</dd>
            <dt>fresh input</dt><dd>{{ tok(v.tokens.input) }}</dd>
            <dt>cache read · write</dt>
            <dd>{{ tok(v.tokens.cacheRead) }} · {{ tok(v.tokens.cacheWrite) }}</dd>
            <dt>an hour worked</dt>
            <dd>{{ tok(v.run.tokensPerHour) }}<span class="faint"> · {{ usd(v.run.costPerHour) }}</span></dd>
            <dt>from cache</dt>
            <dd :class="{ hot: v.tokens.cacheHitRate < 0.5 }">{{ pct(v.tokens.cacheHitRate) }}</dd>
            <dt>five-hour usage</dt>
            <dd v-if="v.limits.fiveHour" :class="{ hot: v.limits.fiveHour.latest >= 0.75 }">
              {{ pct(v.limits.fiveHour.latest) }}<span class="faint"> · peak {{ pct(v.limits.fiveHour.peak) }}</span>
            </dd>
            <dd v-else class="muted">not reported</dd>
            <dt>seven-day usage</dt>
            <dd v-if="v.limits.week" :class="{ hot: v.limits.week.latest >= 0.75 }">
              {{ pct(v.limits.week.latest) }}<span class="faint"> · peak {{ pct(v.limits.week.peak) }}</span>
            </dd>
            <dd v-else class="muted">not reported</dd>
            <dt>tightest window</dt>
            <dd v-if="v.limits.seen" :class="{ hot: v.limits.peak >= 0.8 }">
              {{ pct(v.limits.latest) }}<span class="faint"> · {{ v.limits.type.replace(/_/g, ' ') }}</span>
            </dd>
            <dd v-else class="muted">not reported</dd>
          </dl>
          <p v-else class="muted">
            No shift in this window reported usage.
          </p>
          <!-- Said whether or not there is usage to report. Dropping it into
               the empty state only meant the claim vanished the moment there
               were numbers to misread. -->
          <p class="note">
            Dollars anywhere in this report are the SDK's imputed list price.
            This account is billed by subscription and nobody is charged them.
          </p>
        </section>

        <section>
          <h2>Is it still finding things</h2>
          <dl>
            <dt>carrying</dt>
            <dd :class="{ hot: v.novelty.ceiling > 0 && v.novelty.carrying >= v.novelty.ceiling }">
              {{ v.novelty.carrying }}<span v-if="v.novelty.ceiling">/{{ v.novelty.ceiling }}</span>
            </dd>
            <dt>started · retired</dt>
            <dd>{{ v.novelty.started }} · {{ v.novelty.retired }}</dd>
            <dt>newest is</dt>
            <dd>
              {{ v.novelty.newestAgeHours == null ? '—' : v.novelty.newestAgeHours + 'h worked' }}
            </dd>
            <dt>worked on</dt><dd>{{ v.novelty.touched }}</dd>
            <dt>biggest share</dt>
            <dd :class="{ hot: v.novelty.concentration > 0.9 && v.novelty.carrying > 1 }">
              {{ pct(v.novelty.concentration) }}</dd>
          </dl>
        </section>

        <section>
          <h2>Commons — rule 6</h2>
          <dl>
            <dt>held</dt><dd :class="{ hot: v.commons.held >= v.commons.ceiling }">
              {{ v.commons.held }}/{{ v.commons.ceiling }}</dd>
            <dt>added</dt><dd>{{ v.commons.added }}</dd>
            <dt>revised</dt><dd>{{ v.commons.revised }}</dd>
            <dt>removed</dt><dd>{{ v.commons.removed }}</dd>
            <dt>net</dt><dd>{{ v.commons.net > 0 ? '+' : '' }}{{ v.commons.net }}</dd>
            <dt>refused as full</dt><dd>{{ v.commons.refused }}</dd>
          </dl>
        </section>

        <section>
          <h2>The org chart</h2>
          <dl>
            <dt>headcount</dt><dd>{{ v.org.headcount }}</dd>
            <dt>hired · retired</dt><dd>{{ v.org.hired }} · {{ v.org.retired }}</dd>
            <dt>shape</dt><dd>{{ v.org.depth }} deep, {{ v.org.widest }} wide</dd>
            <dt>shifts a head</dt><dd>{{ v.org.shiftsPerHead.toFixed(1) }}</dd>
            <dt v-if="v.org.orphans">broken lines</dt>
            <dd v-if="v.org.orphans" class="hot">{{ v.org.orphans }}</dd>
          </dl>
        </section>

        <section>
          <h2>The envelope — rule 3</h2>
          <dl>
            <dt>filed</dt><dd>{{ v.envelope.filed }}</dd>
            <dt>approved · rejected</dt><dd>{{ v.envelope.approved }} · {{ v.envelope.rejected }}</dd>
            <dt>released outward</dt><dd>{{ v.envelope.released }}</dd>
            <dt>still pending</dt><dd :class="{ hot: (v.envelope.oldestPendingHours ?? 0) > 24 }">
              {{ v.envelope.pending }}</dd>
            <dt>oldest waiting</dt><dd>{{ hrs(v.envelope.oldestPendingHours) }}</dd>
            <dt>median decision</dt><dd>{{ hrs(v.envelope.medianDecisionHours) }}</dd>
          </dl>
        </section>

        <section>
          <h2>Talk against work</h2>
          <dl>
            <dt>commits by staff</dt><dd>{{ v.talk.byStaff }}</dd>
            <dt v-if="v.talk.unattributed">not by anyone here</dt>
            <dd v-if="v.talk.unattributed" class="faint">{{ v.talk.unattributed }}</dd>
            <dt>messages</dt><dd>{{ v.talk.messages }}</dd>
            <dt>per commit</dt><dd>{{ v.talk.byStaff ? v.talk.perCommit.toFixed(1) : '—' }}</dd>
            <dt>delivered</dt><dd>{{ v.talk.deliveries }}</dd>
            <dt>notes</dt><dd>{{ v.talk.notes }}</dd>
            <dt>memory kept</dt><dd>{{ v.talk.memoryConsolidated }}</dd>
          </dl>
        </section>

        <section>
          <h2>Work</h2>
          <dl>
            <dt>opened · claimed</dt><dd>{{ v.work.opened }} · {{ v.work.claimed }}</dd>
            <dt>done · dropped</dt><dd>{{ v.work.done }} · {{ v.work.dropped }}</dd>
            <dt>finished</dt><dd>{{ v.work.done + v.work.dropped ? pct(v.work.completionRate) : '—' }}</dd>
            <dt>open now</dt><dd>{{ v.work.openNow }}</dd>
          </dl>
        </section>

        <section>
          <h2>Housekeeping</h2>
          <dl>
            <dt v-if="v.money.cents">spent</dt>
            <dd v-if="v.money.cents">{{ usd(v.money.cents / 100) }}</dd>
            <dt>rotated · compacted</dt>
            <dd>{{ v.shifts.rotated }} · {{ v.shifts.compacted }}</dd>
            <dt>cut at turns · time</dt><dd>{{ v.shifts.truncated }} · {{ v.shifts.outOfTime }}</dd>
            <dt>failed · overran</dt>
            <dd :class="{ hot: v.shifts.overran > 0 }">{{ v.shifts.failed }} · {{ v.shifts.overran }}</dd>
          </dl>
        </section>
      </div>

      <!-- Which rules actually bite. The constitution claims Rule 6 is the
           load-bearing one; this is the table that can contradict it.
           The three totals lead it rather than sitting in a grid cell of
           their own: they are the same subject, and as a seventh cell in a
           three-column grid they stranded a row to hold three numbers. -->
      <section>
        <h2>The gate</h2>
        <p class="tally">
          <strong>{{ v.gate.allow.toLocaleString() }}</strong> allowed,
          <strong>{{ v.gate.deny.toLocaleString() }}</strong> refused,
          <strong>{{ v.gate.escalate.toLocaleString() }}</strong> sent up.
          <span v-if="!v.gate.rules.length" class="faint">
            Nothing was refused in this window.</span>
        </p>
        <!-- Nine columns of figures do not fit a narrow window, and a table
             that widens the document scrolls the whole page sideways. -->
        <div v-if="v.gate.rules.length" class="tablewrap">
        <table class="grid">
          <caption class="offscreen">Rules that refused something, most often first</caption>
          <thead><tr><th scope="col">times</th><th scope="col">decision</th>
            <th scope="col">rule</th><th scope="col">capability</th></tr></thead>
          <tbody>
            <tr v-for="r in v.gate.rules.slice(0, 8)"
                :key="r.kind + r.rule + r.capability">
              <td class="n">{{ r.n }}</td>
              <td>{{ r.kind }}</td>
              <td><code>{{ r.rule }}</code></td>
              <td class="faint">{{ r.capability }}</td>
            </tr>
          </tbody>
        </table>
        </div>
      </section>

      <section v-if="v.people.length">
        <h2>Who did the work</h2>
        <div class="tablewrap">
        <table class="grid">
          <caption class="offscreen">What each member of staff did in this window</caption>
          <thead>
            <tr>
              <th scope="col">who</th><th scope="col" class="n">shifts</th>
              <th scope="col" class="n">commits</th><th scope="col" class="n">posts</th>
              <th scope="col" class="n">mail</th><th scope="col" class="n">drafts</th>
              <th scope="col" class="n">done</th><th scope="col" class="n">denied</th>
              <th scope="col" class="n">tokens</th><th scope="col" class="n">list $</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in v.people" :key="p.id">
              <td>{{ p.name }} <span class="faint">{{ p.role }}</span></td>
              <td class="n">{{ p.shifts }}</td>
              <td class="n">{{ p.commits }}</td>
              <td class="n">{{ p.posted }}</td>
              <td class="n">{{ p.messages }}</td>
              <td class="n">{{ p.filed }}</td>
              <td class="n">{{ p.done }}</td>
              <td class="n" :class="{ hot: p.denied > 5 }">{{ p.denied || '' }}</td>
              <td class="n">{{ p.tokens ? tok(p.tokens) : '—' }}</td>
              <td class="n">{{ usd(p.costUsd) }}</td>
            </tr>
          </tbody>
        </table>
        </div>
      </section>

      <p class="muted foot">
        {{ v.window.spec }}, from {{ new Date(v.window.since).toLocaleString() }} —
        worked {{ v.run.hours.toFixed(1) }}h of it ({{ pct(v.run.dutyCycle) }} of the window).
        <span v-if="v.previous">Arrows compare against the {{ v.window.spec }} before it.</span>
      </p>
    </template>
  </div>
</template>

<style scoped>
.wrap { padding: 34px 44px 60px; max-width: 1080px; }
.top { display: flex; align-items: flex-start; gap: 24px; }
h1 { font-size: 30px; }
h2 { font-size: 13px; font-family: var(--sans); text-transform: uppercase;
  letter-spacing: .1em; color: var(--faint); margin: 30px 0 10px; }
.lede { margin: 6px 0 24px; font-size: 14px; max-width: 62ch; }
/* Three totals that belong to the table under them, not to a grid cell of
   their own — as one they stranded a row of a three-column grid. */
.note { margin: 14px 0 0; font-size: 12px; line-height: 1.5; color: var(--faint); }
.tally { margin: 0 0 14px; font-size: 13px; color: var(--muted); }
.tally strong { font-family: var(--mono); font-weight: 500; color: var(--ink); }
.empty, .clean { font-size: 15px; max-width: 58ch; margin: 18px 0; }
.windows { display: flex; gap: 6px; margin-left: auto; flex: none; }
.win { font-family: var(--mono); font-size: 11px; letter-spacing: .05em;
  padding: 6px 11px; border: 1px solid var(--line); border-radius: 4px;
  background: transparent; color: var(--muted); cursor: pointer; }
.win:hover { background: #1a1512; color: var(--ink-2); }
.win.on { background: var(--panel); color: var(--gold); border-color: var(--line-2); }

.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
.tile { background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
  padding: 14px 17px; display: flex; flex-direction: column; gap: 3px; }
.tlabel { font-family: var(--mono); font-size: 10px; letter-spacing: .1em;
  text-transform: uppercase; color: var(--faint); }
.tvalue { font-family: var(--mono); font-size: 27px; color: var(--gold); line-height: 1.1; }
.tsub { font-size: 12px; color: var(--muted); }
.tsub em { font-style: normal; font-family: var(--mono); font-size: 11px; margin-left: 7px; }
.tsub em.good { color: var(--ok); }
.tsub em.bad { color: var(--accent); }
.tsub em.flat { color: var(--faint); }

.findings { margin: 22px 0 4px; display: flex; flex-direction: column; gap: 6px; }
.finding { font-size: 14px; padding: 11px 15px; border-radius: 5px;
  border: 1px solid var(--line); background: var(--panel); margin: 0; }
.finding.warn { border-color: #5c3a26; background: #241a11; }
/* Its own name. Sharing `warn` with a finding meant the error box and the
   findings below it disagreed about their own padding by a pixel. */
.failed { border: 1px solid #5c3a26; background: #241a11; border-radius: 5px;
  padding: 12px 16px; font-size: 14px; }

/* Multi-column rather than a grid: the sections are different heights and a
   grid puts each on a row of its own height, so seven of them left one
   stranded alone on a third row with two empty columns beside it. Columns
   balance the flow instead, and break-inside keeps a section whole. */
.cols { columns: 3 280px; column-gap: 34px; }
.cols > section { break-inside: avoid; margin-bottom: 30px; }
dl { display: grid; grid-template-columns: 1fr auto; gap: 5px 14px; margin: 0;
  font-size: 13px; align-items: baseline; }
dt { color: var(--muted); }
dd { margin: 0; font-family: var(--mono); color: var(--ink); text-align: right; }
dd.hot { color: var(--alert); }

.grid { width: 100%; border-collapse: collapse; font-size: 13px; }
.grid th { text-align: left; font-family: var(--mono); font-size: 10px;
  letter-spacing: .09em; text-transform: uppercase; color: var(--faint);
  font-weight: normal; padding: 0 10px 7px 0; }
.grid td { padding: 6px 10px 6px 0; border-top: 1px solid var(--line); }
.tablewrap { overflow-x: auto; }
.offscreen { position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; }
.grid .n { text-align: right; font-family: var(--mono); }
.grid td.hot { color: var(--alert); }
.faint { color: var(--faint); font-size: 11px; }
.foot { font-size: 12px; margin-top: 30px; }
</style>
