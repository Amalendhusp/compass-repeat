// Project files: one artwork, complete and editable, as a single file that can be taken to another
// browser or device and opened there to keep working.
//
// What a project file holds: the artwork exactly as the app keeps it (Construct, Intersect and Repeat,
// Fair geometry, Fill and Space colours, interlacing, copy reflection, bookmarks, cameras and every
// appearance setting), the participant's name and attribution (never their email or phone), and the
// reference image, embedded. What it leaves out: the Undo history and the Timelapse (process) history.
//
// The file is JSON: `{ format, formatVersion, …, check, payload }`. `payload` is the artwork and its
// reference; Maps, Sets and non-finite numbers are written as `{__map}`, `{__set}` and `{__num}`
// (the same Map encoding as the developer import page). `check` is a 64-bit hash of the payload's
// exact JSON text — re-indenting the file doesn't change it, but any change to its content does, so
// a damaged or truncated file is refused rather than half-read.
//
// Reading a file never writes anything: `readProjectFile` parses, checks, validates and test-draws
// the artwork entirely in memory. Only `writeImportedArtwork` writes — always a NEW artwork with a new
// id (and, if needed, the reference as a new artwork-only image), never replacing anything stored.

import type { Doc, ParticipantInfo } from '../model/types.ts';
import { genId } from '../model/id.ts';
import { resolvePoint } from '../geometry/kernel.ts';
import { layerDoc } from '../geometry/intersectLayer.ts';
import { artworkHash } from './draft.ts';
import { makeThumbnail } from './thumbnail.ts';
import { saveDocument } from './db.ts';
import { addReference, deleteReference, getReference, getReferenceImage, listReferences, type ReferenceRecord } from './referenceStore.ts';
import { fitWithin, reduceTo } from '../reference/importReference.ts';

export const PROJECT_FORMAT = 'compass-repeat-project';
/** The format this version writes, and the newest it can read. */
export const PROJECT_VERSION = 1;
export const PROJECT_EXTENSION = 'compass-repeat.json';
/** Anything larger is not a project file (a 4096 px reference is at most a few tens of MB). */
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export class ProjectFileError extends Error {
  readonly title: string;
  constructor(title: string, message: string) {
    super(message);
    this.title = title;
  }
}

type ReferenceStatus = 'embedded' | 'missing' | 'none';

interface ProjectPayload {
  artwork: { name: string; named: boolean; createdAt: number; updatedAt: number; schemaVersion: number; snapshot: Doc };
  reference?: {
    id: string;
    name: string;
    sourceWidth: number;
    sourceHeight: number;
    width: number;
    height: number;
    type: string;
    /** The working copy as a data URL. */
    image: string;
  };
}

// ---- encoding ----

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) return { __map: [...value.entries()] };
  if (value instanceof Set) return { __set: [...value] };
  if (typeof value === 'number' && !Number.isFinite(value)) return { __num: String(value) };
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const keys = Object.keys(value);
  if (keys.length !== 1) return value;
  const v = value as Record<string, unknown>;
  if (keys[0] === '__map' && Array.isArray(v.__map) && v.__map.every((e) => Array.isArray(e) && e.length === 2)) return new Map(v.__map as [unknown, unknown][]);
  if (keys[0] === '__set' && Array.isArray(v.__set)) return new Set(v.__set);
  if (keys[0] === '__num' && (v.__num === 'Infinity' || v.__num === '-Infinity' || v.__num === 'NaN')) return Number(v.__num);
  return value;
}

/** A 64-bit hash of a string (two 32-bit lanes, cyrb53-style) — to notice damage, not for security. */
export function check64(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function dataUrlToBlob(url: string): Blob | null {
  const m = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(url);
  if (!m) return null;
  try {
    const bin = atob(m[2]!.replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: m[1]!.toLowerCase() });
  } catch {
    return null;
  }
}

/** Only the name and the attribution travel — never email or phone. Null: nothing left to keep. */
function shareableParticipant(p: ParticipantInfo | undefined): ParticipantInfo | null {
  if (!p || typeof p !== 'object') return null;
  const out: ParticipantInfo = {};
  if (typeof p.name === 'string' && p.name.trim()) out.name = p.name.slice(0, 120);
  const a = p.attribution;
  if (a && typeof a === 'object' && typeof a.text === 'string') out.attribution = { on: a.on === true, text: a.text.slice(0, 80) };
  return out.name !== undefined || out.attribution ? out : null;
}

// ---- writing a file ----

export interface BuiltProject {
  blob: Blob;
  bytes: number;
  reference: ReferenceStatus;
}

/** The project file for `doc` as it stands (the caller decides which version — the work in hand, or a
 * saved record). Nothing in `doc` is changed. */
export async function buildProjectFile(doc: Doc): Promise<BuiltProject> {
  const snapshot = structuredClone(doc);
  const participant = shareableParticipant(snapshot.participant);
  if (participant) snapshot.participant = participant;
  else delete snapshot.participant;

  let reference: ProjectPayload['reference'];
  let status: ReferenceStatus = 'none';
  if (snapshot.underlay) {
    const id = snapshot.underlay.refId;
    const [record, image] = await Promise.all([getReference(id).catch(() => undefined), getReferenceImage(id).catch(() => undefined)]);
    if (record && image) {
      reference = { id: record.id, name: record.name, sourceWidth: record.sourceWidth, sourceHeight: record.sourceHeight, width: record.width, height: record.height, type: record.type, image: await blobToDataUrl(image) };
      status = 'embedded';
    } else status = 'missing';
  }

  const payload: ProjectPayload = {
    artwork: { name: snapshot.name, named: snapshot.named, createdAt: snapshot.createdAt, updatedAt: snapshot.updatedAt, schemaVersion: snapshot.schemaVersion, snapshot },
    ...(reference ? { reference } : {}),
  };
  const payloadText = JSON.stringify(payload, replacer);
  const head = {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_VERSION,
    app: 'Compass Repeat',
    exportedAt: new Date().toISOString(),
    contains: { undoHistory: false, timelapseHistory: false, reference: status },
    check: { method: 'check64', value: check64(payloadText) },
  };
  // The payload goes in as the exact text that was checked.
  const text = `${JSON.stringify(head).slice(0, -1)},"payload":${payloadText}}`;
  const blob = new Blob([text], { type: 'application/json' });
  return { blob, bytes: blob.size, reference: status };
}

// ---- reading a file ----

export interface ProjectToImport {
  name: string;
  named: boolean;
  exportedAt: string | null;
  /** Upgraded, validated and test-drawn; its id is replaced when it is written. */
  snapshot: Doc;
  thumbnail: string;
  /** 'damaged': the file carried an image that can't be read — the artwork comes without it. */
  reference: { status: 'embedded'; record: Omit<ReferenceRecord, 'thumb' | 'addedAt' | 'bytes'>; image: Blob; thumb: Blob } | { status: 'missing' | 'damaged' | 'none' };
  /** The file carried contact details (email or phone) — left out. */
  contactDropped: boolean;
}

const damaged = (detail: string) =>
  new ProjectFileError('This project file is damaged', `${detail} Nothing on this device was changed.`);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isVec = (v: unknown) => isObj(v) && isNum(v.x) && isNum(v.y);

/** The shape every artwork must have before the app can open it; the first problem found, or null. */
export function snapshotProblem(d: unknown): string | null {
  if (!isObj(d)) return 'it holds no artwork';
  if (!isStr(d.id) || !isStr(d.name)) return 'the artwork has no name';
  if (d.schemaVersion !== 2) return 'the artwork is in a format this version does not know';
  const f = d.frame;
  if (!isObj(f) || !['circle', 'square', 'hexagon', 'triangle'].includes(f.kind as string) || !Array.isArray(f.entityIds) || !isStr(f.centreId) || !isVec(f.origin) || !isNum(f.radius) || !(f.radius > 0) || !isNum(f.rotation)) return 'its frame is incomplete';
  if (!Array.isArray(d.points) || !Array.isArray(d.entities)) return 'its points or lines are missing';
  const points = new Set<string>();
  for (const p of d.points) {
    if (!isObj(p) || !isStr(p.id) || !isStr(p.kind) || points.has(p.id)) return 'a point is damaged';
    if (p.kind === 'free' && !(isNum(p.x) && isNum(p.y))) return 'a point is damaged';
    points.add(p.id);
  }
  const entities = new Set<string>();
  for (const e of d.entities) {
    if (!isObj(e) || !isStr(e.id) || entities.has(e.id)) return 'a line or circle is damaged';
    if (e.kind === 'line' ? !(points.has(e.a as string) && points.has(e.b as string)) : e.kind === 'circle' ? !(points.has(e.centre as string) && points.has(e.through as string)) : true) return 'a line or circle is damaged';
    entities.add(e.id);
  }
  if (!points.has(f.centreId) || !(f.entityIds as unknown[]).every((id) => entities.has(id as string))) return 'its frame is incomplete';
  if (!(d.segmentStates instanceof Map)) return 'its Fair and trimmed pieces are missing';
  if (!(d.fills instanceof Map) || ![...d.fills.values()].every((m) => m instanceof Map)) return 'its fills are damaged';
  if (!Array.isArray(d.colourways) || !isStr(d.activeColourway)) return 'its fills are damaged';
  const r = d.repeat;
  if (!isObj(r) || !isVec(r.a) || !isVec(r.b) || !isObj(r.rule) || !isStr(r.rule.kind) || !isObj(r.motif)) return 'its Repeat settings are damaged';
  if (r.gapFills !== undefined && !(r.gapFills instanceof Map)) return 'its Space colours are damaged';
  if (!isObj(d.view) || !['construct', 'intersection', 'repeat'].includes(d.view.workspace as string)) return 'its view is damaged';
  if (d.intersectionSnapshots !== undefined && !Array.isArray(d.intersectionSnapshots)) return 'its bookmarks are damaged';
  if (d.underlay !== undefined && !(isObj(d.underlay) && isStr(d.underlay.refId) && isNum(d.underlay.aspect))) return 'its reference image placement is damaged';
  // Intersect's own construction: the same rules as Construct's, within itself.
  const ix = isObj(d.intersection) ? d.intersection : null;
  if (ix && ix.construction !== undefined) {
    const c = ix.construction;
    if (!isObj(c) || !Array.isArray(c.points) || !Array.isArray(c.entities) || !Array.isArray(c.segmentStates)) return 'its Intersect construction is damaged';
    const pts = new Set<string>();
    for (const p of c.points) {
      if (!isObj(p) || !isStr(p.id) || !isStr(p.kind) || pts.has(p.id) || (p.kind === 'free' && !(isNum(p.x) && isNum(p.y)))) return 'its Intersect construction is damaged';
      pts.add(p.id);
    }
    for (const e of c.entities) {
      if (!isObj(e) || !isStr(e.id)) return 'its Intersect construction is damaged';
      if (e.kind === 'line' ? !(pts.has(e.a as string) && pts.has(e.b as string)) : e.kind === 'circle' ? !(pts.has(e.centre as string) && pts.has(e.through as string)) : true) return 'its Intersect construction is damaged';
    }
    if (!c.segmentStates.every((x) => Array.isArray(x) && x.length === 2 && isStr(x[0]) && isObj(x[1]))) return 'its Intersect construction is damaged';
  }
  return null;
}

async function readImage(blob: Blob): Promise<ImageBitmap | null> {
  if (!IMAGE_TYPES.includes(blob.type) || blob.size === 0) return null;
  try {
    const bmp = await createImageBitmap(blob);
    if (!bmp.width || !bmp.height) {
      bmp.close();
      return null;
    }
    return bmp;
  } catch {
    return null;
  }
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.82));
}

/**
 * Reads and checks a project file entirely in memory. Throws ProjectFileError (with a title and a
 * plain message) for anything that isn't a readable project file this version can open. `upgrade`
 * brings an artwork saved by any earlier version up to date (the app's own upgrade, as on opening).
 */
export async function readProjectFile(file: Blob, upgrade: (doc: Doc, named: boolean | undefined) => void): Promise<ProjectToImport> {
  if (file.size > MAX_FILE_BYTES) throw new ProjectFileError('This isn’t a project file', 'The file is far too large to be a Compass Repeat project file. Nothing on this device was changed.');
  if (file.size === 0) throw damaged('The file is empty.');
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    // A project file always starts with its format name; anything else is another kind of file.
    const start = await file.slice(0, 64).text().catch(() => '');
    if (start.includes(PROJECT_FORMAT)) throw damaged('The file is incomplete or can’t be read — it may have been cut short while it was copied.');
    throw new ProjectFileError('This isn’t a project file', 'Choose a file saved with Save project file… (its name ends in .compass-repeat.json). Nothing on this device was changed.');
  }
  if (!isObj(raw) || raw.format !== PROJECT_FORMAT) throw new ProjectFileError('This isn’t a project file', 'Choose a file saved with Save project file… (its name ends in .compass-repeat.json). Nothing on this device was changed.');
  const version = raw.formatVersion;
  if (!Number.isInteger(version) || (version as number) < 1) throw damaged('Its version is missing.');
  if ((version as number) > PROJECT_VERSION)
    throw new ProjectFileError('Made with a newer Compass Repeat', `This project file uses a newer format (version ${version}) than this copy of the app can open (version ${PROJECT_VERSION}). Reload the app to update it, then try again. Nothing on this device was changed.`);
  if (!isObj(raw.check) || raw.check.method !== 'check64' || !isStr(raw.check.value) || !isObj(raw.payload)) throw damaged('Part of the file is missing.');
  const payloadText = JSON.stringify(raw.payload);
  if (check64(payloadText) !== raw.check.value) throw damaged('Its contents have changed since it was saved, so it can’t be opened safely.');

  const payload = JSON.parse(payloadText, reviver) as ProjectPayload;
  const art = payload.artwork as unknown;
  if (!isObj(art) || !isObj(art.snapshot)) throw damaged('It holds no artwork.');
  const snapshot = art.snapshot as unknown as Doc;
  const problem = snapshotProblem(snapshot);
  if (problem) throw damaged(`It can’t be opened: ${problem}.`);

  // Contact details never come in, whatever a file carries.
  const contactDropped = !!snapshot.participant && (snapshot.participant.email !== undefined || snapshot.participant.phone !== undefined);
  const participant = shareableParticipant(snapshot.participant);
  if (participant) snapshot.participant = participant;
  else delete snapshot.participant;

  const named = art.named === true || snapshot.named === true;
  let thumbnail: string;
  try {
    upgrade(snapshot, named);
    // A test drawing: every point resolves, the artwork state can be fingerprinted, and it draws.
    for (const p of snapshot.points) {
      const w = resolvePoint(snapshot, p.id);
      if (!w || !Number.isFinite(w.x) || !Number.isFinite(w.y)) {
        // An intersection that no longer meets is allowed (the app shows it as it does now); a
        // point with no position at all is not.
        if (p.kind === 'free') throw new Error('point');
      }
    }
    // Intersect's own construction resolves too (a point it can't place fails here).
    if (snapshot.intersection?.construction) {
      const L = layerDoc(snapshot);
      for (const p of L.points) resolvePoint(L, p.id);
    }
    artworkHash(snapshot);
    thumbnail = makeThumbnail(snapshot);
  } catch {
    throw damaged('Its artwork can’t be drawn.');
  }

  let reference: ProjectToImport['reference'] = { status: snapshot.underlay ? 'missing' : 'none' };
  const ref = payload.reference as unknown;
  if (snapshot.underlay && isObj(ref)) {
    const image = isStr(ref.image) ? dataUrlToBlob(ref.image) : null;
    const bmp = image ? await readImage(image) : null;
    if (!image || !bmp) reference = { status: 'damaged' };
    else {
      const thumbSize = fitWithin(bmp.width, bmp.height, 256);
      const canvas = reduceTo(bmp, bmp.width, bmp.height, thumbSize.w, thumbSize.h, '#fbf9f5');
      const thumb = await canvasBlob(canvas);
      const record = {
        id: isStr(ref.id) ? ref.id : '',
        name: isStr(ref.name) && ref.name.trim() ? ref.name.slice(0, 200) : 'Reference',
        sourceWidth: isNum(ref.sourceWidth) ? ref.sourceWidth : bmp.width,
        sourceHeight: isNum(ref.sourceHeight) ? ref.sourceHeight : bmp.height,
        width: bmp.width,
        height: bmp.height,
        type: image.type,
      };
      bmp.close();
      canvas.width = canvas.height = 0;
      reference = thumb ? { status: 'embedded', record, image, thumb } : { status: 'damaged' };
    }
  }

  return {
    name: isStr(art.name) && art.name.trim() ? art.name.trim().slice(0, 120) : snapshot.name,
    named,
    exportedAt: isStr(raw.exportedAt) ? raw.exportedAt : null,
    snapshot,
    thumbnail,
    reference,
    contactDropped,
  };
}

/** The id of an image this device already holds that is byte for byte `image` (the same id first),
 * or null. Only images of the same size are read. */
async function sameImageHere(id: string, image: Blob, width: number, height: number): Promise<string | null> {
  const all = await listReferences().catch(() => [] as ReferenceRecord[]);
  const candidates = all.filter((r) => r.bytes === image.size && r.width === width && r.height === height).sort((a, b) => Number(b.id === id) - Number(a.id === id));
  if (!candidates.length) return null;
  const want = new Uint8Array(await image.arrayBuffer());
  for (const r of candidates) {
    const blob = await getReferenceImage(r.id).catch(() => undefined);
    if (!blob || blob.size !== want.length) continue;
    const have = new Uint8Array(await blob.arrayBuffer());
    let equal = true;
    for (let i = 0; i < want.length; i++) if (have[i] !== want[i]) { equal = false; break; }
    if (equal) return r.id;
  }
  return null;
}

/**
 * Writes an imported artwork as a NEW artwork: a new id, the given name, created and edited now, no
 * Undo or Timelapse history. Its reference image is reused only when this device already holds that
 * very image (byte for byte); otherwise it is added as a new image for this artwork alone. If the
 * artwork can't be written, an image added for it is taken out again — nothing else is ever touched.
 * Returns the new artwork's id.
 */
export async function writeImportedArtwork(p: ProjectToImport, name: string): Promise<string> {
  const doc = structuredClone(p.snapshot);
  const now = Date.now();
  doc.id = genId('doc');
  doc.name = name;
  doc.named = p.named || name !== p.snapshot.name;
  doc.createdAt = now;
  doc.updatedAt = now;

  let addedRef: string | null = null;
  if (p.reference.status === 'embedded' && doc.underlay) {
    const { record, image, thumb } = p.reference;
    const existing = await sameImageHere(record.id, image, record.width, record.height);
    if (existing) doc.underlay.refId = existing;
    else {
      const id = `ref_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      await addReference({ ...record, id, addedAt: now, bytes: image.size, thumb, scope: 'artwork' }, image);
      addedRef = id;
      doc.underlay.refId = id;
    }
  }
  try {
    await saveDocument({ id: doc.id, name: doc.name, named: doc.named, createdAt: now, updatedAt: now, schemaVersion: 2, thumbnail: p.thumbnail || undefined, snapshot: doc });
  } catch (e) {
    if (addedRef) await deleteReference(addedRef).catch(() => {});
    throw e;
  }
  return doc.id;
}

/** "1.4 MB", "820 KB". */
export function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
