// vNext Phase 4A: where process histories live — a database of their own, beside (never inside)
// the artworks database. The artworks database keeps its version, stores and records exactly as
// they were: My Artworks reads only `documents` there, so a long history never slows it down, and
// an older build that opens the artworks database never meets an unfamiliar version.
//
//   processes  — one summary per artwork (keyPath docId)
//   events     — one record per process moment (keyPath [docId, seq]); each holds either a patch
//                from the previous moment or, now and then, a full keyframe
//
// Every write goes through one queue, in order, so a Save As copy always sees every moment
// recorded before it.

import type { ArtworkState, PatchOp, ProcessSource } from './processState.ts';

const DB_NAME = 'construct-and-repeat-process';
const DB_VERSION = 1;

export interface ProcessMeta {
  docId: string;
  format: number;
  /** 'new': recorded from the artwork's first frame. 'existing': the artwork predates process
   * history (or was copied from one that did) — recording starts from a baseline of how it was. */
  origin: 'new' | 'existing';
  startedAt: number;
  /** Save As: the artwork this history was copied from, and up to which moment. */
  copiedFrom?: string;
  copiedAtSeq?: number;
  headSeq: number;
  headHash: string;
  keyframeSeq: number;
  keyframeBytes: number;
  sinceKeyframe: { events: number; bytes: number };
  events: number;
  bytes: number;
  /** Moments where the saved artwork no longer matched the recorded history (edited elsewhere, or
   * a write lost), each bridged by a fresh keyframe. */
  gaps: number;
}

export interface ProcessEvent {
  docId: string;
  seq: number;
  at: number;
  source: ProcessSource;
  kind: string;
  tags: string[];
  /** Fingerprint of the artwork state after this moment. */
  hash: string;
  patch?: PatchOp[];
  keyframe?: ArtworkState;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openProcessDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('processes')) db.createObjectStore('processes', { keyPath: 'docId' });
      if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: ['docId', 'seq'] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const done = (t: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
const result = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const range = (docId: string) => IDBKeyRange.bound([docId, 0], [docId, Number.MAX_SAFE_INTEGER]);

let queue: Promise<unknown> = Promise.resolve();

/** Runs `job` after every job queued before it; a failure is logged, never blocks the next one. */
export function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job);
  queue = run.catch((e) => console.warn('process history:', e));
  return run;
}

export async function loadMeta(docId: string): Promise<ProcessMeta | undefined> {
  const db = await openProcessDb();
  return result(db.transaction('processes').objectStore('processes').get(docId));
}

/** Writes moments and the updated summary together, in one transaction. */
export async function writeEvents(meta: ProcessMeta, events: ProcessEvent[]): Promise<void> {
  const db = await openProcessDb();
  const t = db.transaction(['processes', 'events'], 'readwrite');
  for (const e of events) t.objectStore('events').put(e);
  t.objectStore('processes').put(meta);
  await done(t);
}

export async function loadEvents(docId: string): Promise<ProcessEvent[]> {
  const db = await openProcessDb();
  return result(db.transaction('events').objectStore('events').getAll(range(docId)));
}

/** Save As: the new artwork starts with its own copy of the whole history so far. */
export function copyProcess(fromId: string, toId: string): Promise<void> {
  return enqueue(async () => {
    const meta = await loadMeta(fromId);
    if (!meta) return;
    const events = await loadEvents(fromId);
    await writeEvents({ ...meta, docId: toId, copiedFrom: fromId, copiedAtSeq: meta.headSeq }, events.map((e) => ({ ...e, docId: toId })));
  });
}

export function deleteProcess(docId: string): Promise<void> {
  return enqueue(async () => {
    const db = await openProcessDb();
    const t = db.transaction(['processes', 'events'], 'readwrite');
    t.objectStore('processes').delete(docId);
    t.objectStore('events').delete(range(docId));
    await done(t);
  });
}

/** Every artwork with a history (summaries only). */
export async function listProcesses(): Promise<ProcessMeta[]> {
  const db = await openProcessDb();
  return result(db.transaction('processes').objectStore('processes').getAll());
}
