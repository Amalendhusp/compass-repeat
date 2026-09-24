// IndexedDB storage, spec §9. A database per origin, with `documents`, `history`
// and `meta` stores. Maps (segmentStates, fills, repeat.gapFills) are stored
// as-is — IndexedDB's structured-clone algorithm handles Map/Set natively.
//
// Simplification disclosed: §9 describes `history` as a per-document *op log*
// with compaction every 50 ops (undo depth ≥ 200 after reload). This pass's
// undo model is snapshot-based (§8 is satisfied via full Doc clones per
// commit, not a replayable op log), so `history` here persists the snapshot
// undo/redo stacks directly rather than a compacted op log. Undo/redo does
// survive reload either way; the op-log/compaction machinery is deferred.

import type { Doc } from '../model/types.ts';

const DB_NAME = 'construct-and-repeat';
const DB_VERSION = 1;

export interface DocumentRecord {
  id: string;
  name: string;
  /** Phase 5.5: whether the participant named it (unnamed artworks are still kept and listed). */
  named?: boolean;
  createdAt: number;
  updatedAt: number;
  schemaVersion: number;
  /** Phase 5.5 item 3: a small PNG data URL of the artwork, for My Artworks. */
  thumbnail?: string;
  snapshot: Doc;
}

export interface ArtworkSummary {
  id: string;
  name: string;
  named: boolean;
  createdAt: number;
  updatedAt: number;
  thumbnail?: string;
}

export interface HistoryRecord {
  docId: string;
  undoStack: Doc[];
  redoStack: Doc[];
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('history')) db.createObjectStore('history', { keyPath: 'docId' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = run(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.onerror = () => reject(t.error);
  });
}

let persistRequested = false;

export async function saveDocument(record: DocumentRecord): Promise<void> {
  const db = await openDb();
  await tx(db, 'documents', 'readwrite', (s) => s.put(record));
  if (!persistRequested) {
    persistRequested = true;
    navigator.storage?.persist?.().catch(() => {});
  }
}

export async function loadDocument(id: string): Promise<DocumentRecord | undefined> {
  const db = await openDb();
  return tx<DocumentRecord | undefined>(db, 'documents', 'readonly', (s) => s.get(id));
}

/** Phase 5.5 item 8: every saved artwork, newest first — metadata and thumbnail only. */
export async function listArtworks(): Promise<ArtworkSummary[]> {
  const db = await openDb();
  const records = await tx<DocumentRecord[]>(db, 'documents', 'readonly', (s) => s.getAll());
  return records
    .filter((r) => r.schemaVersion === 2 && r.snapshot)
    .map((r) => ({ id: r.id, name: r.name, named: r.named ?? r.snapshot.named ?? false, createdAt: r.createdAt, updatedAt: r.updatedAt, thumbnail: r.thumbnail }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Phase 5.6 item 15: removes one artwork from this device — its document (with thumbnail) and its
 * undo history, in one transaction. */
export async function deleteArtwork(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(['documents', 'history'], 'readwrite');
    t.objectStore('documents').delete(id);
    t.objectStore('history').delete(id);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function saveHistory(record: HistoryRecord): Promise<void> {
  const db = await openDb();
  await tx(db, 'history', 'readwrite', (s) => s.put(record));
}

export async function loadHistory(docId: string): Promise<HistoryRecord | undefined> {
  const db = await openDb();
  return tx<HistoryRecord | undefined>(db, 'history', 'readonly', (s) => s.get(docId));
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  await tx(db, 'meta', 'readwrite', (s) => s.put({ key, value }));
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  const rec = await tx<{ key: string; value: T } | undefined>(db, 'meta', 'readonly', (s) => s.get(key));
  return rec?.value;
}
