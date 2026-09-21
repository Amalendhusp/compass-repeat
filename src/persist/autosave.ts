// Autosave, spec §9: every committed action schedules a debounced (300ms) snapshot
// write; visibilitychange→hidden and pagehide flush synchronously-queued writes.
//
// Subscribes via subscribeView (Phase 1.1 item 2) rather than subscribe: pan/zoom must still
// eventually persist ("restore ... current viewport"), but resetting a timer is cheap enough to
// do on every pinch sample — unlike the dock/context-bar DOM rebuild, which subscribe() alone
// reaches. No IndexedDB write happens until 300ms after the gesture actually stops.

import type { AppController } from '../app/controller.ts';
import { saveDocument, saveHistory, setMeta } from './db.ts';

const DEBOUNCE_MS = 300;

export function attachAutosave(controller: AppController): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const writeNow = (): void => {
    const doc = controller.doc;
    const { undo, redo } = controller.getHistorySnapshot();
    // IndexedDB's structured clone runs synchronously when put() is called, so
    // handing it the live doc/stacks here is safe even if they're replaced
    // (not mutated in place) by a later commit before the write settles.
    void saveDocument({
      id: doc.id,
      name: doc.name,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      schemaVersion: doc.schemaVersion,
      snapshot: doc,
    });
    void saveHistory({ docId: doc.id, undoStack: undo, redoStack: redo });
    void setMeta('lastOpenDocId', doc.id);
  };

  const scheduleSave = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      writeNow();
    }, DEBOUNCE_MS);
  };

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    writeNow();
  };

  const unsubscribe = controller.subscribeView(scheduleSave);

  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') flush();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', flush);

  // Capture the current state immediately so a fresh document isn't lost to a crash
  // before its first edit.
  writeNow();

  return () => {
    unsubscribe();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', flush);
    if (timer) clearTimeout(timer);
  };
}
