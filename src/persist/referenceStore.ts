// The Reference Library: reference images, kept for the whole app (not for one artwork) in their
// own IndexedDB database — beside the artworks' database, never inside it — so an artwork only
// ever holds a reference's id (Doc.underlay), and its undo history and process history never carry
// image data. Two stores: `references` (what the library shows — size, name, a small thumbnail)
// and `images` (the 4096 px working copy, read only when a reference is actually shown).

import { openDb as openArtworksDb, type DocumentRecord } from './db.ts';

const DB_NAME = 'construct-and-repeat-references';
const DB_VERSION = 1;

export interface ReferenceRecord {
  id: string;
  name: string;
  addedAt: number;
  /** The image as imported (after its orientation is applied) — its true proportions. */
  sourceWidth: number;
  sourceHeight: number;
  /** The working copy kept (at most 4096 px on its long side). */
  width: number;
  height: number;
  type: string;
  bytes: number;
  thumb: Blob;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('references')) db.createObjectStore('references', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

/** Every reference in the library, newest first (thumbnails only — no full images). */
export async function listReferences(): Promise<ReferenceRecord[]> {
  const db = await openDb();
  const all = await new Promise<ReferenceRecord[]>((resolve, reject) => {
    const req = db.transaction('references', 'readonly').objectStore('references').getAll();
    req.onsuccess = () => resolve(req.result as ReferenceRecord[]);
    req.onerror = () => reject(req.error);
  });
  return all.sort((a, b) => b.addedAt - a.addedAt);
}

export async function getReference(id: string): Promise<ReferenceRecord | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('references', 'readonly').objectStore('references').get(id);
    req.onsuccess = () => resolve(req.result as ReferenceRecord | undefined);
    req.onerror = () => reject(req.error);
  });
}

/** A reference's working copy, or undefined if the library no longer has it. */
export async function getReferenceImage(id: string): Promise<Blob | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('images', 'readonly').objectStore('images').get(id);
    req.onsuccess = () => resolve((req.result as { id: string; blob: Blob } | undefined)?.blob);
    req.onerror = () => reject(req.error);
  });
}

/** Adds a reference — its record and its image together, or neither (a full store adds nothing). */
export async function addReference(record: ReferenceRecord, image: Blob): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(['references', 'images'], 'readwrite');
    t.objectStore('references').put(record);
    t.objectStore('images').put({ id: record.id, blob: image });
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  // Ask once that the browser keep this site's storage (the artworks already ask the same).
  navigator.storage?.persist?.().catch(() => {});
}

/** Removes a reference — its record and its image together. Artworks that use it are not touched:
 * they keep its id (and their placement for it) and show it as missing. */
export async function deleteReference(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(['references', 'images'], 'readwrite');
    t.objectStore('references').delete(id);
    t.objectStore('images').delete(id);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/** The names of the saved artworks that use a reference (read only — nothing is changed). `open`
 * is the artwork open now, whose latest state may not be saved yet. */
export async function artworksUsing(id: string, open?: { id: string; name: string; underlay?: { refId: string } }): Promise<string[]> {
  const db = await openArtworksDb();
  const records = await new Promise<DocumentRecord[]>((resolve, reject) => {
    const req = db.transaction('documents', 'readonly').objectStore('documents').getAll();
    req.onsuccess = () => resolve(req.result as DocumentRecord[]);
    req.onerror = () => reject(req.error);
  });
  const names = new Map<string, string>();
  for (const r of records) if (r.snapshot?.underlay?.refId === id) names.set(r.id, r.name);
  if (open) {
    if (open.underlay?.refId === id) names.set(open.id, open.name);
    else names.delete(open.id);
  }
  return [...names.values()];
}
