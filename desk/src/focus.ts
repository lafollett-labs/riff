import { nextTick } from 'vue';

/**
 * The button a keyboard user pressed, or null.
 *
 * Read from the event, not document.activeElement: Safari and macOS Firefox do
 * not focus a button on click, so the active element can be some other button
 * the user tabbed to earlier. And only a keyboard press counts — Chromium does
 * focus a clicked button, and moving a mouse user's focus paints a ring on a
 * field they never went near.
 */
export const pressedByKeyboard = (e?: UIEvent): HTMLButtonElement | null => {
  const t = e?.currentTarget;
  return t instanceof HTMLButtonElement && t.matches(':focus-visible') ? t : null;
};

/**
 * Put keyboard focus back after an action that disables its own button.
 *
 * A Save is disabled while it runs and again once nothing is dirty, so a
 * keyboard user who pressed it lost focus to <body> and their next Tab started
 * from the top of the page. A save that landed sends focus to `fallback`, the id
 * of a nearby control that survives: its button is disabled for good, or will
 * be once the view's refresh arrives (Staff's pickers read dirty until then).
 * One that failed gives focus back to `from`, re-enabled for another try. Focus
 * the user has moved elsewhere in the meantime is left alone.
 */
export const rehome = async (from: HTMLButtonElement | null, fallback: string, landed: boolean): Promise<void> => {
  await nextTick();
  if (!from) return;
  const active = document.activeElement;
  if (active !== null && active !== document.body && active !== from) return;
  const usable = from.isConnected && !from.disabled;
  (landed || !usable ? document.getElementById(fallback) : from)?.focus();
};
