// vNext Phase 4A: records an artwork's process — one moment per meaningful committed change.
//
// It watches the controller rather than any tool. Every commit, Undo, Redo (and a pointercancel
// that takes a commit back) replaces the controller's document, so a new document object is the
// sign of a committed moment; if the artwork part of it really changed, that is one moment. Drag
// previews, tool switches, pan/zoom, menus and Save never change the artwork, so they never
// record anything. Two artwork settings change in place, without a commit — Repeat's Appearance
// and the lattice Repeat suggests on first entry — so those are watched by a small fingerprint and
// recorded once they've been still for a moment (a slider drag is one moment, not fifty).
//
// At the moment itself only a tiny snapshot is taken: the committed document (never mutated again)
// plus its few in-place fields. Capturing, diffing, fingerprinting and writing run queued, after
// the gesture's own work, in short steps that let the screen keep drawing in between.

import type { AppController } from '../app/controller.ts';
import type { Doc } from '../model/types.ts';
import { PROCESS_FORMAT, capturedHash, captureState, describeChange, diffStates, inPlaceFingerprint, inPlaceParts, type ArtworkState, type InPlaceParts, type ProcessSource } from './processState.ts';
import { enqueue, loadMeta, writeEvents, type ProcessEvent, type ProcessMeta } from './processStore.ts';

/** A settled in-place change (Appearance, Repeat's first lattice) waits this long before it counts. */
const IN_PLACE_SETTLE_MS = 700;
/** A fresh keyframe after this many moments, or once the patches since the last one weigh as much
 * as it does — so replaying any moment never means applying an unbounded run of patches. */
const KEYFRAME_EVERY = 200;

export interface ProcessHandle {
  /** Records a pending in-place change now (before Save As copies the history, or on close). */
  flush(): void;
  detach(): void;
}

/** One moment, as taken at the time: cheap, and complete once captured in the queue. */
interface Moment {
  doc: Doc;
  parts: InPlaceParts;
}
const moment = (doc: Doc): Moment => ({ doc, parts: inPlaceParts(doc) });
/** Lets rendering and input run between the steps of one queued recording. */
const breathe = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export function attachProcessRecorder(controller: AppController, opts: { fresh: boolean }): ProcessHandle {
  const docId = controller.doc.id;
  let lastRef = controller.doc;
  let lastPrint = inPlaceFingerprint(lastRef);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const opened = moment(lastRef);

  // Touched only inside queued jobs, in order.
  let meta: ProcessMeta | undefined;
  let prev!: ArtworkState;
  let prevHash = '';

  const event = (seq: number, at: number, source: ProcessSource, kind: string, tags: string[], hash: string, body: Pick<ProcessEvent, 'patch' | 'keyframe'>): ProcessEvent => ({ docId, seq, at, source, kind, tags, hash, ...body });

  /** The first moment of a history: a keyframe of the artwork as it stands. */
  async function start(origin: ProcessMeta['origin'], at: number): Promise<void> {
    const { hash, bytes } = capturedHash(prev);
    prevHash = hash;
    meta = {
      docId,
      format: PROCESS_FORMAT,
      origin,
      startedAt: at,
      headSeq: 0,
      headHash: prevHash,
      keyframeSeq: 0,
      keyframeBytes: bytes,
      sinceKeyframe: { events: 0, bytes: 0 },
      events: 1,
      bytes,
      gaps: 0,
    };
    await writeEvents(meta, [event(0, at, 'baseline', 'baseline', [], prevHash, { keyframe: prev })]);
  }

  enqueue(async () => {
    prev = captureState(opened.doc, opened.parts);
    meta = await loadMeta(docId);
    // A new artwork's history starts at its frame; an existing one waits for its first real change.
    if (!meta && opts.fresh) await start('new', Date.now());
  });

  function record(taken: Moment, source: ProcessSource, at: number): void {
    enqueue(async () => {
      await breathe();
      const state = captureState(taken.doc, taken.parts);
      await breathe();
      const ops = diffStates(prev, state);
      if (ops.length === 0) return;
      if (!meta) {
        await start('existing', at);
      } else if (!prevHash) {
        // First change since opening: does the saved artwork still match where its history ended?
        const opened = capturedHash(prev);
        prevHash = opened.hash;
        if (prevHash !== meta.headHash) {
          const seq = meta.headSeq + 1;
          meta = { ...meta, headSeq: seq, headHash: prevHash, keyframeSeq: seq, keyframeBytes: opened.bytes, sinceKeyframe: { events: 0, bytes: 0 }, events: meta.events + 1, bytes: meta.bytes + opened.bytes, gaps: meta.gaps + 1 };
          await writeEvents(meta, [event(seq, at, 'resync', 'resync', [], prevHash, { keyframe: prev })]);
        }
      }
      await breathe();
      const m = meta!;
      const { hash, bytes: stateBytes } = capturedHash(state);
      const { kind, tags } = describeChange(prev, state, source);
      const patchBytes = JSON.stringify(ops).length;
      const seq = m.headSeq + 1;
      const keyframe = m.sinceKeyframe.events + 1 >= KEYFRAME_EVERY || m.sinceKeyframe.bytes + patchBytes >= m.keyframeBytes;
      const bytes = keyframe ? stateBytes : patchBytes;
      meta = {
        ...m,
        headSeq: seq,
        headHash: hash,
        events: m.events + 1,
        bytes: m.bytes + bytes,
        ...(keyframe ? { keyframeSeq: seq, keyframeBytes: stateBytes, sinceKeyframe: { events: 0, bytes: 0 } } : { sinceKeyframe: { events: m.sinceKeyframe.events + 1, bytes: m.sinceKeyframe.bytes + patchBytes } }),
      };
      prev = state;
      prevHash = hash;
      await writeEvents(meta, [event(seq, at, source, kind, tags, hash, keyframe ? { keyframe: state } : { patch: ops })]);
    });
  }

  const settleInPlace = () => {
    timer = null;
    record(moment(controller.doc), 'in-place', Date.now());
  };

  const onChange = () => {
    const doc = controller.doc;
    if (doc !== lastRef) {
      // A settled-but-unrecorded in-place change belongs to the document it was made on.
      if (timer) {
        clearTimeout(timer);
        timer = null;
        record(moment(lastRef), 'in-place', Date.now());
      }
      lastRef = doc;
      lastPrint = inPlaceFingerprint(doc);
      record(moment(doc), controller.lastChange, Date.now());
      return;
    }
    const print = inPlaceFingerprint(doc);
    if (print === lastPrint) return;
    lastPrint = print;
    if (timer) clearTimeout(timer);
    timer = setTimeout(settleInPlace, IN_PLACE_SETTLE_MS);
  };

  const flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    settleInPlace();
  };
  const onHide = () => {
    if (document.visibilityState === 'hidden') flush();
  };

  const unsubscribe = controller.subscribeView(onChange);
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flush);

  return {
    flush,
    detach() {
      flush();
      unsubscribe();
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
    },
  };
}
