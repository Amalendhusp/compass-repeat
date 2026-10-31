// UI-1: the working draft — the one unsaved working session the app keeps for recovery.
//
// Saved artworks (the `documents` store, shown in My Artworks) change only on an explicit Save or
// Save As. Everything in between — every edit, the view, Undo/Redo — is kept here instead, in a
// single slot in the `meta` store, so an accidental refresh or closure loses nothing, yet nothing
// experimental is ever listed as an artwork. Only the most recent working session is kept.
//
// `baseHash` is the artwork-state fingerprint (processState's captureState) of what the session
// started from — the saved version, or a new artwork's bare frame. The draft has unsaved changes
// exactly when its own state differs from that, or (Sprint S2) a saved artwork's drawing preferences
// differ from its saved ones (`prefsBase`); view and names never count.

import type { Doc } from '../model/types.ts';
import { capturedHash, captureState, inPlaceFingerprint } from './processState.ts';
import { getMeta, setMeta } from './db.ts';

const KEY = 'workingDraft';

export interface WorkingDraft {
  docId: string;
  name: string;
  named: boolean;
  /** A saved artwork with this id exists — the draft is that artwork, edited. */
  savedBase: boolean;
  baseHash: string;
  /** Sprint S2: the saved version's drawing preferences (`prefsHash`) — a change to them is an unsaved
   * change too. Null for a never-saved artwork (its preferences never count); absent in older drafts. */
  prefsBase?: string | null;
  /** Changes not in the saved version (or, for a never-saved artwork, any change since its frame). */
  dirty: boolean;
  updatedAt: number;
  thumbnail?: string;
  snapshot: Doc;
  undo: Doc[];
  redo: Doc[];
}

/** What the slot holds, without loading it again (kept in step with every write here). */
let slot: { docId: string; dirty: boolean } | null | undefined;

export async function loadDraft(): Promise<WorkingDraft | null> {
  const d = (await getMeta<WorkingDraft | null>(KEY)) ?? null;
  slot = d ? { docId: d.docId, dirty: d.dirty } : null;
  return d;
}

export async function putDraft(d: WorkingDraft): Promise<void> {
  slot = { docId: d.docId, dirty: d.dirty };
  await setMeta(KEY, d);
}

export async function clearDraft(): Promise<void> {
  slot = null;
  await setMeta(KEY, null);
}

/** The slot's owner and state as last read or written (undefined before the first read). */
export const draftSlot = () => slot;

/** The fingerprint of a document's artwork state (no view, preferences or name). */
export function artworkHash(doc: Doc): string {
  return capturedHash(captureState(doc)).hash;
}

/** Sprint S2: the drawing preferences kept with an artwork — construction colour, Fair colour and width,
 * Fill colour and opacity, Repeat's Fill colour and opacity. Not artwork state (never Undo, never in the
 * process history), but part of what a Save keeps: a saved artwork's change to them is an unsaved change,
 * kept in the working draft until Save or Save As. */
export function prefsHash(doc: Doc): string {
  return JSON.stringify([doc.toolPrefs?.constructionColour ?? null, doc.fairDefaults ?? null, doc.fillDefaults ?? null, doc.repeatPaint ?? null]);
}

/** Answers "does this document differ from `base`?" cheaply: the hash is recomputed only after the
 * document is replaced (a commit, Undo, Redo) or its in-place artwork fields change. */
export function dirtyTracker(
  base: string,
  prefsBase: string | null = null,
): { dirty: (doc: Doc) => boolean; hash: (doc: Doc) => string; rebase: (hash: string, prefs: string | null) => void; base: () => string; prefsBase: () => string | null } {
  let ref: Doc | null = null;
  let print = '';
  let last = '';
  const hash = (doc: Doc) => {
    const p = inPlaceFingerprint(doc);
    if (doc !== ref || p !== print) {
      ref = doc;
      print = p;
      last = artworkHash(doc);
    }
    return last;
  };
  return {
    hash,
    dirty: (doc) => hash(doc) !== base || (prefsBase !== null && prefsHash(doc) !== prefsBase),
    rebase: (h, prefs) => {
      base = h;
      prefsBase = prefs;
    },
    base: () => base,
    prefsBase: () => prefsBase,
  };
}
