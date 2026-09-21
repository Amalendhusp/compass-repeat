// Document construction and mutation: frame creation (§4.1), the entity/point additions that
// keep intersections materialized as explicit points (§5.2), and — Phase 2 — Divide, Trim/
// Restore, whole-entity Delete and Polygon grouping.

import type { Doc, Entity, EntityId, FaceSig, FrameKind, Point, PointId, SegmentKey, Vec2 } from './types.ts';
import { genId } from './id.ts';
import { epsilon, frameVertexCount, intersectEntities, pairKey, projectOntoEntity, resolvePoint } from '../geometry/kernel.ts';
import { dist } from '../geometry/vec.ts';
import { withSegmentMigration } from '../geometry/segmentstate.ts';
import { deriveSegments, isParamTrimmed } from '../geometry/segments.ts';
import { circleDivisionPositions, segmentDivisionPositions, type SegmentSpan } from '../geometry/divide.ts';
import { isEditablePointKind } from '../geometry/usage.ts';
import { color, fairPalette, stroke } from '../render/tokens.ts';

/** §4.1 §Phase 1.1: the frame is drawn by the participant, not auto-placed — see interaction/drawframe.ts. */
export function placeFrame(doc: Doc, origin: Vec2, radius: number, rotation: number): void {
  doc.frame.origin = origin;
  doc.frame.radius = radius;
  doc.frame.rotation = rotation;
  const centreId = genId('pt');
  if (doc.frame.kind === 'circle') {
    const throughId = genId('pt');
    const circleId = genId('en');
    doc.points.push({
      id: throughId,
      kind: 'free',
      x: doc.frame.origin.x + doc.frame.radius * Math.cos(doc.frame.rotation),
      y: doc.frame.origin.y + doc.frame.radius * Math.sin(doc.frame.rotation),
      hidden: true,
    });
    doc.entities.push({ id: circleId, kind: 'circle', centre: centreId, through: throughId, locked: true });
    doc.frame.entityIds = [circleId];
  } else {
    const n = frameVertexCount(doc.frame.kind);
    const vertexIds: PointId[] = [];
    for (let i = 0; i < n; i++) {
      const id = genId('pt');
      vertexIds.push(id);
      doc.points.push({ id, kind: 'frame-vertex', index: i });
    }
    const edgeIds: EntityId[] = [];
    for (let i = 0; i < n; i++) {
      const id = genId('en');
      edgeIds.push(id);
      doc.entities.push({
        id,
        kind: 'line',
        a: vertexIds[i]!,
        b: vertexIds[(i + 1) % n]!,
        extended: false,
        locked: true,
      });
    }
    doc.frame.entityIds = edgeIds;
  }
  doc.points.push({ id: centreId, kind: 'centre', entity: doc.frame.entityIds[0]! });
  doc.frame.centreId = centreId;
}

let untitledCounter = 0;

export function createDoc(frameKind: FrameKind, name?: string): Doc {
  const now = Date.now();
  untitledCounter += 1;
  const doc: Doc = {
    id: genId('doc'),
    name: name ?? `Untitled ${untitledCounter}`,
    schemaVersion: 2,
    // Placeholder until placeFrame() runs at the end of the draw-frame gesture (§Phase 1.1 item 1).
    frame: {
      kind: frameKind,
      entityIds: [],
      centreId: '',
      designEnabled: false,
      origin: { x: 0, y: 0 },
      radius: 0,
      rotation: 0,
    },
    points: [],
    entities: [],
    segmentStates: new Map(),
    fills: new Map(),
    colourways: [{ id: 'A', name: 'A' }],
    activeColourway: 'A',
    symmetrySources: [],
    echo: { mode: 'off', mirrors: true },
    repeat: {
      a: { x: 1, y: 0 },
      b: { x: 0, y: 1 },
      rowOffset: 0,
      motif: { rotation: 0, scale: 1 },
      rule: { kind: 'same' },
      footprint: 'design',
      overlap: 'stack',
      showStrokes: true,
      gapFills: new Map(),
    },
    view: { zoom: 1, pan: { x: 0, y: 0 }, workspace: 'construct' },
    pointTargets: { primary: true, derived: true, free: false },
    fairDefaults: { colour: color.ink, width: stroke.fairDefault },
    dividePrefs: { lastN: 6 },
    fillDefaults: { colour: fairPalette[0]!.colour },
    repeatView: { zoom: 1, pan: { x: 0, y: 0 } },
    repeatGuide: true,
    createdAt: now,
    updatedAt: now,
  };
  return doc;
}

/**
 * Phase 2.2 item 1 fix: a hidden free point (a circle's own internal through-point, or the
 * circle frame's — types.ts: "has no user-facing role") must never stand in for a real
 * construction point. Without this guard, a division point (or an intersection) landing exactly
 * on a circle's own through-point angle — which is exactly what happens at a division's anchor
 * angle for the frame circle, since placeFrame puts the through-point there too — silently
 * merged into the hidden point instead of becoming its own `kind: 'division'` point: the ID it
 * returned was real and stayed in doc.points, but with the WRONG kind, so `N division points
 * created` read as `N - 1` even though nothing was actually deleted.
 */
function mergeOrCreatePoint(doc: Doc, at: Vec2, build: (id: PointId) => Point): PointId {
  const eps = epsilon(doc);
  for (const existing of doc.points) {
    if (existing.kind === 'free' && existing.hidden) continue;
    if (dist(resolvePoint(doc, existing.id), at) < eps) return existing.id;
  }
  const id = genId('pt');
  doc.points.push(build(id));
  return id;
}

/** Adds an entity and materializes its intersections with every existing entity as explicit
 * points — migrating segment state on every entity a new intersection lands on (§Phase 2B).
 * Phase 2.1 item 4 (true Trim): a location inside an already-trimmed segment of an existing
 * entity is skipped — a removed arc/line piece must not generate new intersections. */
export function addEntity(doc: Doc, build: (id: EntityId) => Entity): Entity {
  const entity = build(genId('en'));
  const others = doc.entities.slice();
  withSegmentMigration(doc, [...others.map((e) => e.id), entity.id], () => {
    doc.entities.push(entity);
    for (const other of others) {
      const pts = intersectEntities(doc, entity, other);
      const [ka, kb] = pairKey(entity.id, other.id);
      pts.forEach((loc, i) => {
        const paramOnOther = projectOntoEntity(doc, other, loc).param;
        if (isParamTrimmed(doc, other, paramOnOther)) return;
        mergeOrCreatePoint(doc, loc, (id) => ({ id, kind: 'intersection', entities: [ka, kb], branch: i as 0 | 1 }));
      });
    }
  });
  doc.updatedAt = Date.now();
  return entity;
}

export function addCircleEntity(doc: Doc, centre: PointId, through: PointId): Entity {
  return addEntity(doc, (id) => ({ id, kind: 'circle', centre, through }));
}

export function addLineEntity(doc: Doc, a: PointId, b: PointId, groupId?: string): Entity {
  return addEntity(doc, (id) => ({ id, kind: 'line', a, b, extended: false, ...(groupId ? { groupId } : {}) }));
}

export function addFreePoint(doc: Doc, x: number, y: number): PointId {
  const id = genId('pt');
  doc.points.push({ id, kind: 'free', x, y });
  doc.updatedAt = Date.now();
  return id;
}

export function addOnCurvePoint(doc: Doc, host: EntityId, param: number, at: Vec2): PointId {
  let id!: PointId;
  withSegmentMigration(doc, [host], () => {
    id = mergeOrCreatePoint(doc, at, (pid) => ({ id: pid, kind: 'on-curve', host, param }));
  });
  doc.updatedAt = Date.now();
  return id;
}

/** Phase 2A: commits a completed (or tool-finished-open) polygon's vertex chain as line
 * entities sharing one groupId, so Select can treat them as a single shape later. Each edge
 * goes through addEntity, so edges materialize intersections with everything else — including
 * each other — exactly like any other construction. */
export function addPolygonEntities(doc: Doc, vertexIds: PointId[], closed: boolean): EntityId[] {
  const groupId = genId('grp');
  const ids: EntityId[] = [];
  const count = closed ? vertexIds.length : vertexIds.length - 1;
  for (let i = 0; i < count; i++) {
    const a = vertexIds[i]!;
    const b = vertexIds[(i + 1) % vertexIds.length]!;
    if (a === b) continue;
    ids.push(addLineEntity(doc, a, b, groupId).id);
  }
  return ids;
}

/** Phase 2C: divides a line or arc segment into `of` equal parts — `of - 1` interior points,
 * anchored at the segment's own endpoints (spec: "start/anchor: its endpoints"). Position math
 * lives in geometry/divide.ts, shared with the compact slider's live preview (Phase 2.1). */
export function addSegmentDivisionPoints(doc: Doc, seg: SegmentSpan, of: number): PointId[] {
  const host = doc.entities.find((e) => e.id === seg.entityId);
  if (!host) return [];
  const created: PointId[] = [];
  withSegmentMigration(doc, [seg.entityId], () => {
    const positions = segmentDivisionPositions(doc, host, seg, of);
    let arcSpan: number | undefined;
    if (host.kind === 'circle') {
      arcSpan = seg.toParam - seg.fromParam;
      if (arcSpan < 0) arcSpan += Math.PI * 2;
    }
    positions.forEach((at, idx) => {
      const i = idx + 1;
      const id = mergeOrCreatePoint(doc, at, (pid) => ({
        id: pid,
        kind: 'division',
        host: seg.entityId,
        index: i,
        of,
        span: [seg.from, seg.to],
        ...(arcSpan !== undefined ? { rotationOffset: seg.fromParam, arcSpan } : {}),
      }));
      created.push(id);
    });
  });
  doc.updatedAt = Date.now();
  return created;
}

/** Phase 2C: divides a whole closed circle into `of` equal parts, anchored at `anchorAngle`
 * (the nearest existing point on the circle, or the frame's −90° alignment — spec §4.5). */
export function addCircleDivision(doc: Doc, hostId: EntityId, of: number, anchorAngle: number): PointId[] {
  const host = doc.entities.find((e) => e.id === hostId);
  if (!host || host.kind !== 'circle') return [];
  const created: PointId[] = [];
  withSegmentMigration(doc, [hostId], () => {
    const positions = circleDivisionPositions(doc, host, of, anchorAngle);
    positions.forEach((at, i) => {
      const id = mergeOrCreatePoint(doc, at, (pid) => ({ id: pid, kind: 'division', host: hostId, index: i, of, rotationOffset: anchorAngle }));
      created.push(id);
    });
  });
  doc.updatedAt = Date.now();
  return created;
}

/** Phase 2C: n/k star chords across a closed circle's division points — closed circles only
 * (§4.5: "star chords never wrap cyclically around an arc"). */
export function addStarChords(doc: Doc, divisionPointIds: PointId[], k: number): EntityId[] {
  const n = divisionPointIds.length;
  const ids: EntityId[] = [];
  for (let i = 0; i < n; i++) {
    const a = divisionPointIds[i]!;
    const b = divisionPointIds[(i + k) % n]!;
    if (a === b) continue;
    ids.push(addLineEntity(doc, a, b).id);
  }
  return ids;
}

/** Phase 2F: Trim — hides one segment (excluded from rendering outside Select, and later from
 * region/fill) without touching its parent entity or any other segment. Frame segments are
 * untrimmable. Returns false if refused. */
export function trimSegment(doc: Doc, entityId: EntityId, key: SegmentKey): boolean {
  const entity = doc.entities.find((e) => e.id === entityId);
  if (!entity || entity.locked) return false;
  doc.segmentStates.set(key, { state: 'trimmed' });
  doc.updatedAt = Date.now();
  return true;
}

/** Phase 2F: Restore — returns a trimmed segment to construction. */
export function restoreSegment(doc: Doc, key: SegmentKey): void {
  doc.segmentStates.delete(key);
  doc.updatedAt = Date.now();
}

/** Phase 3A: fairs or un-fairs one segment — a plain state write, never touching the parent
 * entity or any other derived segment on it (so fairing one of a circle's six arcs never affects
 * the other five). `stroke` is only meaningful when fairing. Phase 3.4 item 1: un-fairing demotes
 * back to the segment's actual previous non-Fair state, not unconditionally to Construction — an
 * Extension line's segment (state 'extension', set at creation — see line.ts) reverts to
 * Extension, derived from its parent entity's own `extended` flag rather than any separately
 * tracked "previous state", since that flag is already the authoritative fact for the whole
 * entity. Anything else reverts to the implicit default (deleting the entry = 'construction'). */
export function setSegmentFair(doc: Doc, key: SegmentKey, fair: boolean, stroke?: { colour: string; width: number }): void {
  if (fair) {
    doc.segmentStates.set(key, { state: 'fair', stroke: stroke ?? { ...doc.fairDefaults } });
  } else {
    const entity = doc.entities.find((e) => e.id === key.split(':')[0]);
    if (entity?.kind === 'line' && entity.extended) doc.segmentStates.set(key, { state: 'extension' });
    else doc.segmentStates.delete(key);
  }
  doc.updatedAt = Date.now();
}

/** Phase 3.4 item 3: "Promote to Fair" — the exact same promotion the Fair tool performs on a
 * tap, applied to every derived segment of one whole entity in one pass, for the quick shortcut
 * chip shown right after a new line commits. Never creates geometry; only writes segment state. */
export function promoteEntityToFair(doc: Doc, entityId: EntityId): void {
  const entity = doc.entities.find((e) => e.id === entityId);
  if (!entity) return;
  const fairStroke = { ...doc.fairDefaults };
  for (const seg of deriveSegments(doc, entity)) setSegmentFair(doc, seg.key, true, fairStroke);
}

/** Phase 3H: edits an already-fair segment's stroke in place — a no-op if it isn't fair (the
 * caller is expected to check, but this stays safe either way). */
export function setSegmentStroke(doc: Doc, key: SegmentKey, colour: string, width: number): void {
  const existing = doc.segmentStates.get(key);
  if (!existing || existing.state !== 'fair') return;
  doc.segmentStates.set(key, { ...existing, stroke: { colour, width } });
  doc.updatedAt = Date.now();
}

/** Phase 4 item 5/14: fills are scoped per colourway (spec's `Doc.fills`), keyed by a region's
 * own FaceSig — a stable identity recomputed from its current Fair boundary (geometry/regions.ts),
 * never chosen by the caller. Undo-tracked normally through commit(), same as any other
 * segmentStates-style write. */
export function setRegionFill(doc: Doc, sig: FaceSig, colour: string): void {
  let m = doc.fills.get(doc.activeColourway);
  if (!m) {
    m = new Map();
    doc.fills.set(doc.activeColourway, m);
  }
  m.set(sig, colour);
  doc.updatedAt = Date.now();
}

export function removeRegionFill(doc: Doc, sig: FaceSig): void {
  doc.fills.get(doc.activeColourway)?.delete(sig);
  doc.updatedAt = Date.now();
}

export function getRegionFill(doc: Doc, sig: FaceSig): string | undefined {
  return doc.fills.get(doc.activeColourway)?.get(sig);
}

/** Phase 3G: "Use frame in design" / "Stop using frame in design" — promotes or returns every
 * frame boundary segment in one pass, one undo step (the caller wraps this in commit()). Frame
 * segments stay untrimmable/undeletable regardless of `designEnabled` (enforced elsewhere: Trim
 * and whole-entity Delete both already refuse a `locked` entity). */
export function setFrameDesignEnabled(doc: Doc, enabled: boolean): void {
  doc.frame.designEnabled = enabled;
  for (const entityId of doc.frame.entityIds) {
    const entity = doc.entities.find((e) => e.id === entityId);
    if (!entity) continue;
    for (const seg of deriveSegments(doc, entity)) {
      if (enabled) doc.segmentStates.set(seg.key, { state: 'fair', stroke: { ...doc.fairDefaults } });
      else doc.segmentStates.delete(seg.key);
    }
  }
  doc.updatedAt = Date.now();
}

export interface DeletionPlan {
  rootEntityId: EntityId;
  entityIds: Set<EntityId>;
  pointIds: Set<PointId>;
}

/** Phase 2G: the full dependency closure a whole-entity Delete would remove — every point
 * defined through the entity (or a point that becomes dangling as a result), and every entity
 * that in turn depends on one of those points. Pure; §4.6's confirmation reads the counts off
 * this before anything is actually removed. Frame entities/points are never included. */
export function computeDeletionPlan(doc: Doc, rootEntityId: EntityId): DeletionPlan {
  const entityIds = new Set<EntityId>([rootEntityId]);
  const pointIds = new Set<PointId>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of doc.points) {
      if (pointIds.has(p.id)) continue;
      const isFrame = (doc.frame.centreId === p.id && p.kind === 'centre') || p.kind === 'frame-vertex';
      if (isFrame) continue;
      let depends = false;
      if (p.kind === 'intersection' && (entityIds.has(p.entities[0]) || entityIds.has(p.entities[1]))) depends = true;
      else if (p.kind === 'on-curve' && entityIds.has(p.host)) depends = true;
      else if (p.kind === 'division' && entityIds.has(p.host)) depends = true;
      else if (p.kind === 'centre' && entityIds.has(p.entity)) depends = true;
      else if (p.kind === 'midpoint' && (pointIds.has(p.a) || pointIds.has(p.b))) depends = true;
      if (depends) {
        pointIds.add(p.id);
        changed = true;
      }
    }
    for (const e of doc.entities) {
      if (entityIds.has(e.id) || e.locked) continue;
      const usesRemoved = e.kind === 'circle' ? pointIds.has(e.centre) || pointIds.has(e.through) : pointIds.has(e.a) || pointIds.has(e.b);
      if (usesRemoved) {
        entityIds.add(e.id);
        changed = true;
      }
    }
  }
  return { rootEntityId, entityIds, pointIds };
}

/** Every OTHER entity sharing a group with `entityId` (Polygon's edges), if any. */
export function groupEntityIds(doc: Doc, entityId: EntityId): EntityId[] {
  const entity = doc.entities.find((e) => e.id === entityId);
  const groupId = entity && entity.kind === 'line' ? entity.groupId : undefined;
  if (!groupId) return [entityId];
  return doc.entities.filter((e) => e.kind === 'line' && e.groupId === groupId).map((e) => e.id);
}

/** Combines computeDeletionPlan for every entity in a group (Polygon's Delete removes the
 * whole shape, per §Phase 2G treating it as one entity). */
export function computeGroupDeletionPlan(doc: Doc, entityId: EntityId): DeletionPlan {
  const group = groupEntityIds(doc, entityId);
  const entityIds = new Set<EntityId>();
  const pointIds = new Set<PointId>();
  for (const id of group) {
    const plan = computeDeletionPlan(doc, id);
    for (const e of plan.entityIds) entityIds.add(e);
    for (const p of plan.pointIds) pointIds.add(p);
  }
  return { rootEntityId: entityId, entityIds, pointIds };
}

export function applyDeletionPlan(doc: Doc, plan: DeletionPlan): void {
  doc.entities = doc.entities.filter((e) => !plan.entityIds.has(e.id));
  doc.points = doc.points.filter((p) => !plan.pointIds.has(p.id));
  for (const key of [...doc.segmentStates.keys()]) {
    const entityId = key.split(':')[0];
    if (entityId && plan.entityIds.has(entityId)) doc.segmentStates.delete(key);
  }
  doc.updatedAt = Date.now();
}

export interface PointDeletionPlan {
  pointId: PointId;
  entityIds: Set<EntityId>;
  pointIds: Set<PointId>; // includes pointId itself
}

/** Phase 3.5 item 3: the dependency closure deleting one editable point would remove — every
 * entity directly anchored on it (circle centre/through, line a/b), plus whatever THOSE entities'
 * own deletion would in turn take with them (reuses computeDeletionPlan per dependent entity).
 * Null for a derived/structural point kind — there is no "delete" for those, only an explanation. */
export function computePointDeletionPlan(doc: Doc, pointId: PointId): PointDeletionPlan | null {
  const point = doc.points.find((p) => p.id === pointId);
  if (!point || !isEditablePointKind(point.kind)) return null;
  const entityIds = new Set<EntityId>();
  const pointIds = new Set<PointId>([pointId]);
  for (const e of doc.entities) {
    const dependsOnPoint = e.kind === 'circle' ? e.centre === pointId || e.through === pointId : e.a === pointId || e.b === pointId;
    if (!dependsOnPoint) continue;
    const plan = computeDeletionPlan(doc, e.id);
    for (const eid of plan.entityIds) entityIds.add(eid);
    for (const pid of plan.pointIds) pointIds.add(pid);
  }
  return { pointId, entityIds, pointIds };
}

/** Phase 3.5 item 3: "Do not silently break geometry" — same shape as applyDeletionPlan, rooted
 * at a point instead of an entity. */
export function applyPointDeletionPlan(doc: Doc, plan: PointDeletionPlan): void {
  doc.entities = doc.entities.filter((e) => !plan.entityIds.has(e.id));
  doc.points = doc.points.filter((p) => !plan.pointIds.has(p.id));
  for (const key of [...doc.segmentStates.keys()]) {
    const entityId = key.split(':')[0];
    if (entityId && plan.entityIds.has(entityId)) doc.segmentStates.delete(key);
  }
  doc.updatedAt = Date.now();
}

/**
 * Phase 3.5 item 3: "Merge into…" — redirects every compatible reference to `sourceId` (an
 * editable free/on-curve point only — the caller is expected to have checked) onto `destId`
 * instead of removing them, then drops the now-unreferenced source point. Unlike Delete, nothing
 * else is removed: every entity/point that depended on the source keeps working, just anchored
 * on the destination now — "preserve geometry integrity." `destId` may be any existing point of
 * any kind (merging a stray free point onto an intersection that already sits there is exactly
 * the motivating case), never a new coordinate — this never moves a derived point, only
 * repoints references that used to terminate at the source.
 */
export function mergePoint(doc: Doc, sourceId: PointId, destId: PointId): void {
  const redirect = (id: PointId): PointId => (id === sourceId ? destId : id);
  for (const e of doc.entities) {
    if (e.kind === 'circle') {
      e.centre = redirect(e.centre);
      e.through = redirect(e.through);
    } else {
      e.a = redirect(e.a);
      e.b = redirect(e.b);
    }
  }
  for (const p of doc.points) {
    if (p.kind === 'midpoint') {
      p.a = redirect(p.a);
      p.b = redirect(p.b);
    } else if (p.kind === 'division' && p.span) {
      p.span = [redirect(p.span[0]), redirect(p.span[1])];
    }
  }
  doc.points = doc.points.filter((p) => p.id !== sourceId);
  doc.updatedAt = Date.now();
}

/** Phase 1.2 item 2: removes everything except the frame's own locked geometry, returning to a
 * clean frame. Distinct from redrawing the frame (§Phase 1.1 item 1 / this file's placeFrame),
 * which replaces position/scale/orientation too. */
export function clearDrawing(doc: Doc): void {
  const frameEntityIds = new Set(doc.frame.entityIds);
  doc.points = doc.points.filter((p) => {
    if (p.kind === 'centre' && p.id === doc.frame.centreId) return true;
    if (p.kind === 'frame-vertex') return true;
    if (p.kind === 'free' && p.hidden) return true; // the circle frame's own defining through-point
    return false;
  });
  doc.entities = doc.entities.filter((e) => frameEntityIds.has(e.id));
  doc.segmentStates = new Map();
  doc.fills = new Map();
  doc.symmetrySources = [];
  doc.frame.designEnabled = false;
  doc.updatedAt = Date.now();
}

export function cloneDoc(doc: Doc): Doc {
  return {
    ...doc,
    frame: { ...doc.frame, origin: { ...doc.frame.origin }, entityIds: [...doc.frame.entityIds] },
    points: doc.points.map((p) => ({ ...p })),
    entities: doc.entities.map((e) => ({ ...e })),
    segmentStates: new Map(doc.segmentStates),
    fills: new Map([...doc.fills].map(([k, v]) => [k, new Map(v)])),
    colourways: doc.colourways.map((c) => ({ ...c })),
    symmetrySources: doc.symmetrySources.map((s) => ({ ...s })),
    echo: { ...doc.echo },
    // Phase 5: `motif`/`rule` weren't deep-cloned before — a plain `{...doc.repeat}` shallow spread
    // left every snapshot sharing the SAME nested objects, so an in-place `d.repeat.motif.rotation
    // = x` inside a commit() would silently corrupt the PREVIOUS undo entry too. Now every nested
    // object gets its own copy, same rigor as `a`/`b`/`gapFills` already had.
    repeat: {
      ...doc.repeat,
      a: { ...doc.repeat.a },
      b: { ...doc.repeat.b },
      motif: { ...doc.repeat.motif },
      rule: { ...doc.repeat.rule },
      gapFills: new Map(doc.repeat.gapFills),
    },
    view: { ...doc.view, pan: { ...doc.view.pan } },
  };
}
