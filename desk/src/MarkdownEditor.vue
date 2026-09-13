<script setup lang="ts">
import { ref, nextTick } from 'vue';

/**
 * A textarea for Markdown prose, with a formatting toolbar over it.
 *
 * The console renders message and document bodies as Markdown (`markdown.ts`),
 * so the composer was already a Markdown editor — it just made you remember the
 * syntax. The buttons and ⌘B/⌘I/⌘K wrap the selection for you, keeping it
 * selected afterwards so the caret never jumps to the end.
 */
const props = withDefaults(defineProps<{
  modelValue: string;
  placeholder?: string;
  minHeight?: string;
}>(), { placeholder: '', minHeight: '200px' });

const emit = defineEmits<{ 'update:modelValue': [string] }>();

const ta = ref<HTMLTextAreaElement | null>(null);

/** Focus the box (used after a button click so typing continues in it). */
const focus = () => ta.value?.focus();
defineExpose({ focus });

/**
 * Wrap the selection in markers. With nothing selected it drops the caret
 * between them, so **|** lets you type into the emphasis rather than beside it.
 */
const surround = (before: string, after = before) => {
  const el = ta.value; if (!el) return;
  const { selectionStart: s, selectionEnd: e } = el;
  const v = props.modelValue;
  emit('update:modelValue', v.slice(0, s) + before + v.slice(s, e) + after + v.slice(e));
  nextTick(() => {
    el.focus();
    el.selectionStart = s + before.length;
    el.selectionEnd = e + before.length;
  });
};

/**
 * A link keeps the selected text as its label and lands the selection on the
 * URL placeholder, so the next keystroke types the address over it.
 */
const link = () => {
  const el = ta.value; if (!el) return;
  const { selectionStart: s, selectionEnd: e } = el;
  const v = props.modelValue;
  const label = v.slice(s, e) || 'text';
  emit('update:modelValue', `${v.slice(0, s)}[${label}](url)${v.slice(e)}`);
  nextTick(() => {
    el.focus();
    const urlAt = s + label.length + 3;   // past "[label]("
    el.selectionStart = urlAt;
    el.selectionEnd = urlAt + 3;          // selects "url"
  });
};

const onKey = (e: KeyboardEvent) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'b') { e.preventDefault(); surround('**'); }
  else if (k === 'i') { e.preventDefault(); surround('*'); }
  else if (k === 'k') { e.preventDefault(); link(); }
};

const onInput = (e: Event) =>
  emit('update:modelValue', (e.target as HTMLTextAreaElement).value);
</script>

<template>
  <div class="editor">
    <div class="bar" role="toolbar" aria-label="Formatting">
      <button type="button" class="fmt bold" title="Bold — ⌘B" aria-label="Bold"
              @click="surround('**')">B</button>
      <button type="button" class="fmt ital" title="Italic — ⌘I" aria-label="Italic"
              @click="surround('*')">I</button>
      <button type="button" class="fmt" title="Link — ⌘K" aria-label="Link"
              @click="link">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"
             fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      </button>
    </div>
    <textarea ref="ta" :value="modelValue" :placeholder="placeholder"
              :style="{ minHeight }" @input="onInput" @keydown="onKey" />
  </div>
</template>

<style scoped>
.editor { display: flex; flex-direction: column; border: 1px solid var(--line-2);
  border-radius: 6px; background: #15100d; overflow: hidden; }
.editor:focus-within { box-shadow: 0 0 0 1px var(--line-2); }

.bar { display: flex; gap: 2px; padding: 5px 6px; border-bottom: 1px solid var(--line);
  background: #1a1512; }
.fmt { width: 28px; height: 26px; display: inline-flex; align-items: center;
  justify-content: center; font: inherit; font-size: 14px; color: var(--muted);
  background: none; border: 1px solid transparent; border-radius: 4px; cursor: pointer; }
.fmt:hover { color: var(--ink); background: #241d18; }
.fmt:focus-visible { outline: none; border-color: var(--line-2); color: var(--ink); }
.fmt.bold { font-weight: 700; }
.fmt.ital { font-style: italic; font-family: var(--serif); }

textarea { font: inherit; font-size: 14px; line-height: 1.55; color: var(--ink);
  background: none; border: 0; padding: 10px 12px; width: 100%; box-sizing: border-box;
  resize: vertical; }
textarea:focus { outline: none; }
</style>
