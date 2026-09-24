// Autosave, spec §9: every committed action schedules a debounced (300ms) snapshot
// write; visibilitychange→hidden and pagehide flush synchronously-queued writes.
//
// Subscribes via subscribeView (Phase 1.1 item 2) rather than subscribe: pan/zoom must still
// eventually persist ("restore ... current viewport"), but resetting a timer is cheap enough to
// do on every pinch sample — unlike the dock/context-bar DOM rebuild, which subscribe() alone
// reaches. No IndexedDB write happens until 300ms after the gesture actually stops.
//
// Phase 5.5 item 4: writes always go to the CURRENT artwork's own record (its id) — autosave never
// creates another artwork. It also keeps that artwork's thumbnail fresh, re-drawn a little after
// each real edit (not on every pan/zoom), and exposes flush() for Save and artwork switching.

import type { AppController } from '../app/controller.ts';
import { saveDocument, saveHistory, setMeta } from './db.ts';
import { makeThumbnail } from './thumbnail.ts';

const DEBOUNCE_MS = 300;
const THUMBNAIL_DEBOUNCE_MS = 1500;

export interface AutosaveHandle {
  detach: () => void;
  /** Writes now (and redraws the thumbnail first when asked). */
  flush: (opts?: { thumbnail?: boolean }) => void;
}

export function attachAutosave(controller: AppController): AutosaveHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let thumbTimer: ReturnType<typeof setTimeout> | null = null;
  let thumbnail = makeThumbnail(controller.doc);

  const writeNow = (): void => {
    const doc = controller.doc;
    const { undo, redo } = controller.getHistorySnapshot();
    // IndexedDB's structured clone runs synchronously when put() is called, so
    // handing it the live doc/stacks here is safe even if they're replaced
    // (not mutated in place) by a later commit before the write settles.
    void saveDocument({
      id: doc.id,
      name: doc.name,
      named: doc.named,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      schemaVersion: doc.schemaVersion,
      thumbnail,
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

  const scheduleThumbnail = (): void => {
    if (thumbTimer) clearTimeout(thumbTimer);
    thumbTimer = setTimeout(() => {
      thumbTimer = null;
      thumbnail = makeThumbnail(controller.doc);
      scheduleSave();
    }, THUMBNAIL_DEBOUNCE_MS);
  };

  const flush = (opts: { thumbnail?: boolean } = {}): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (opts.thumbnail) {
      if (thumbTimer) clearTimeout(thumbTimer);
      thumbTimer = null;
      thumbnail = makeThumbnail(controller.doc);
    }
    writeNow();
  };

  const unsubscribeView = controller.subscribeView(scheduleSave);
  const unsubscribe = controller.subscribe(scheduleThumbnail);

  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') flush();
  };
  const onPageHide = (): void => flush();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);

  // Capture the current state immediately so a fresh document isn't lost to a crash
  // before its first edit.
  writeNow();

  return {
    flush,
    detach: () => {
      unsubscribeView();
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      if (timer) clearTimeout(timer);
      if (thumbTimer) clearTimeout(thumbTimer);
    },
  };
}
