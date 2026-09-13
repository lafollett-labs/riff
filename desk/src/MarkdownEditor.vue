<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import { api } from './api';

/**
 * A textarea for Markdown prose, with a formatting toolbar over it.
 *
 * The console renders message and document bodies as Markdown (`markdown.ts`),
 * so the composer was already a Markdown editor — it just made you remember the
 * syntax. The buttons and ⌘B/⌘I/⌘K wrap the selection for you, keeping it
 * selected afterwards so the caret never jumps to the end; pasting or choosing
 * an image uploads it and drops an `![image](…)` reference the renderer serves.
 */
const props = withDefaults(defineProps<{
  modelValue: string;
  placeholder?: string;
  minHeight?: string;
}>(), { placeholder: '', minHeight: '200px' });

const emit = defineEmits<{ 'update:modelValue': [string]; busy: [boolean] }>();

const ta = ref<HTMLTextAreaElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const uploading = ref(0);
const error = ref('');
let seq = 0;

// The parent gates Send on this: a body still holding an `![uploading…]`
// placeholder must not be sent (it ships as a broken image and orphans the
// file the upload is about to write).
watch(uploading, (n) => emit('busy', n > 0));

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

/**
 * Upload an image and drop its reference where the caret is. A unique
 * placeholder holds the spot while the bytes are in flight, so the caret can
 * keep moving and typing continue — on success it becomes the real reference,
 * on failure it is removed rather than left as a broken link.
 */
const insertImage = async (blob: Blob) => {
  const el = ta.value;
  const token = `![uploading…](#upload-${++seq})`;
  const at = el ? el.selectionStart : props.modelValue.length;
  emit('update:modelValue', props.modelValue.slice(0, at) + token + props.modelValue.slice(at));
  uploading.value++;
  error.value = '';
  try {
    const { path } = await api.uploadAttachment(blob);
    swap(token, `![image](${path})`);
  } catch (e) {
    swap(token, '');
    error.value = e instanceof Error ? e.message : 'that image would not upload';
  } finally {
    uploading.value--;
  }
};

/** Replace a placeholder in whatever the value is now — the user may have kept
 *  typing around it, so we cannot assume its old position. The replacer is a
 *  function so a `$` in the path can never be read as a replace pattern. */
const swap = (token: string, withText: string) => {
  if (props.modelValue.includes(token)) emit('update:modelValue', props.modelValue.replace(token, () => withText));
};

const onPaste = (e: ClipboardEvent) => {
  const item = [...(e.clipboardData?.items ?? [])].find((it) => it.type.startsWith('image/'));
  const file = item?.getAsFile();
  if (!file) return;               // ordinary text paste falls through untouched
  e.preventDefault();
  void insertImage(file);
};

const onPick = (e: Event) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) void insertImage(file);
  input.value = '';                // let the same file be chosen again next time
};
</script>

<template>
  <div class="editor">
    <div class="bar" role="group" aria-label="Formatting">
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
      <button type="button" class="fmt" title="Add an image — or just paste one"
              aria-label="Add an image" @click="fileInput?.click()">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"
             fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
      </button>
      <!-- One region, always present, so a screen reader announces changes into
           it — and an error is never masked by another upload still running. -->
      <span class="status mono" :class="{ err: !!error, faint: !error }"
            role="status" aria-live="polite">{{ error || (uploading ? 'uploading…' : '') }}</span>
      <input ref="fileInput" type="file" hidden
             accept="image/png,image/jpeg,image/gif,image/webp,image/avif" @change="onPick" />
    </div>
    <textarea ref="ta" :value="modelValue" :placeholder="placeholder"
              :style="{ minHeight }" @input="onInput" @keydown="onKey" @paste="onPaste" />
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
.status { margin-left: auto; align-self: center; font-size: 11px; padding-right: 4px; }
.status.err { color: var(--alert); }

textarea { font: inherit; font-size: 14px; line-height: 1.55; color: var(--ink);
  background: none; border: 0; padding: 10px 12px; width: 100%; box-sizing: border-box;
  resize: vertical; }
textarea:focus { outline: none; }
</style>
