<script setup lang="ts">
/**
 * The rail's nav icons. One line-drawn glyph per view id, stroked in
 * `currentColor` so each inherits the nav item's ink — dim by default, and
 * lifted to the accent on the active item by a rule in App.vue. Decorative:
 * `aria-hidden`, with the item's text label carrying the accessible name.
 */
defineProps<{ name: string }>();
</script>

<template>
  <svg class="nav-ic" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"
       fill="none" stroke="currentColor" stroke-width="1.8"
       stroke-linecap="round" stroke-linejoin="round">
    <!-- overview: the company's front page — home -->
    <template v-if="name === 'overview'">
      <path d="M3 11l9-7 9 7" /><path d="M5 10v9h14v-9" />
    </template>
    <!-- envelope: the board's drafts — a sealed letter -->
    <template v-else-if="name === 'envelope'">
      <rect x="3" y="5" width="18" height="14" rx="1.5" /><path d="M3 7l9 6 9-6" />
    </template>
    <!-- inbox: incoming mail — a tray -->
    <template v-else-if="name === 'inbox'">
      <path d="M5 5h14l2 8v4a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17v-4z" />
      <path d="M3 13h5l1.5 2.5h5L21 13" />
    </template>
    <!-- record: the audit ledger — a written page -->
    <template v-else-if="name === 'record'">
      <path d="M6 3h8l5 5v13H6z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h6" />
    </template>
    <!-- shift: a work session in time — a clock -->
    <template v-else-if="name === 'shift'">
      <circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" />
    </template>
    <!-- staff: the people — two figures -->
    <template v-else-if="name === 'staff'">
      <circle cx="9" cy="8" r="3" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.5a3 3 0 0 1 0 6M16 13.6a5.5 5.5 0 0 1 4.5 5.4" />
    </template>
    <!-- work: open tasks — a briefcase -->
    <template v-else-if="name === 'work'">
      <rect x="3" y="7" width="18" height="13" rx="1.5" />
      <path d="M8 7V5.5A1.5 1.5 0 0 1 9.5 4h5A1.5 1.5 0 0 1 16 5.5V7" /><path d="M3 12h18" />
    </template>
    <!-- commons: the shared documents — a book -->
    <template v-else-if="name === 'commons'">
      <path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z" /><path d="M9 4v14" />
    </template>
    <!-- secrets: the vault keys — a key -->
    <template v-else-if="name === 'secrets'">
      <circle cx="8" cy="12" r="3.5" /><path d="M11 12h9M17 12v3M20 12v2" />
    </template>
    <!-- services: outbound routes — a link -->
    <template v-else-if="name === 'services'">
      <path d="M9.5 14.5l-3 3a3 3 0 0 1-4-4l3-3" /><path d="M14.5 9.5l3-3a3 3 0 0 1 4 4l-3 3" />
      <path d="M9 15l6-6" />
    </template>
    <!-- vitals: the record over time — a pulse -->
    <template v-else-if="name === 'vitals'">
      <path d="M3 12h4l3 7 4-14 3 7h4" />
    </template>
    <!-- feed: the live stream — a list -->
    <template v-else-if="name === 'feed'">
      <circle cx="5.5" cy="8" r="1" /><circle cx="5.5" cy="12" r="1" /><circle cx="5.5" cy="16" r="1" />
      <path d="M9 8h11M9 12h11M9 16h11" />
    </template>
    <!-- config: the company's settings — sliders -->
    <template v-else-if="name === 'config'">
      <path d="M4 7h9M18 7h2M4 12h2M11 12h9M4 17h7M16 17h4" />
      <circle cx="15" cy="7" r="2" /><circle cx="8" cy="12" r="2" /><circle cx="13" cy="17" r="2" />
    </template>
  </svg>
</template>

<style scoped>
.nav-ic { flex: none; }
</style>
