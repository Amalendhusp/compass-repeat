// vNext Phase 4A: the artwork's process history — what a "state" is, and how two states differ.
//
// An ArtworkState is the part of a document that makes up the artwork itself: frame, points,
// entities, segment states (construction / Fair / trimmed, with strokes), fills, the Repeat system
// and Repeat's appearance. Never the camera, workspace, guides, tool preferences, name or
// timestamps — changing those is not a step in the design process.
//
// History is stored as data about the document, not as gestures: a patch says which values became
// what, so replaying it never re-runs the geometry engine, and a future engine can't change what an
// old history reconstructs.
//
// Ordered collections (points, entities, segment states, fills) are kept as an order list plus a
// table of values by key. That lets a patch say "these were added after X, these removed, this one
// changed" compactly, while still reproducing the exact order the document had.

import type { Doc } from '../model/types.ts';

export const PROCESS_FORMAT = 1;

/** An ordered keyed collection: `$o` is the order, `$v` the values by key. */
export interface Coll {
  $o: string[];
  $v: Record<string, unknown>;
}

export interface ArtworkState {
  format: number;
  schemaVersion: number;
  frame: unknown;
  points: Coll;
  entities: Coll;
  segmentStates: Coll;
  fills: Coll; // colourway → Coll of face → colour
  colourways: unknown;
  activeColourway: string;
  symmetrySources: unknown;
  echo: unknown;
  repeat: Record<string, unknown> & { gapFills: Coll };
  appearance: { artwork: string; constructionOverlay: boolean; background: string; fillOpacity: number };
}

// A captured state is built with every object's keys already in sorted order, so plain
// JSON.stringify of it IS its canonical form — the fast way to fingerprint it while recording. One
// exception: JavaScript always orders integer-like keys ("12") first, numerically, whatever the
// insertion order, so a collection with such keys marks its state as needing the slow form.
const INTEGER_KEY = /^(0|[1-9]\d*)$/;
const needsCanonical = new WeakSet<object>();
let capturing: object | null = null;

/** A deep plain copy — objects and arrays only, undefined dropped, keys sorted. */
function plain(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(plain);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).sort()) {
    const x = (v as Record<string, unknown>)[k];
    if (x !== undefined) out[k] = plain(x);
  }
  return out;
}

function sortedValues(keys: string[], value: (k: string) => unknown): Record<string, unknown> {
  const $v: Record<string, unknown> = {};
  for (const k of [...keys].sort()) {
    if (capturing && INTEGER_KEY.test(k)) needsCanonical.add(capturing);
    $v[k] = value(k);
  }
  return $v;
}

/** Points and entities by id; the id is the key, so it isn't stored again inside the value. */
function byId(items: { id: string }[]): Coll {
  const index = new Map(items.map((it) => [it.id, it]));
  const ids = items.map((it) => it.id);
  return {
    $o: ids,
    $v: sortedValues(ids, (id) => {
      const { id: _id, ...rest } = index.get(id)!;
      return plain(rest);
    }),
  };
}

function fromMap<V>(m: Map<string, V>, value: (v: V) => unknown = plain): Coll {
  const keys = [...m.keys()];
  return { $o: keys, $v: sortedValues(keys, (k) => value(m.get(k)!)) };
}

/** The only artwork fields ever changed in place (without a commit replacing the document):
 * Repeat's own setup and its appearance. Everything else a committed document holds is never
 * mutated again, so a recorder can snapshot just these at once and capture the rest later. */
export interface InPlaceParts {
  repeat: Record<string, unknown>;
  appearance: ArtworkState['appearance'];
}

export function inPlaceParts(doc: Doc): InPlaceParts {
  const { gapFills: _gaps, ...repeat } = doc.repeat;
  const d = doc.repeatDisplay;
  return {
    repeat: plain(repeat) as Record<string, unknown>,
    appearance: { artwork: d.artwork, background: d.background, constructionOverlay: d.constructionOverlay, fillOpacity: d.fillOpacity },
  };
}

/** The artwork part of a document, as plain data (keys in sorted order throughout). `parts`, if
 * given, are the in-place fields as they were when the moment happened. */
export function captureState(doc: Doc, parts: InPlaceParts = inPlaceParts(doc)): ArtworkState {
  const marker = {};
  capturing = marker;
  const state = {
    activeColourway: doc.activeColourway,
    appearance: { ...parts.appearance },
    colourways: plain(doc.colourways),
    echo: plain(doc.echo),
    entities: byId(doc.entities),
    fills: fromMap(doc.fills, (faces) => fromMap(faces)),
    format: PROCESS_FORMAT,
    frame: plain(doc.frame),
    points: byId(doc.points),
    repeat: plain({ ...parts.repeat, gapFills: null }) as Record<string, unknown> & { gapFills: Coll },
    schemaVersion: doc.schemaVersion,
    segmentStates: fromMap(doc.segmentStates),
    symmetrySources: plain(doc.symmetrySources),
  } satisfies ArtworkState;
  state.repeat.gapFills = fromMap(doc.repeat.gapFills);
  capturing = null;
  if (needsCanonical.has(marker)) needsCanonical.add(state);
  return state;
}

/** The fingerprint of a state as captured — the same value stateHash() gives, computed fast. */
export function capturedHash(state: ArtworkState): { hash: string; bytes: number } {
  const text = needsCanonical.has(state) ? canonical(state) : JSON.stringify(state);
  return { hash: fingerprint(text), bytes: text.length };
}

/** The in-place artwork fields (changed without a commit): Repeat's own setup and appearance. */
export function inPlaceFingerprint(doc: Doc): string {
  const { gapFills: _gaps, ...repeat } = doc.repeat;
  const d = doc.repeatDisplay;
  return JSON.stringify([repeat, d.artwork, d.constructionOverlay, d.background, d.fillOpacity]);
}

const toList = (c: Coll) => c.$o.map((k) => ({ id: k, ...(structuredClone(c.$v[k]) as object) }));
const toMap = <V>(c: Coll, value: (v: unknown) => V = (v) => structuredClone(v) as V) => new Map(c.$o.map((k) => [k, value(c.$v[k])]));

/** A full document showing `state`, taking everything that isn't artwork from `base`. */
export function stateToDoc(state: ArtworkState, base: Doc): Doc {
  const repeat = structuredClone(state.repeat) as Record<string, unknown>;
  return {
    ...base,
    schemaVersion: state.schemaVersion as Doc['schemaVersion'],
    frame: structuredClone(state.frame) as Doc['frame'],
    points: toList(state.points) as Doc['points'],
    entities: toList(state.entities) as Doc['entities'],
    segmentStates: toMap(state.segmentStates),
    fills: toMap(state.fills, (faces) => toMap(faces as Coll)),
    colourways: structuredClone(state.colourways) as Doc['colourways'],
    activeColourway: state.activeColourway,
    symmetrySources: structuredClone(state.symmetrySources) as Doc['symmetrySources'],
    echo: structuredClone(state.echo) as Doc['echo'],
    repeat: { ...(repeat as unknown as Doc['repeat']), gapFills: toMap(state.repeat.gapFills) },
    repeatDisplay: { ...base.repeatDisplay, ...state.appearance } as Doc['repeatDisplay'],
  };
}

// ---- canonical fingerprint ----

/** JSON with object keys sorted, so equal states always give the same string. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const keys = Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** Two independent 32-bit hashes of the canonical form, plus its length. */
export function fingerprint(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 5381;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = (Math.imul(h2, 33) + c) | 0;
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}:${text.length}`;
}

export const stateHash = (s: ArtworkState) => fingerprint(canonical(s));

// ---- patches ----

/** ['s', path, value] set · ['d', path] delete · ['o', path, removed, [id, after][]] reorder. */
export type PatchOp = ['s', string[], unknown] | ['d', string[]] | ['o', string[], string[], [string, string | null][]];

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isColl = (v: unknown): v is Coll => isObj(v) && Array.isArray(v.$o) && isObj(v.$v);

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => same(x, bb[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => k in (b as object) && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Applies a reorder op to an order list. */
function reorder(order: string[], removed: string[], inserted: [string, string | null][]): string[] {
  const gone = new Set(removed);
  const after = new Map<string | null, string[]>();
  for (const [id, anchor] of inserted) {
    const list = after.get(anchor);
    if (list) list.push(id);
    else after.set(anchor, [id]);
  }
  const out: string[] = [];
  const emit = (start: string | null) => {
    // Iterative: an inserted id can itself be the anchor of the next one (a long run of appends).
    const stack = [...(after.get(start) ?? [])].reverse();
    while (stack.length) {
      const id = stack.pop()!;
      out.push(id);
      const next = after.get(id);
      if (next) for (let i = next.length - 1; i >= 0; i--) stack.push(next[i]!);
    }
  };
  emit(null);
  for (const id of order) {
    if (gone.has(id)) continue;
    out.push(id);
    emit(id);
  }
  return out;
}

function diffOrder(a: string[], b: string[], path: string[], ops: PatchOp[]): void {
  if (a.length === b.length && a.every((x, i) => x === b[i])) return;
  const inA = new Set(a);
  const inB = new Set(b);
  const removed = a.filter((x) => !inB.has(x));
  const inserted: [string, string | null][] = [];
  b.forEach((x, i) => {
    if (!inA.has(x)) inserted.push([x, i === 0 ? null : b[i - 1]!]);
  });
  const rebuilt = reorder(a, removed, inserted);
  // Common items moved relative to each other: say the whole order instead (never inexact).
  if (rebuilt.length === b.length && rebuilt.every((x, i) => x === b[i])) ops.push(['o', path, removed, inserted]);
  else ops.push(['s', path, b]);
}

function diffValue(a: unknown, b: unknown, path: string[], ops: PatchOp[]): void {
  if (isColl(a) && isColl(b)) {
    diffOrder(a.$o, b.$o, [...path, '$o'], ops);
    diffValue(a.$v, b.$v, [...path, '$v'], ops);
    return;
  }
  if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(b)) {
      if (!(k in a)) ops.push(['s', [...path, k], b[k]]);
      else diffValue(a[k], b[k], [...path, k], ops);
    }
    for (const k of Object.keys(a)) if (!(k in b)) ops.push(['d', [...path, k]]);
    return;
  }
  if (!same(a, b)) ops.push(['s', path, b]);
}

/** What turns `a` into `b`. Empty when nothing about the artwork changed. */
export function diffStates(a: ArtworkState, b: ArtworkState): PatchOp[] {
  const ops: PatchOp[] = [];
  diffValue(a, b, [], ops);
  return ops;
}

/** Applies a patch to a state in place. */
export function applyPatch(state: ArtworkState, ops: PatchOp[]): void {
  for (const op of ops) {
    const path = op[1];
    let parent = state as unknown as Record<string, unknown>;
    for (let i = 0; i < path.length - 1; i++) parent = parent[path[i]!] as Record<string, unknown>;
    const last = path[path.length - 1]!;
    if (op[0] === 's') parent[last] = structuredClone(op[2]);
    else if (op[0] === 'd') delete parent[last];
    else parent[last] = reorder(parent[last] as string[], op[2], op[3]);
  }
}

// ---- what kind of moment it was ----

export type ProcessSource = 'baseline' | 'commit' | 'undo' | 'redo' | 'cancel' | 'in-place' | 'resync';

/** A broad category plus detail tags, read off what changed — never from which tool was active. */
export function describeChange(a: ArtworkState, b: ArtworkState, source: ProcessSource): { kind: string; tags: string[] } {
  const tags: string[] = [];
  const added = (c1: Coll, c2: Coll) => c2.$o.filter((k) => !(k in c1.$v));
  const removed = (c1: Coll, c2: Coll) => c1.$o.filter((k) => !(k in c2.$v));
  const changed = (c1: Coll, c2: Coll) => c2.$o.filter((k) => k in c1.$v && !same(c1.$v[k], c2.$v[k]));

  const newEntities = added(a.entities, b.entities).map((k) => ({ ...(b.entities.$v[k] as { kind: string }), id: k }));
  const newPoints = added(a.points, b.points).map((k) => b.points.$v[k] as { kind: string; host?: string; arcEnd?: boolean });
  for (const e of newEntities) {
    const isArc = e.kind === 'circle' && newPoints.some((p) => p.arcEnd && p.host === e.id);
    tags.push(isArc ? 'arc' : e.kind);
  }
  if (newPoints.some((p) => p.kind === 'division')) tags.push('divide');
  if (removed(a.entities, b.entities).length) tags.push('delete');
  if (!newEntities.length && changed(a.points, b.points).length) tags.push('edit-point');
  if (!newEntities.length && changed(a.entities, b.entities).length) tags.push('edit');

  const st = (c: Coll, k: string) => (c.$v[k] as { state?: string } | undefined)?.state ?? 'construction';
  const segKeys = new Set([...a.segmentStates.$o, ...b.segmentStates.$o]);
  for (const k of segKeys) {
    const before = st(a.segmentStates, k);
    const after = st(b.segmentStates, k);
    if (before === after) {
      if (after === 'fair' && !same(a.segmentStates.$v[k], b.segmentStates.$v[k])) tags.push('stroke');
      continue;
    }
    // Only an existing segment's change counts here — a new entity's own segments come with it.
    if (newEntities.some((e) => k.startsWith(`${e.id}:`))) continue;
    tags.push(after === 'fair' ? 'fair' : before === 'fair' ? 'unfair' : after === 'trimmed' ? 'trim' : 'segment');
  }
  if (!same(a.fills, b.fills)) tags.push('fill');

  const ra = a.repeat;
  const rb = b.repeat;
  if (ra.family !== rb.family) tags.push(ra.family === undefined ? 'repeat-setup' : 'repeat-family');
  else if (!same(ra.a, rb.a) || !same(ra.b, rb.b) || ra.rowOffset !== rb.rowOffset) tags.push('repeat-spacing');
  if (!same(ra.motif, rb.motif)) tags.push('repeat-rotation');
  if (!same(ra.rule, rb.rule)) tags.push('repeat-rule');
  if (!same(ra.gapFills, rb.gapFills)) tags.push('repeat-space');
  if (!same(a.appearance, b.appearance)) tags.push('appearance');

  const unique = [...new Set(tags)];
  if (source === 'undo' || source === 'redo' || source === 'baseline' || source === 'resync') return { kind: source, tags: unique };
  const priority = ['arc', 'circle', 'line', 'divide', 'delete', 'trim', 'fair', 'unfair', 'stroke', 'fill', 'edit-point', 'edit', 'repeat-setup', 'repeat-family', 'repeat-spacing', 'repeat-rotation', 'repeat-rule', 'repeat-space', 'appearance', 'segment'];
  return { kind: priority.find((t) => unique.includes(t)) ?? 'other', tags: unique };
}
