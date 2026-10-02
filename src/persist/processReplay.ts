// vNext Phase 4A: rebuilding an artwork's process from its stored history — for development and
// tests now, and for a future Timelapse. Pure data: a keyframe, then patches applied in order; the
// geometry engine is never consulted, so what an old history shows can't drift.

import { applyPatch, stateHash, type ArtworkState } from './processState.ts';
import { loadEvents, loadMeta, type ProcessEvent, type ProcessMeta } from './processStore.ts';

export interface ReplayStep {
  seq: number;
  at: number;
  source: ProcessEvent['source'];
  kind: string;
  tags: string[];
  /** The rebuilt state matched the fingerprint recorded for this moment. */
  ok: boolean;
}

/** Walks the whole history in order, calling `visit` with the state after each moment. */
export async function replayProcess(
  docId: string,
  visit?: (state: ArtworkState, event: ProcessEvent) => void,
  opts: { verify?: boolean } = {},
): Promise<{ meta: ProcessMeta | undefined; steps: ReplayStep[]; final: ArtworkState | null; ms: number }> {
  const meta = await loadMeta(docId);
  const events = (await loadEvents(docId)).sort((a, b) => a.seq - b.seq);
  const t0 = performance.now();
  let state: ArtworkState | null = null;
  const steps: ReplayStep[] = [];
  for (const e of events) {
    if (e.keyframe) state = structuredClone(e.keyframe);
    else if (state && e.patch) applyPatch(state, e.patch);
    else throw new Error(`history ${docId} has no keyframe before moment ${e.seq}`);
    steps.push({ seq: e.seq, at: e.at, source: e.source, kind: e.kind, tags: e.tags, ok: opts.verify === false ? true : stateHash(state) === e.hash });
    visit?.(state, e);
  }
  return { meta, steps, final: state, ms: performance.now() - t0 };
}

/** The state after one moment: from the nearest keyframe at or before it. */
export async function stateAt(docId: string, seq: number): Promise<ArtworkState | null> {
  const events = (await loadEvents(docId)).filter((e) => e.seq <= seq).sort((a, b) => a.seq - b.seq);
  let from = -1;
  events.forEach((e, i) => {
    if (e.keyframe) from = i;
  });
  if (from < 0) return null;
  const state = structuredClone(events[from]!.keyframe!);
  for (const e of events.slice(from + 1)) applyPatch(state, e.patch!);
  return state;
}
