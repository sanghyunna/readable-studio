import { moveCssCommitStyles } from './resize-geometry';
import type { ManualEditRect, ManualEditStyles, ManualEditTarget } from './types';

export type ManualEditMovementSource = 'pointer' | 'keyboard';
export type ManualEditMovementAxis = 'x' | 'y';

export function selectManualEditMovementAxis(
  rawDelta: Readonly<{ x: number; y: number }>,
): ManualEditMovementAxis {
  return Math.abs(rawDelta.x) >= Math.abs(rawDelta.y) ? 'x' : 'y';
}

/** The two snappable sides of a box on a given axis. No center snapping. */
export type ManualEditSnapEdge = 'min' | 'max';

/**
 * A non-moving target eligible to serve as an alignment reference. Structural
 * fields carry the discovery relationship to the selected element so the
 * ranking can prefer siblings over unrelated boxes and rank ancestors last.
 */
export interface ManualEditSnapCandidate {
  id: string;
  rect: Readonly<ManualEditRect>;
  parentId: string | null;
  ancestorIds: readonly string[];
  /** Stable document order, used as a final deterministic tie-breaker. */
  index: number;
  /** Opt-in candidate for the duplicate's stationary source origin. */
  isStationaryOriginal?: boolean;
}

export interface ManualEditSnapMatch {
  axis: 'x' | 'y';
  targetId: string;
  movingEdge: ManualEditSnapEdge;
  targetEdge: ManualEditSnapEdge;
  /** Rect-space px added to the raw delta so the moving edge meets the target edge. */
  correction: number;
}

export interface ManualEditSnapLatchEntry {
  targetId: string;
  movingEdge: ManualEditSnapEdge;
  targetEdge: ManualEditSnapEdge;
}

export interface ManualEditSnapLatch {
  x: ManualEditSnapLatchEntry | null;
  y: ManualEditSnapLatchEntry | null;
}

/** A guide line in rect (iframe viewport) space. */
export interface ManualEditSnapGuide {
  axis: 'x' | 'y';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ManualEditMovementSession {
  targetId: string;
  source: ManualEditMovementSource;
  startRect: Readonly<ManualEditRect>;
  baselineTranslate: string | undefined;
  rectScale?: Readonly<{ x: number; y: number }>;
  /** Host px per rect px; converts a rect-space correction into a screen threshold. */
  scale: number;
  /** Non-moving targets' rects eligible for snapping. */
  candidates: readonly ManualEditSnapCandidate[];
  /** Discovery parent of the selected element (null at root). */
  selectedParentId: string | null;
  /** Nearest-first discovery ancestors of the selected element. */
  selectedAncestorIds: readonly string[];
  /** Original target's document-order index from the pointer-down snapshot. */
  selectedIndex?: number;
  /** False when the target did not expose the structural metadata needed to rank snaps. */
  snapCandidatesReady?: boolean;
  /** Per-axis latch; mutated in-place across frames for snap hysteresis. */
  latch: ManualEditSnapLatch;
  /** Set once the duplicate has escaped the stationary-original release band. */
  stationaryOriginalEscaped?: boolean;
}

export interface ManualEditMovementResult {
  targetId: string;
  axisConstraint: ManualEditMovementAxis | null;
  rawDelta: Readonly<{ x: number; y: number }>;
  /** Raw delta plus any active snap correction. Equals rawDelta when nothing snaps. */
  appliedDelta: Readonly<{ x: number; y: number }>;
  translatedRect: Readonly<ManualEditRect>;
  styles: Readonly<Pick<ManualEditStyles, 'translate'>>;
  matches: Readonly<{ x: ManualEditSnapMatch | null; y: ManualEditSnapMatch | null }>;
  guides: Readonly<{ vertical: ManualEditSnapGuide | null; horizontal: ManualEditSnapGuide | null }>;
}

/** A pairing acquires within this screen-px gap. */
export const SNAP_ACQUIRE_PX = 6;
/** An active latch survives until the gap widens past this screen-px distance. */
export const SNAP_RELEASE_PX = 10;
/** A rival pairing only steals an active latch when this much closer (screen px). */
export const SNAP_SWITCH_ADVANTAGE_PX = 2;

export function createManualEditSnapLatch(): ManualEditSnapLatch {
  return { x: null, y: null };
}

function parentIdOf(target: Pick<ManualEditTarget, 'parentId' | 'ancestorIds'>): string | null {
  if (target.parentId !== undefined && target.parentId !== null) return target.parentId;
  const ancestors = target.ancestorIds;
  return ancestors && ancestors.length > 0 ? ancestors[0]! : null;
}

/**
 * Build snap candidates from the current target list. Requires the selected
 * target to carry structural metadata (parentId/ancestorIds); without it the
 * relationships that drive ranking cannot be computed, so snapping is disabled
 * by returning no candidates. Excludes the selection itself, its descendants
 * (they move together), hidden or disconnected elements, and degenerate rects.
 * `stationaryOriginalId` opts the original back in as a duplicate-origin
 * candidate while keeping the selected target's structural ranking metadata.
 */
export function buildManualEditMovementCandidates(
  targets: readonly ManualEditTarget[],
  selectedId: string,
  options?: { stationaryOriginalId?: string },
): {
  candidates: ManualEditSnapCandidate[];
  selectedParentId: string | null;
  selectedAncestorIds: readonly string[];
  selectedIndex: number;
  snapCandidatesReady: boolean;
} {
  const selected = targets.find((target) => target.id === selectedId);
  if (!selected || selected.ancestorIds === undefined) {
    return {
      candidates: [],
      selectedParentId: null,
      selectedAncestorIds: [],
      selectedIndex: -1,
      snapCandidatesReady: false,
    };
  }
  const selectedAncestorIds = selected.ancestorIds;
  const selectedParentId = parentIdOf(selected);
  const selectedIndex = targets.indexOf(selected);
  const stationaryOriginalId = options?.stationaryOriginalId;
  const candidates: ManualEditSnapCandidate[] = [];
  targets.forEach((target, index) => {
    if (target.id === selectedId && target.id !== stationaryOriginalId) return;
    if (target.ancestorIds?.includes(selectedId)) return; // descendant of the selection
    if (target.isHidden) return;
    if (target.isConnected === false) return;
    const { x, y, width, height } = target.rect;
    if (![x, y, width, height].every((value) => Number.isFinite(value))) return;
    if (width <= 0 || height <= 0) return;
    candidates.push({
      id: target.id,
      rect: target.rect,
      parentId: parentIdOf(target),
      ancestorIds: target.ancestorIds ?? [],
      index,
      ...(target.id === stationaryOriginalId ? { isStationaryOriginal: true } : {}),
    });
  });
  return { candidates, selectedParentId, selectedAncestorIds, selectedIndex, snapCandidatesReady: true };
}

const EDGES: readonly ManualEditSnapEdge[] = ['min', 'max'];

// Fixed edge-pair order tie-breaker: LL, LR, RL, RR (or TT, TB, BT, BB).
const EDGE_ORDER: Record<string, number> = {
  'min:min': 0,
  'min:max': 1,
  'max:min': 2,
  'max:max': 3,
};

function edgeValue(rect: Readonly<ManualEditRect>, axis: 'x' | 'y', edge: ManualEditSnapEdge): number {
  if (axis === 'x') return edge === 'min' ? rect.x : rect.x + rect.width;
  return edge === 'min' ? rect.y : rect.y + rect.height;
}

/** Perpendicular [min, max] extent used for overlap/gap ranking. */
function perpExtent(rect: Readonly<ManualEditRect>, axis: 'x' | 'y'): [number, number] {
  if (axis === 'x') return [rect.y, rect.y + rect.height];
  return [rect.x, rect.x + rect.width];
}

interface Pairing {
  candidate: ManualEditSnapCandidate;
  movingEdge: ManualEditSnapEdge;
  targetEdge: ManualEditSnapEdge;
  correction: number;
  screenCorrection: number;
  relationship: number;
  overlap: number;
  gap: number;
  centerDist: number;
  edgeOrder: number;
}

function relationshipPriority(
  candidate: ManualEditSnapCandidate,
  selectedParentId: string | null,
  selectedAncestorIds: readonly string[],
): number {
  if (selectedAncestorIds.includes(candidate.id)) return 2; // ancestor: ranked last
  if (candidate.parentId === selectedParentId) return 0; // peer/sibling: preferred
  return 1; // unrelated
}

function makePairing(
  session: ManualEditMovementSession,
  axis: 'x' | 'y',
  movingRect: Readonly<ManualEditRect>,
  candidate: ManualEditSnapCandidate,
  movingEdge: ManualEditSnapEdge,
  targetEdge: ManualEditSnapEdge,
): Pairing {
  const correction = edgeValue(candidate.rect, axis, targetEdge) - edgeValue(movingRect, axis, movingEdge);
  const [aMin, aMax] = perpExtent(movingRect, axis);
  const [bMin, bMax] = perpExtent(candidate.rect, axis);
  const overlap = Math.max(0, Math.min(aMax, bMax) - Math.max(aMin, bMin));
  const gap = Math.max(0, Math.max(aMin, bMin) - Math.min(aMax, bMax));
  return {
    candidate,
    movingEdge,
    targetEdge,
    correction,
    screenCorrection: Math.abs(correction) * session.scale,
    relationship: relationshipPriority(candidate, session.selectedParentId, session.selectedAncestorIds),
    overlap,
    gap,
    centerDist: Math.abs((aMin + aMax) / 2 - (bMin + bMax) / 2),
    edgeOrder: EDGE_ORDER[`${movingEdge}:${targetEdge}`] ?? 0,
  };
}

function scoreKey(pairing: Pairing): Array<number | string> {
  return [
    pairing.screenCorrection, // asc
    pairing.relationship, // asc: peer < unrelated < ancestor
    -pairing.overlap, // overlap desc
    pairing.gap, // asc
    pairing.centerDist, // asc
    pairing.edgeOrder, // asc
    pairing.candidate.index, // asc: document order
    pairing.candidate.id, // localeCompare
  ];
}

function compareKeys(a: Array<number | string>, b: Array<number | string>): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i]!;
    const bv = b[i]!;
    if (typeof av === 'string' || typeof bv === 'string') {
      const cmp = String(av).localeCompare(String(bv));
      if (cmp !== 0) return cmp;
    } else {
      if (av < bv) return -1;
      if (av > bv) return 1;
    }
  }
  return 0;
}

function samePairing(a: Pairing, latch: ManualEditSnapLatchEntry): boolean {
  return a.candidate.id === latch.targetId
    && a.movingEdge === latch.movingEdge
    && a.targetEdge === latch.targetEdge;
}

function updateStationaryOriginalEscape(
  session: ManualEditMovementSession,
  movingRect: Readonly<ManualEditRect>,
): void {
  if (session.stationaryOriginalEscaped || !session.candidates.some((candidate) => candidate.isStationaryOriginal)) return;
  const screenDisplacement = Math.max(
    Math.abs(movingRect.x - session.startRect.x),
    Math.abs(movingRect.y - session.startRect.y),
  ) * session.scale;
  if (screenDisplacement > SNAP_RELEASE_PX) session.stationaryOriginalEscaped = true;
}

/** Resolve one axis: mutate the latch and return the active match (or null). */
function resolveAxis(
  session: ManualEditMovementSession,
  axis: 'x' | 'y',
  movingRect: Readonly<ManualEditRect>,
): ManualEditSnapMatch | null {
  const pairings: Pairing[] = [];
  for (const candidate of session.candidates) {
    if (candidate.isStationaryOriginal && !session.stationaryOriginalEscaped) continue;
    for (const movingEdge of EDGES) {
      for (const targetEdge of EDGES) {
        pairings.push(makePairing(session, axis, movingRect, candidate, movingEdge, targetEdge));
      }
    }
  }

  // Best freshly-acquirable pairing.
  let best: Pairing | null = null;
  for (const pairing of pairings) {
    if (pairing.screenCorrection > SNAP_ACQUIRE_PX) continue;
    if (!best || compareKeys(scoreKey(pairing), scoreKey(best)) < 0) best = pairing;
  }

  // Recompute the current latch at the new cursor position; keep it while it
  // stays within the (wider) release band.
  let latchPairing: Pairing | null = null;
  const latch = session.latch[axis];
  if (latch) {
    const candidate = session.candidates.find((c) => c.id === latch.targetId);
    if (candidate) {
      const pairing = makePairing(session, axis, movingRect, candidate, latch.movingEdge, latch.targetEdge);
      if (pairing.screenCorrection <= SNAP_RELEASE_PX) latchPairing = pairing;
    }
    if (!latchPairing) session.latch[axis] = null;
  }

  let winner: Pairing | null;
  if (latchPairing) {
    if (!best || samePairing(best, latch as ManualEditSnapLatchEntry)) {
      winner = latchPairing;
    } else if (latchPairing.screenCorrection - best.screenCorrection >= SNAP_SWITCH_ADVANTAGE_PX) {
      winner = best;
    } else {
      winner = latchPairing;
    }
  } else {
    winner = best;
  }

  if (!winner) {
    session.latch[axis] = null;
    return null;
  }
  session.latch[axis] = {
    targetId: winner.candidate.id,
    movingEdge: winner.movingEdge,
    targetEdge: winner.targetEdge,
  };
  return {
    axis,
    targetId: winner.candidate.id,
    movingEdge: winner.movingEdge,
    targetEdge: winner.targetEdge,
    correction: winner.correction,
  };
}

function buildGuide(
  session: ManualEditMovementSession,
  match: ManualEditSnapMatch,
  movingRect: Readonly<ManualEditRect>,
): ManualEditSnapGuide | null {
  const candidate = session.candidates.find((c) => c.id === match.targetId);
  if (!candidate) return null;
  if (match.axis === 'x') {
    const at = edgeValue(candidate.rect, 'x', match.targetEdge);
    return {
      axis: 'x',
      x1: at,
      x2: at,
      y1: Math.min(movingRect.y, candidate.rect.y),
      y2: Math.max(movingRect.y + movingRect.height, candidate.rect.y + candidate.rect.height),
    };
  }
  const at = edgeValue(candidate.rect, 'y', match.targetEdge);
  return {
    axis: 'y',
    y1: at,
    y2: at,
    x1: Math.min(movingRect.x, candidate.rect.x),
    x2: Math.max(movingRect.x + movingRect.width, candidate.rect.x + candidate.rect.width),
  };
}

/**
 * Resolve one frame of a manual-edit movement. Snapping is magnetic: when a
 * moving edge lands within the acquire band of a candidate edge, the element is
 * pulled onto that edge (appliedDelta = rawDelta + correction) and the serialized
 * translate carries sub-pixel precision so the element sits exactly on the
 * possibly-fractional target edge. Alt, a keyboard source, or an empty candidate
 * set disables snapping and returns the raw movement with no matches or guides.
 * Shift (options.shiftKey) locks the move to one axis; snapping then applies only
 * on the free axis and the locked axis is pinned to zero.
 */
export function resolveManualEditMovement(
  session: ManualEditMovementSession,
  rawDeltaInput: Readonly<{ x: number; y: number }>,
  options?: { alt?: boolean; shiftKey?: boolean; axis?: ManualEditMovementAxis | null },
): ManualEditMovementResult {
  const rawDelta = { x: rawDeltaInput.x, y: rawDeltaInput.y };
  const alt = options?.alt === true;
  const shiftKey = options?.shiftKey === true;
  // Shift constrains movement to one axis (the caller-latched axis if given,
  // else the dominant raw axis); the other axis is pinned to zero before snapping.
  const axisConstraint: ManualEditMovementAxis | null = shiftKey
    ? options?.axis ?? selectManualEditMovementAxis(rawDelta)
    : null;
  const constrainedDelta = axisConstraint === 'x'
    ? { x: rawDelta.x, y: 0 }
    : axisConstraint === 'y'
      ? { x: 0, y: rawDelta.y }
      : { x: rawDelta.x, y: rawDelta.y };

  const snappingEnabled = !alt && session.source === 'pointer' && session.candidates.length > 0;

  const movingRect: ManualEditRect = {
    x: session.startRect.x + constrainedDelta.x,
    y: session.startRect.y + constrainedDelta.y,
    width: session.startRect.width,
    height: session.startRect.height,
  };
  updateStationaryOriginalEscape(session, movingRect);

  // Snap only on a free axis; a Shift-locked axis stays pinned and drops its latch.
  let matchX: ManualEditSnapMatch | null = null;
  let matchY: ManualEditSnapMatch | null = null;
  if (snappingEnabled) {
    if (axisConstraint !== 'y') matchX = resolveAxis(session, 'x', movingRect);
    else session.latch.x = null;
    if (axisConstraint !== 'x') matchY = resolveAxis(session, 'y', movingRect);
    else session.latch.y = null;
  }

  const appliedDelta = {
    x: constrainedDelta.x + (matchX ? matchX.correction : 0),
    y: constrainedDelta.y + (matchY ? matchY.correction : 0),
  };

  const translatedRect: ManualEditRect = {
    x: session.startRect.x + appliedDelta.x,
    y: session.startRect.y + appliedDelta.y,
    width: session.startRect.width,
    height: session.startRect.height,
  };


  const styles = moveCssCommitStyles({
    deltaRect: appliedDelta,
    baseTranslate: session.baselineTranslate,
    rectScale: session.rectScale,
    fractional: { x: matchX !== null, y: matchY !== null },
  });

  return {
    targetId: session.targetId,
    axisConstraint,
    rawDelta,
    appliedDelta,
    translatedRect,
    styles,
    matches: { x: matchX, y: matchY },
    guides: {
      vertical: matchX ? buildGuide(session, matchX, translatedRect) : null,
      horizontal: matchY ? buildGuide(session, matchY, translatedRect) : null,
    },
  };
}
