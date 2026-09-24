// Document construction and mutation: frame creation (§4.1), the entity/point additions that
// keep intersections materialized as explicit points (§5.2), Divide, Trim, Delete, and — Phase
// 5.2 — Arcs, and re-anchoring/moving points with their dependents recomputed.

import type { Doc, Entity, EntityId, FaceSig, FrameKind, Point, PointId, RepeatDisplay, SegmentKey, Vec2 } from './types.ts';
import { genId } from './id.ts';
import { epsilon, frameVertexCount, intersectEntities, invalidateResolveCache, pairKey, projectOntoEntity, resolvePoint } from '../geometry/kernel.ts';
import { dist } from '../geometry/vec.ts';
import { withSegmentMigration } from '../geometry/segmentstate.ts';
import { defaultSegmentKind, deriveSegments, fairSegmentState, invalidateSegmentCaches, isParamTrimmed, unfairedSegmentState } from '../geometry/segments.ts';
import { invalidateRegionCaches } from '../geometry/regions.ts';
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

/** Phase 5.1: `legacyGuide` carries a Phase 5 document's single Guide toggle into its successors. */
export function defaultRepeatDisplay(legacyGuide = true): RepeatDisplay {
  return {
    artwork: 'design',
    constructionOverlay: false,
    background: color.plaster,
    fillOpacity: 1,
    grid: false,
    handles: legacyGuide,
    motifBoundary: legacyGuide,
  };
}

export function createDoc(frameKind: FrameKind, name?: string): Doc {
  const now = Date.now();
  const doc: Doc = {
    id: genId('doc'),
    name: name ?? 'Untitled',
    named: name !== undefined,
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
    fillDefaults: { colour: fairPalette[0]!.colour, opacity: 1 },
    toolPrefs: { circleMode: 'set', arcMode: 'measure', lastRadius: null },
    repeatView: { zoom: 1, pan: { x: 0, y: 0 } },
    repeatDisplay: defaultRepeatDisplay(),
    spaceDefaults: { colour: fairPalette[1]!.colour, opacity: 1 },
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

/** Phase 3A: fairs or un-fairs one segment — a plain state write, never touching the parent
 * entity or any other derived segment on it (so fairing one of a circle's six arcs never affects
 * the other five). `stroke` is only meaningful when fairing. Phase 3.4 item 1: un-fairing demotes
 * back to the segment's actual previous non-Fair state, not unconditionally to Construction — an
 * Extension line's segment (state 'extension', set at creation — see line.ts) reverts to
 * Extension, derived from its parent entity's own `extended` flag rather than any separately
 * tracked "previous state", since that flag is already the authoritative fact for the whole
 * entity. Anything else reverts to the implicit default (deleting the entry = 'construction'). */
export function setSegmentFair(doc: Doc, key: SegmentKey, fair: boolean, stroke?: { colour: string; width: number }): void {
  // Phase 5.6: the role to return to is remembered on the Fair state itself (segments.ts), so a
  // Construction span on an extended line un-Fairs to Construction, not to Extension.
  const entity = doc.entities.find((e) => e.id === key.split(':')[0]);
  const seg = entity ? deriveSegments(doc, entity).find((sg) => sg.key === key) : undefined;
  if (fair) {
    const st = stroke ?? { ...doc.fairDefaults };
    doc.segmentStates.set(key, entity && seg ? fairSegmentState(doc, entity, seg, st) : { state: 'fair', stroke: st });
  } else {
    const next = entity && seg ? unfairedSegmentState(doc, entity, seg) : null;
    if (next) doc.segmentStates.set(key, next);
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
  // Phase 5.6 item 37: only the line's own finite span — never the Extension beyond it.
  for (const seg of deriveSegments(doc, entity)) {
    if (defaultSegmentKind(entity, seg) === 'extension') continue;
    setSegmentFair(doc, seg.key, true, fairStroke);
  }
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

export interface DeletionPlan {
  rootEntityId: EntityId;
  entityIds: Set<EntityId>;
  pointIds: Set<PointId>;
}

/** Phase 2G / Phase 5.2: everything that stops being constructible once `entityIds` and
 * `pointIds` are gone — every point defined through them (or left dangling as a result), and
 * every entity that in turn depends on one of those points — grown in place. Frame entities and
 * points are never included. Also takes each removed circle's hidden radius handle, which has no
 * other role. */
function growDependencyClosure(doc: Doc, entityIds: Set<EntityId>, pointIds: Set<PointId>): void {
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
      else if (p.kind === 'division' && (entityIds.has(p.host) || (p.span && (pointIds.has(p.span[0]) || pointIds.has(p.span[1]))))) depends = true;
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
  for (const e of doc.entities) {
    if (!entityIds.has(e.id) || e.kind !== 'circle') continue;
    const handle = doc.points.find((p) => p.id === e.through);
    const sharedElsewhere = doc.entities.some((o) => !entityIds.has(o.id) && o.kind === 'circle' && o.through === e.through);
    if (handle?.kind === 'free' && handle.hidden && !sharedElsewhere) pointIds.add(handle.id);
  }
}

export function computeDeletionPlan(doc: Doc, rootEntityId: EntityId): DeletionPlan {
  const entityIds = new Set<EntityId>([rootEntityId]);
  const pointIds = new Set<PointId>();
  growDependencyClosure(doc, entityIds, pointIds);
  return { rootEntityId, entityIds, pointIds };
}

/** Phase 5.2: Delete for any selection — the union over every selected shape. The frame is never
 * deleted (it stays protected from destructive edits even though it can now be Faired directly). */
export function computeEntitiesDeletionPlan(doc: Doc, ids: EntityId[]): DeletionPlan | null {
  const roots = ids.filter((id) => !doc.entities.find((e) => e.id === id)?.locked);
  if (roots.length === 0) return null;
  const entityIds = new Set<EntityId>(roots);
  const pointIds = new Set<PointId>();
  growDependencyClosure(doc, entityIds, pointIds);
  return { rootEntityId: roots[0]!, entityIds, pointIds };
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

/** Phase 3.5 item 3 / Phase 5.2 item 13: what deleting one point removes. A hand-placed point
 * (free/on-curve) goes itself, with everything built on it. A derived point (intersection,
 * midpoint, division, centre…) is mathematically fixed by the geometry that defines it, so it
 * stays; Delete then means "remove what was built FROM this point". Null when that is nothing. */
export function computePointDeletionPlan(doc: Doc, pointId: PointId): PointDeletionPlan | null {
  const point = doc.points.find((p) => p.id === pointId);
  if (!point) return null;
  const editable = isEditablePointKind(point.kind);
  const entityIds = new Set<EntityId>(pointDependents(doc, pointId).map((d) => d.entityId));
  if (!editable && entityIds.size === 0) return null;
  const pointIds = new Set<PointId>(editable ? [pointId] : []);
  growDependencyClosure(doc, entityIds, pointIds);
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
 * Phase 3.5 item 3 / Phase 5.2: "Merge into…" — every construction anchored on `sourceId` is
 * re-anchored on `destId` instead, then recomputed (its crossings with everything else follow it).
 * A hand-placed source point is then dropped; a derived one stays, since the geometry defining it
 * still exists. A shape that would collapse onto itself (a line whose two ends are now the same
 * point) is removed rather than left degenerate. One commit, one undo step.
 */
export function mergePointInto(doc: Doc, sourceId: PointId, destId: PointId): void {
  if (sourceId === destId) return;
  const source = doc.points.find((p) => p.id === sourceId);
  if (!source) return;
  withSegmentMigration(
    doc,
    doc.entities.map((e) => e.id),
    () => {
      const changed = dependentEntities(doc, pointDependents(doc, sourceId).map((d) => d.entityId));
      const redirect = (id: PointId): PointId => (id === sourceId ? destId : id);
      for (const e of doc.entities) {
        if (e.locked) continue;
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
      if (isEditablePointKind(source.kind)) doc.points = doc.points.filter((p) => p.id !== sourceId);
      removeDegenerateEntities(doc, changed);
      refreshIntersections(doc, changed);
    },
  );
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

// ---- Phase 5.2: editing existing geometry in place ----

/** Every geometry cache keyed on a Doc — needed whenever a point MOVES within one commit (the
 * caches' own count-based guards only notice points/entities being added or removed). */
export function invalidateGeometryCaches(doc: Doc): void {
  invalidateResolveCache(doc);
  invalidateSegmentCaches(doc);
  invalidateRegionCaches(doc);
}

export type EndpointRole = 'a' | 'b' | 'centre' | 'through';
export interface PointDependent {
  entityId: EntityId;
  role: EndpointRole;
}

/** Phase 5.2 items 14/15: the constructions that use `pointId` as a defining point — a line's
 * end, a circle's centre, or a circle's (visible) radius point. The frame is never re-anchored. */
export function pointDependents(doc: Doc, pointId: PointId): PointDependent[] {
  const out: PointDependent[] = [];
  for (const e of doc.entities) {
    if (e.locked) continue;
    if (e.kind === 'line') {
      if (e.a === pointId) out.push({ entityId: e.id, role: 'a' });
      if (e.b === pointId) out.push({ entityId: e.id, role: 'b' });
    } else {
      if (e.centre === pointId) out.push({ entityId: e.id, role: 'centre' });
      if (e.through === pointId) out.push({ entityId: e.id, role: 'through' });
    }
  }
  return out;
}

/** `ids` plus every construction whose geometry follows from them — the set that must be
 * recomputed when any of `ids` changes shape or position. */
function dependentEntities(doc: Doc, ids: EntityId[]): Set<EntityId> {
  const entityIds = new Set<EntityId>(ids);
  growDependencyClosure(doc, entityIds, new Set<PointId>());
  return entityIds;
}

function removeDegenerateEntities(doc: Doc, candidates: Set<EntityId>): void {
  const degenerate = doc.entities.filter((e) => candidates.has(e.id) && (e.kind === 'line' ? e.a === e.b : e.centre === e.through));
  if (degenerate.length === 0) return;
  const plan = computeEntitiesDeletionPlan(
    doc,
    degenerate.map((e) => e.id),
  );
  if (plan) applyDeletionPlan(doc, plan);
  for (const e of degenerate) candidates.delete(e.id);
}

/** New crossings between `entity` and `others`, as explicit intersection points — never inside a
 * trimmed span of either curve (a removed piece, or the unswept part of an Arc). */
function materializeIntersections(doc: Doc, entity: Entity, others: Entity[]): void {
  for (const other of others) {
    if (other.id === entity.id) continue;
    const [ka, kb] = pairKey(entity.id, other.id);
    intersectEntities(doc, entity, other).forEach((loc, i) => {
      if (isParamTrimmed(doc, other, projectOntoEntity(doc, other, loc).param)) return;
      if (isParamTrimmed(doc, entity, projectOntoEntity(doc, entity, loc).param)) return;
      mergeOrCreatePoint(doc, loc, (id) => ({ id, kind: 'intersection', entities: [ka, kb], branch: i as 0 | 1 }));
    });
  }
}

/**
 * After `changed` entities moved or changed shape: crossings that no longer exist are removed
 * (together with anything that was built on them), and new crossings are materialized — so
 * "dependent geometry recomputes" rather than leaving stale points behind. Callers wrap this in
 * withSegmentMigration so Fair/Trim state follows the pieces it belonged to.
 */
function refreshIntersections(doc: Doc, changed: Set<EntityId>): void {
  invalidateGeometryCaches(doc);
  const dead = new Set<PointId>();
  for (const p of doc.points) {
    if (p.kind !== 'intersection' || !(changed.has(p.entities[0]) || changed.has(p.entities[1]))) continue;
    const e1 = doc.entities.find((e) => e.id === p.entities[0]);
    const e2 = doc.entities.find((e) => e.id === p.entities[1]);
    if (!e1 || !e2 || intersectEntities(doc, e1, e2).length <= p.branch) dead.add(p.id);
  }
  if (dead.size > 0) {
    const entityIds = new Set<EntityId>();
    for (const e of doc.entities) {
      if (e.locked) continue;
      const anchored = e.kind === 'circle' ? dead.has(e.centre) || dead.has(e.through) : dead.has(e.a) || dead.has(e.b);
      if (anchored) entityIds.add(e.id);
    }
    growDependencyClosure(doc, entityIds, dead);
    applyDeletionPlan(doc, { rootEntityId: '', entityIds, pointIds: dead });
    for (const id of entityIds) changed.delete(id);
    invalidateGeometryCaches(doc);
  }
  const all = doc.entities.slice();
  for (const id of changed) {
    const e = doc.entities.find((x) => x.id === id);
    if (e) materializeIntersections(doc, e, all);
  }
  invalidateGeometryCaches(doc);
}

/** A circle's hidden radius handle (the same device the circle frame uses): a point with no
 * user-facing role that fixes the radius when it comes from a remembered distance, not a point. */
function addRadiusHandle(doc: Doc, centre: Vec2, radius: number, angle: number): PointId {
  const id = genId('pt');
  doc.points.push({ id, kind: 'free', x: centre.x + radius * Math.cos(angle), y: centre.y + radius * Math.sin(angle), hidden: true });
  return id;
}

function hiddenRadiusHandle(doc: Doc, pointId: PointId): Extract<Point, { kind: 'free' }> | null {
  const p = doc.points.find((pt) => pt.id === pointId);
  return p?.kind === 'free' && p.hidden ? p : null;
}

/** Phase 5.2 item 17: Circle's "Same radius" — a new circle at `centreId` with a remembered radius. */
export function addCircleWithRadius(doc: Doc, centreId: PointId, radius: number): Entity {
  const c = resolvePoint(doc, centreId);
  return addCircleEntity(doc, centreId, addRadiusHandle(doc, c, radius, 0));
}

function normalizeAngle(a: number): number {
  const twoPi = Math.PI * 2;
  return ((a % twoPi) + twoPi) % twoPi;
}

/**
 * Phase 5.2 item 19: an Arc, built the way a compass draws one — a circle entity whose unswept
 * part is trimmed away. Trim already means "genuinely absent" everywhere (not drawn, not hit, no
 * new crossings, no region boundary), so an Arc needs no new entity kind: Fair, Divide, Fill,
 * Select and Repeat all read it correctly as-is. Its two ends are real points (`arcEnd`) that
 * other constructions can snap to. `sweep` is signed: positive counter-clockwise.
 */
export function addArc(doc: Doc, centreId: PointId, radius: number, startAngle: number, sweep: number): EntityId {
  const c = resolvePoint(doc, centreId);
  const span = Math.min(Math.abs(sweep), Math.PI * 2);
  if (span >= Math.PI * 2 - 1e-3) return addCircleEntity(doc, centreId, addRadiusHandle(doc, c, radius, startAngle)).id;
  const from = sweep >= 0 ? startAngle : startAngle + sweep; // counter-clockwise start
  const circle: Entity = { id: genId('en'), kind: 'circle', centre: centreId, through: addRadiusHandle(doc, c, radius, from) };
  const others = doc.entities.slice();
  withSegmentMigration(doc, [...others.map((e) => e.id), circle.id], () => {
    doc.entities.push(circle);
    for (const angle of [from, from + span]) {
      const at = { x: c.x + radius * Math.cos(angle), y: c.y + radius * Math.sin(angle) };
      mergeOrCreatePoint(doc, at, (id) => ({ id, kind: 'on-curve', host: circle.id, param: normalizeAngle(angle), arcEnd: true }));
    }
    for (const seg of deriveSegments(doc, circle)) {
      let segSpan = seg.toParam - seg.fromParam;
      if (segSpan <= 0) segSpan += Math.PI * 2;
      const mid = seg.fromParam + segSpan / 2;
      if (normalizeAngle(mid - from) > span) doc.segmentStates.set(seg.key, { state: 'trimmed' });
    }
    materializeIntersections(doc, circle, others);
  });
  doc.updatedAt = Date.now();
  return circle.id;
}

/** A whole circle with fewer than two points on it has no segments, so there is nothing to Fair
 * or Trim yet. Give it two structural on-curve points (opposite each other, anchored on whatever
 * point it already has) so the whole circle can be promoted as one closed shape. */
export function ensureCircleSegments(doc: Doc, entityId: EntityId): void {
  const e = doc.entities.find((x) => x.id === entityId);
  if (!e || e.kind !== 'circle' || deriveSegments(doc, e).length > 0) return;
  const c = resolvePoint(doc, e.centre);
  const r = dist(c, resolvePoint(doc, e.through));
  const eps = epsilon(doc);
  const onIt = doc.points.find((p) => {
    if (p.id === e.through || (p.kind === 'free' && p.hidden)) return false;
    return Math.abs(dist(resolvePoint(doc, p.id), c) - r) < eps;
  });
  const t = resolvePoint(doc, e.through);
  const base = onIt ? Math.atan2(resolvePoint(doc, onIt.id).y - c.y, resolvePoint(doc, onIt.id).x - c.x) : Math.atan2(t.y - c.y, t.x - c.x);
  const angles = onIt ? [base + Math.PI] : [base, base + Math.PI];
  for (const a of angles) addOnCurvePoint(doc, e.id, normalizeAngle(a), { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
}

/**
 * Phase 5.2 item 14: re-anchor one construction's defining point, e.g. line A→B becomes A→C.
 * The old point is untouched (an intersection stays where the mathematics puts it); only the
 * dependency changes, and everything downstream recomputes. A circle whose radius came from a
 * remembered distance keeps that radius when its centre is re-anchored. One commit, one undo step.
 */
export function rebindEndpoint(doc: Doc, dep: PointDependent, newPointId: PointId): void {
  const entity = doc.entities.find((e) => e.id === dep.entityId);
  if (!entity || entity.locked) return;
  withSegmentMigration(
    doc,
    doc.entities.map((e) => e.id),
    () => {
      if (entity.kind === 'line') {
        if (dep.role === 'a') entity.a = newPointId;
        else if (dep.role === 'b') entity.b = newPointId;
      } else if (dep.role === 'centre') {
        const handle = hiddenRadiusHandle(doc, entity.through);
        if (handle) {
          const oldC = resolvePoint(doc, entity.centre);
          const newC = resolvePoint(doc, newPointId);
          handle.x += newC.x - oldC.x;
          handle.y += newC.y - oldC.y;
        }
        entity.centre = newPointId;
      } else if (dep.role === 'through') {
        entity.through = newPointId;
      }
      const changed = dependentEntities(doc, [entity.id]);
      removeDegenerateEntities(doc, changed);
      refreshIntersections(doc, changed);
    },
  );
  doc.updatedAt = Date.now();
}

/** Phase 5.2 item 14: a hand-placed point moves directly, carrying what's built on it (circles
 * centred on it keep a remembered radius). */
export function moveFreePoint(doc: Doc, pointId: PointId, to: Vec2): void {
  const p = doc.points.find((pt) => pt.id === pointId);
  if (!p || p.kind !== 'free') return;
  withSegmentMigration(
    doc,
    doc.entities.map((e) => e.id),
    () => {
      const dx = to.x - p.x;
      const dy = to.y - p.y;
      p.x = to.x;
      p.y = to.y;
      for (const e of doc.entities) {
        if (e.kind !== 'circle' || e.centre !== pointId) continue;
        const handle = hiddenRadiusHandle(doc, e.through);
        if (handle) {
          handle.x += dx;
          handle.y += dy;
        }
      }
      refreshIntersections(doc, dependentEntities(doc, pointDependents(doc, pointId).map((d) => d.entityId)));
    },
  );
  doc.updatedAt = Date.now();
}

/** Phase 5.2 item 14: an on-curve point (including an Arc's end) slides along its own curve. */
export function slideOnCurvePoint(doc: Doc, pointId: PointId, param: number): void {
  const p = doc.points.find((pt) => pt.id === pointId);
  if (!p || p.kind !== 'on-curve') return;
  withSegmentMigration(
    doc,
    doc.entities.map((e) => e.id),
    () => {
      p.param = param;
      refreshIntersections(doc, dependentEntities(doc, pointDependents(doc, pointId).map((d) => d.entityId)));
    },
  );
  doc.updatedAt = Date.now();
}
