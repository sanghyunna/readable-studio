import { describe, expect, it } from 'vitest';
import {
  buildManualEditMovementCandidates,
  createManualEditSnapLatch,
  resolveManualEditMovement,
  type ManualEditMovementSession,
  type ManualEditSnapCandidate,
  type ManualEditSnapEdge,
} from '../../src/edit-mode/movement-session';
import { moveCssCommitStyles } from '../../src/edit-mode/resize-geometry';
import { emptyManualEditStyles, type ManualEditRect, type ManualEditTarget } from '../../src/edit-mode/types';

const START_RECT: ManualEditRect = { x: 100, y: 200, width: 300, height: 150 };

function r(x: number, y: number, width: number, height: number): ManualEditRect {
  return { x, y, width, height };
}

function session(overrides: Partial<ManualEditMovementSession> = {}): ManualEditMovementSession {
  return {
    targetId: 'target-1',
    source: 'pointer',
    startRect: { ...START_RECT },
    baselineTranslate: undefined,
    scale: 1,
    candidates: [],
    selectedParentId: null,
    selectedAncestorIds: [],
    latch: createManualEditSnapLatch(),
    ...overrides,
  };
}

function cand(id: string, rect: ManualEditRect, extra: Partial<ManualEditSnapCandidate> = {}): ManualEditSnapCandidate {
  return { id, rect, parentId: null, ancestorIds: [], index: 0, ...extra };
}

function makeTarget(id: string, rect: ManualEditRect, extra: Partial<ManualEditTarget> = {}): ManualEditTarget {
  return {
    id,
    kind: 'container',
    label: id,
    tagName: 'div',
    className: '',
    text: '',
    rect,
    ancestorIds: [],
    fields: {},
    attributes: {},
    styles: emptyManualEditStyles(),
    isLayoutContainer: false,
    outerHtml: '',
    ...extra,
  };
}

describe('resolveManualEditMovement (movement serializer, no candidates)', () => {
  it('constrains Shift movement to a stable dominant axis until Shift is released', () => {
    const movement = session({ baselineTranslate: '10px 20px' });

    const xLocked = resolveManualEditMovement(movement, { x: 8, y: -8 }, { shiftKey: true, axis: null });
    const stable = resolveManualEditMovement(movement, { x: 8, y: -30 }, {
      shiftKey: true,
      axis: xLocked.axisConstraint,
    });
    const released = resolveManualEditMovement(movement, { x: 8, y: -30 }, {
      shiftKey: false,
      axis: stable.axisConstraint,
    });

    expect(xLocked.axisConstraint).toBe('x');
    expect(xLocked.appliedDelta).toEqual({ x: 8, y: 0 });
    expect(stable.axisConstraint).toBe('x');
    expect(stable.appliedDelta).toEqual({ x: 8, y: 0 });
    expect(released.axisConstraint).toBeNull();
    expect(released.appliedDelta).toEqual({ x: 8, y: -30 });
  });

  it('uses the current raw displacement when Shift is pressed again', () => {
    const movement = session();
    const yLocked = resolveManualEditMovement(
      movement,
      { x: 7, y: -12 },
      { shiftKey: true, axis: null },
    );
    const released = resolveManualEditMovement(
      movement,
      { x: 30, y: 8 },
      { shiftKey: false, axis: yLocked.axisConstraint },
    );
    const xLocked = resolveManualEditMovement(
      movement,
      { x: 30, y: 8 },
      { shiftKey: true, axis: released.axisConstraint },
    );

    expect(yLocked).toMatchObject({
      axisConstraint: 'y',
      rawDelta: { x: 7, y: -12 },
      appliedDelta: { x: 0, y: -12 },
    });
    expect(released.axisConstraint).toBeNull();
    expect(xLocked).toMatchObject({
      axisConstraint: 'x',
      rawDelta: { x: 30, y: 8 },
      appliedDelta: { x: 30, y: 0 },
    });
  });

  it('copies identity and absolute delta into independent result values', () => {
    const rawDelta = { x: 12, y: -8 };
    const result = resolveManualEditMovement(session({ targetId: 'copy-me' }), rawDelta);

    rawDelta.x = 999;
    rawDelta.y = 999;

    expect(result.targetId).toBe('copy-me');
    expect(result.rawDelta).toEqual({ x: 12, y: -8 });
    expect(result.appliedDelta).toEqual(result.rawDelta);
    expect(result.rawDelta).not.toBe(result.appliedDelta);
    expect(result.translatedRect).toEqual({ x: 112, y: 192, width: 300, height: 150 });
  });

  it('does not mutate the session or input', () => {
    const movement = Object.freeze({
      targetId: 'frozen',
      source: 'pointer' as const,
      startRect: Object.freeze({ x: 1, y: 2, width: 3, height: 4 }),
      baselineTranslate: '5px 6px',
      rectScale: Object.freeze({ x: 2, y: 3 }),
      scale: 1,
      candidates: Object.freeze([]) as unknown as readonly ManualEditSnapCandidate[],
      selectedParentId: null,
      selectedAncestorIds: Object.freeze([]) as readonly string[],
      latch: Object.freeze(createManualEditSnapLatch()),
    });
    const rawDelta = Object.freeze({ x: 7, y: 8 });

    expect(() => resolveManualEditMovement(movement, rawDelta)).not.toThrow();
    expect(movement.startRect).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(movement.latch).toEqual({ x: null, y: null });
    expect(rawDelta).toEqual({ x: 7, y: 8 });
  });

  it('is deterministic and treats each call as absolute from the session start', () => {
    const movement = session({ baselineTranslate: '10px 20px' });
    const first = resolveManualEditMovement(movement, { x: 5, y: 6 });
    const repeated = resolveManualEditMovement(movement, { x: 5, y: 6 });
    const later = resolveManualEditMovement(movement, { x: 7, y: 9 });

    expect(repeated).toEqual(first);
    expect(later.styles).toEqual({ translate: '17px 29px' });
    expect(later.translatedRect).toMatchObject({ x: 107, y: 209 });
  });

  it.each([
    ['undefined', undefined, '2px -3px'],
    ['empty', '', '2px -3px'],
    ['exact none', 'none', '2px -3px'],
    ['one axis', '10px', '12px -3px'],
    ['two axes', '10px 20px', '12px 17px'],
    ['negative', '-10px -20px', '-8px -23px'],
    ['fractional', '10.5px 20.5px', '13px 18px'],
    ['unsupported axes', '10% auto', '2px -3px'],
  ])('preserves %s baseline serialization', (_label, baselineTranslate, translate) => {
    expect(resolveManualEditMovement(session({ baselineTranslate }), { x: 2, y: -3 }).styles).toEqual({ translate });
  });

  it.each([
    ['missing', undefined, { x: 8, y: 9 }, '8px 9px'],
    ['zero', { x: 0, y: 0 }, { x: 8, y: 9 }, '8px 9px'],
    ['negative', { x: -2, y: -3 }, { x: 8, y: 9 }, '8px 9px'],
    ['NaN', { x: Number.NaN, y: Number.NaN }, { x: 8, y: 9 }, '8px 9px'],
    ['infinite', { x: Number.POSITIVE_INFINITY, y: Number.NEGATIVE_INFINITY }, { x: 8, y: 9 }, '8px 9px'],
    ['uniform', { x: 2, y: 2 }, { x: 8, y: 10 }, '4px 5px'],
    ['non-uniform', { x: 2, y: 3 }, { x: 8, y: 9 }, '4px 3px'],
  ])('preserves %s rect-scale handling', (_label, rectScale, rawDelta, translate) => {
    expect(resolveManualEditMovement(session({ rectScale }), rawDelta).styles).toEqual({ translate });
  });

  it('preserves positive and negative half-rounding asymmetry', () => {
    expect(resolveManualEditMovement(session(), { x: 0.5, y: 0 }).styles).toEqual({ translate: '1px 0px' });
    expect(resolveManualEditMovement(session(), { x: -0.5, y: 0 }).styles).toEqual({ translate: '' });
  });

  it('normalizes zero and exact cancellation to an empty translation', () => {
    expect(resolveManualEditMovement(session(), { x: 0, y: 0 }).styles).toEqual({ translate: '' });
    expect(resolveManualEditMovement(session({ baselineTranslate: '10px -4px' }), { x: -10, y: 4 }).styles).toEqual({
      translate: '',
    });
  });

  it('keeps translatedRect as unquantized intent geometry', () => {
    const result = resolveManualEditMovement(
      session({ startRect: { x: 20, y: 30, width: 40, height: 50 }, rectScale: { x: 2, y: 2 } }),
      { x: 1, y: 0 },
    );
    expect(result.translatedRect).toEqual({ x: 21, y: 30, width: 40, height: 50 });
    expect(result.styles).toEqual({ translate: '1px 0px' });
  });

  it('returns exactly the authoritative movement serializer styles when nothing snaps', () => {
    const movement = session({ baselineTranslate: '-3.5px 7px', rectScale: { x: 1.25, y: 2 } });
    const rawDelta = { x: 11, y: -5 };
    expect(resolveManualEditMovement(movement, rawDelta).styles).toEqual(
      moveCssCommitStyles({ deltaRect: rawDelta, baseTranslate: movement.baselineTranslate, rectScale: movement.rectScale }),
    );
  });
});

describe('magnetic edge alignment', () => {
  // Each candidate sits far away on the perpendicular axis so only the intended
  // axis matches. Correction is targetEdge - movingEdge at the raw position.
  it.each<[string, ManualEditRect, 'x' | 'y', ManualEditSnapEdge, ManualEditSnapEdge, number]>([
    ['left-to-left', r(105, 5000, 1000, 50), 'x', 'min', 'min', 5],
    ['left-to-right', r(53, 5000, 50, 50), 'x', 'min', 'max', 3],
    ['right-to-left', r(402, 5000, 50, 50), 'x', 'max', 'min', 2],
    ['right-to-right', r(347, 5000, 50, 50), 'x', 'max', 'max', -3],
    ['top-to-top', r(5000, 204, 50, 50), 'y', 'min', 'min', 4],
    ['top-to-bottom', r(5000, 163, 50, 40), 'y', 'min', 'max', 3],
    ['bottom-to-top', r(5000, 352, 50, 40), 'y', 'max', 'min', 2],
    ['bottom-to-bottom', r(5000, 307, 50, 40), 'y', 'max', 'max', -3],
  ])('snaps %s with the right correction sign', (_label, rect, axis, movingEdge, targetEdge, correction) => {
    const result = resolveManualEditMovement(session({ candidates: [cand('c', rect)] }), { x: 0, y: 0 });
    const match = result.matches[axis];
    expect(match).toMatchObject({ axis, targetId: 'c', movingEdge, targetEdge });
    expect(match?.correction).toBeCloseTo(correction);
    expect(result.appliedDelta[axis]).toBeCloseTo(correction);
    expect(result.matches[axis === 'x' ? 'y' : 'x']).toBeNull();
  });

  it('snaps x and y to different targets in the same frame', () => {
    const xTarget = cand('x-only', r(105, 5000, 50, 50));
    const yTarget = cand('y-only', r(5000, 204, 50, 50));
    const result = resolveManualEditMovement(session({ candidates: [xTarget, yTarget] }), { x: 0, y: 0 });
    expect(result.matches.x?.targetId).toBe('x-only');
    expect(result.matches.y?.targetId).toBe('y-only');
    expect(result.appliedDelta).toEqual({ x: 5, y: 4 });
    expect(result.guides.vertical).not.toBeNull();
    expect(result.guides.horizontal).not.toBeNull();
  });

  it('spans the guide across both boxes on the perpendicular axis', () => {
    const result = resolveManualEditMovement(session({ candidates: [cand('c', r(105, 180, 80, 200))] }), { x: 0, y: 0 });
    expect(result.guides.vertical).toEqual({ axis: 'x', x1: 105, x2: 105, y1: 180, y2: 380 });
    expect(result.guides.horizontal).toBeNull();
  });

  it.each<[number, number, boolean]>([
    [0.5, 12, true],
    [0.5, 14, false],
    [1, 6, true],
    [1, 7, false],
    [2, 3, true],
    [2, 4, false],
  ])('acquires only inside the %s-screen band (corr %s)', (scale, correction, snaps) => {
    const c = cand('c', r(100 + correction, 5000, 50, 50));
    const result = resolveManualEditMovement(session({ scale, candidates: [c] }), { x: 0, y: 0 });
    expect(result.matches.x !== null).toBe(snaps);
  });

  it('holds a latch through the release band and drops it past it', () => {
    const s = session({ candidates: [cand('c', r(100, 5000, 50, 50))] });
    const f1 = resolveManualEditMovement(s, { x: 0, y: 0 });
    expect(f1.matches.x).toMatchObject({ movingEdge: 'min', targetEdge: 'min', correction: 0 });
    // 8 px drift: past acquire (6), inside release (10) -> latch holds, edge stays pinned.
    const f2 = resolveManualEditMovement(s, { x: 8, y: 0 });
    expect(f2.matches.x?.targetId).toBe('c');
    expect(f2.appliedDelta.x).toBe(0);
    // 11 px drift: past release -> latch drops, movement goes raw.
    const f3 = resolveManualEditMovement(s, { x: 11, y: 0 });
    expect(f3.matches.x).toBeNull();
    expect(f3.appliedDelta.x).toBe(11);
  });

  it('suppresses the stationary original until the duplicate escapes its start band', () => {
    const original = cand('original', START_RECT, { isStationaryOriginal: true });
    const ordinary = cand('ordinary', r(105, 5000, 50, 50));
    const ordinarySession = session({ candidates: [original, ordinary] });

    const atOrigin = resolveManualEditMovement(ordinarySession, { x: 0, y: 0 });
    expect(atOrigin.matches.x?.targetId).toBe('ordinary');
    expect(ordinarySession.latch.y).toBeNull();
    expect(ordinarySession.stationaryOriginalEscaped).toBeUndefined();

    const s = session({ candidates: [original] });

    const atReleaseEdge = resolveManualEditMovement(s, { x: 10, y: 0 });
    expect(atReleaseEdge.matches.x).toBeNull();
    expect(atReleaseEdge.appliedDelta.x).toBe(10);
    expect(s.stationaryOriginalEscaped).toBeUndefined();

    const escaped = resolveManualEditMovement(s, { x: 11, y: 0 });
    expect(escaped.matches.x).toBeNull();
    expect(s.stationaryOriginalEscaped).toBe(true);

    const returned = resolveManualEditMovement(s, { x: 5, y: 0 });
    expect(returned.matches.x).toMatchObject({ targetId: 'original', correction: -5 });
    expect(returned.appliedDelta.x).toBe(0);

    const alt = resolveManualEditMovement(s, { x: 5, y: 0 }, { alt: true });
    expect(alt.matches).toEqual({ x: null, y: null });
    expect(alt.appliedDelta).toEqual({ x: 5, y: 0 });
  });

  it('latches per axis independently', () => {
    const s = session({ candidates: [cand('c', r(100, 5000, 50, 50))] });
    resolveManualEditMovement(s, { x: 0, y: 0 });
    expect(s.latch.x).toMatchObject({ targetId: 'c', movingEdge: 'min', targetEdge: 'min' });
    expect(s.latch.y).toBeNull();
  });

  it('switches to a rival that is closer by at least the switch advantage', () => {
    const s = session({ candidates: [cand('a', r(100, 5000, 50, 50)), cand('b', r(103, 5000, 50, 50))] });
    expect(resolveManualEditMovement(s, { x: 0, y: 0 }).matches.x?.targetId).toBe('a');
    const f2 = resolveManualEditMovement(s, { x: 3.5, y: 0 });
    expect(f2.matches.x?.targetId).toBe('b');
    expect(f2.appliedDelta.x).toBeCloseTo(3);
  });

  it('keeps the latch when a rival is closer by less than the switch advantage', () => {
    const s = session({ candidates: [cand('a', r(100, 5000, 50, 50)), cand('b', r(101.5, 5000, 50, 50))] });
    resolveManualEditMovement(s, { x: 0, y: 0 });
    const f2 = resolveManualEditMovement(s, { x: 1, y: 0 });
    expect(f2.matches.x?.targetId).toBe('a');
    expect(f2.appliedDelta.x).toBe(0);
  });

  it('prefers a peer over an unrelated candidate at equal distance', () => {
    const peer = cand('peer', r(105, 210, 50, 130), { parentId: 'P' });
    const unrelated = cand('unrelated', r(105, 210, 50, 130), { parentId: 'Q' });
    const result = resolveManualEditMovement(
      session({ candidates: [unrelated, peer], selectedParentId: 'P' }),
      { x: 0, y: 0 },
    );
    expect(result.matches.x?.targetId).toBe('peer');
  });

  it('prefers the candidate with more perpendicular overlap at equal distance', () => {
    const more = cand('more', r(105, 220, 50, 100)); // overlaps moving [200,350] by 100
    const less = cand('less', r(105, 260, 50, 300)); // overlaps by 90
    const result = resolveManualEditMovement(session({ candidates: [less, more] }), { x: 0, y: 0 });
    expect(result.matches.x?.targetId).toBe('more');
  });

  it('breaks remaining ties by document order before id', () => {
    const early = cand('zzz', r(105, 210, 50, 130), { index: 0 });
    const late = cand('aaa', r(105, 210, 50, 130), { index: 5 });
    const result = resolveManualEditMovement(session({ candidates: [late, early] }), { x: 0, y: 0 });
    expect(result.matches.x?.targetId).toBe('zzz');
  });

  it('returns raw movement with no matches or guides when Alt is held', () => {
    const c = cand('c', r(105, 200, 50, 150));
    const result = resolveManualEditMovement(session({ candidates: [c] }), { x: 0, y: 0 }, { alt: true });
    expect(result.matches).toEqual({ x: null, y: null });
    expect(result.guides).toEqual({ vertical: null, horizontal: null });
    expect(result.appliedDelta).toEqual({ x: 0, y: 0 });
  });

  it('never snaps when the source is keyboard', () => {
    const c = cand('c', r(105, 5000, 50, 50));
    const keyboard = resolveManualEditMovement(session({ source: 'keyboard', candidates: [c] }), { x: 0, y: 0 });
    expect(keyboard.matches.x).toBeNull();
    expect(keyboard.appliedDelta.x).toBe(0);
    const pointer = resolveManualEditMovement(session({ source: 'pointer', candidates: [c] }), { x: 0, y: 0 });
    expect(pointer.matches.x?.targetId).toBe('c');
  });

  it('produces identical output on repeated resolution of the same delta', () => {
    const s = session({ candidates: [cand('c', r(105, 5000, 50, 50))] });
    const first = resolveManualEditMovement(s, { x: 0, y: 0 });
    const again = resolveManualEditMovement(s, { x: 0, y: 0 });
    expect(again).toEqual(first);
  });

  it('serializes a snapped axis with sub-pixel precision', () => {
    const result = resolveManualEditMovement(session({ candidates: [cand('c', r(105.7, 5000, 50, 50))] }), { x: 0, y: 0 });
    expect(result.appliedDelta.x).toBeCloseTo(5.7);
    expect(result.styles).toEqual({ translate: '5.7px 0px' });
  });

  it('applies non-uniform rectScale before fractional serialization', () => {
    const result = resolveManualEditMovement(
      session({ candidates: [cand('c', r(105.7, 5000, 50, 50))], rectScale: { x: 2, y: 1 } }),
      { x: 0, y: 0 },
    );
    expect(result.styles).toEqual({ translate: '2.85px 0px' });
  });
});

describe('buildManualEditMovementCandidates', () => {
  it('excludes the selection, descendants, hidden, disconnected, and degenerate rects', () => {
    const targets: ManualEditTarget[] = [
      makeTarget('sel', r(0, 0, 10, 10), { parentId: 'root', ancestorIds: ['root'] }),
      makeTarget('peer', r(20, 0, 10, 10), { parentId: 'root', ancestorIds: ['root'] }),
      makeTarget('child', r(1, 1, 5, 5), { parentId: 'sel', ancestorIds: ['sel', 'root'] }),
      makeTarget('hidden', r(30, 0, 10, 10), { isHidden: true, ancestorIds: ['root'] }),
      makeTarget('gone', r(40, 0, 10, 10), { isConnected: false, ancestorIds: ['root'] }),
      makeTarget('nan', r(Number.NaN, 0, 10, 10), { ancestorIds: ['root'] }),
      makeTarget('flat', r(50, 0, 0, 10), { ancestorIds: ['root'] }),
    ];
    const { candidates, selectedParentId, selectedAncestorIds } = buildManualEditMovementCandidates(targets, 'sel');
    expect(candidates.map((c) => c.id)).toEqual(['peer']);
    expect(selectedParentId).toBe('root');
    expect(selectedAncestorIds).toEqual(['root']);
  });

  it('returns no candidates when the selection lacks structural metadata', () => {
    const targets: ManualEditTarget[] = [
      makeTarget('sel', r(0, 0, 10, 10), { ancestorIds: undefined }),
      makeTarget('peer', r(20, 0, 10, 10), { ancestorIds: [] }),
    ];
    expect(buildManualEditMovementCandidates(targets, 'sel').candidates).toEqual([]);
  });

  it('carries document order into the candidate index', () => {
    const targets: ManualEditTarget[] = [
      makeTarget('sel', r(0, 0, 10, 10), { ancestorIds: [] }),
      makeTarget('a', r(20, 0, 10, 10), { ancestorIds: [] }),
      makeTarget('b', r(40, 0, 10, 10), { ancestorIds: [] }),
    ];
    const { candidates } = buildManualEditMovementCandidates(targets, 'sel');
    expect(candidates.map((c) => [c.id, c.index])).toEqual([['a', 1], ['b', 2]]);
  });

  it('includes the selected target as a stationary original only when opted in', () => {
    const targets: ManualEditTarget[] = [
      makeTarget('original', r(0, 0, 10, 10), { ancestorIds: ['root'] }),
      makeTarget('peer', r(20, 0, 10, 10), { ancestorIds: ['root'] }),
      makeTarget('child', r(1, 1, 5, 5), { parentId: 'original', ancestorIds: ['original', 'root'] }),
    ];

    expect(buildManualEditMovementCandidates(targets, 'original').candidates.map((c) => c.id)).toEqual(['peer']);
    const optedIn = buildManualEditMovementCandidates(targets, 'original', { stationaryOriginalId: 'original' }).candidates;
    expect(optedIn).toEqual([
      expect.objectContaining({ id: 'original', isStationaryOriginal: true, index: 0 }),
      expect.objectContaining({ id: 'peer', index: 1 }),
    ]);
    expect(optedIn[1]).not.toHaveProperty('isStationaryOriginal');
  });
});
