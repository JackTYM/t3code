// Tiny event bus letting the `thread.find` keybinding and the command palette
// open the transcript find bar without owning the timeline's React state, the
// way `commandPaletteBus` does for the palette itself. Both entry points go
// through this one channel so neither carries its own copy of the open logic.
const THREAD_FIND_OPEN_EVENT = "t3code:open-thread-find";

export function openThreadFind(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(THREAD_FIND_OPEN_EVENT));
}

/** Guarded like `isCommandPaletteOpen`: the timeline also renders without a DOM. */
export function onOpenThreadFind(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(THREAD_FIND_OPEN_EVENT, listener);
  return () => window.removeEventListener(THREAD_FIND_OPEN_EVENT, listener);
}
