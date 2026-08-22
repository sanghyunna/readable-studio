import { describe, expect, it } from 'vitest';
import {
  RESIZE_HANDLE_DIRECTIONS,
  moveCssCommitStyles,
  parseTranslate,
  resizeCssCommitStyles,
  resizeDragSize,
  resizeHandlePositions,
} from '../../src/edit-mode/resize-geometry';

describe('resizeHandlePositions', () => {
  it('places all 8 handle centers around the rect', () => {
    const rect = { left: 100, top: 200, width: 40, height: 20 };
    const positions = resizeHandlePositions(rect);

    expect(positions.nw).toEqual({ left: 100, top: 200 });
    expect(positions.n).toEqual({ left: 120, top: 200 });
    expect(positions.ne).toEqual({ left: 140, top: 200 });
    expect(positions.e).toEqual({ left: 140, top: 210 });
    expect(positions.se).toEqual({ left: 140, top: 220 });
    expect(positions.s).toEqual({ left: 120, top: 220 });
    expect(positions.sw).toEqual({ left: 100, top: 220 });
    expect(positions.w).toEqual({ left: 100, top: 210 });

    expect(RESIZE_HANDLE_DIRECTIONS).toHaveLength(8);
  });

  it('keeps all 8 handle centers distinct for a zero-sized element', () => {
    const positions = resizeHandlePositions({ left: 10, top: 20, width: 0, height: 0 });
    const seen = new Set(RESIZE_HANDLE_DIRECTIONS.map((d) => `${positions[d].left},${positions[d].top}`));
    expect(seen.size).toBe(8);
  });
});

describe('resizeDragSize', () => {
  const base = { startWidth: 100, startHeight: 50, scale: 1, lockAspect: false };

  it('e: positive deltaX grows width, height unchanged', () => {
    const { width, height } = resizeDragSize({ ...base, direction: 'e', deltaX: 20, deltaY: 0 });
    expect(width).toBe(120);
    expect(height).toBe(50);
  });

  it('w: negative deltaX grows width (inverted)', () => {
    const { width } = resizeDragSize({ ...base, direction: 'w', deltaX: -20, deltaY: 0 });
    expect(width).toBe(120);
  });

  it('w: positive deltaX shrinks width', () => {
    const { width } = resizeDragSize({ ...base, direction: 'w', deltaX: 20, deltaY: 0 });
    expect(width).toBe(80);
  });

  it('s: positive deltaY grows height', () => {
    const { height } = resizeDragSize({ ...base, direction: 's', deltaX: 0, deltaY: 20 });
    expect(height).toBe(70);
  });

  it('n: negative deltaY grows height (inverted)', () => {
    const { height } = resizeDragSize({ ...base, direction: 'n', deltaX: 0, deltaY: -20 });
    expect(height).toBe(70);
  });

  it('n: positive deltaY shrinks height', () => {
    const { height } = resizeDragSize({ ...base, direction: 'n', deltaX: 0, deltaY: 20 });
    expect(height).toBe(30);
  });

  it('corners combine both axes with correct signs: ne (+dx,-dy)', () => {
    const { width, height } = resizeDragSize({ ...base, direction: 'ne', deltaX: 10, deltaY: -10 });
    expect(width).toBe(110);
    expect(height).toBe(60);
  });

  it('corners combine both axes with correct signs: nw (-dx,-dy)', () => {
    const { width, height } = resizeDragSize({ ...base, direction: 'nw', deltaX: -10, deltaY: -10 });
    expect(width).toBe(110);
    expect(height).toBe(60);
  });

  it('corners combine both axes with correct signs: se (+dx,+dy)', () => {
    const { width, height } = resizeDragSize({ ...base, direction: 'se', deltaX: 10, deltaY: 10 });
    expect(width).toBe(110);
    expect(height).toBe(60);
  });

  it('corners combine both axes with correct signs: sw (-dx,+dy)', () => {
    const { width, height } = resizeDragSize({ ...base, direction: 'sw', deltaX: -10, deltaY: 10 });
    expect(width).toBe(110);
    expect(height).toBe(60);
  });

  it('divides host delta by scale', () => {
    const { width } = resizeDragSize({ ...base, direction: 'e', deltaX: 40, deltaY: 0, scale: 2 });
    expect(width).toBe(120);
  });

  it('treats scale<=0 as scale 1', () => {
    const { width } = resizeDragSize({ ...base, direction: 'e', deltaX: 20, deltaY: 0, scale: 0 });
    expect(width).toBe(120);
    const negScale = resizeDragSize({ ...base, direction: 'e', deltaX: 20, deltaY: 0, scale: -3 });
    expect(negScale.width).toBe(120);
  });

  it('clamps to a minimum of 8px', () => {
    const { width } = resizeDragSize({ ...base, direction: 'e', deltaX: -1000, deltaY: 0 });
    expect(width).toBe(8);
    const { height } = resizeDragSize({ ...base, direction: 's', deltaX: 0, deltaY: -1000 });
    expect(height).toBe(8);
  });

  it('rounds to the nearest integer', () => {
    const { width } = resizeDragSize({ ...base, direction: 'e', deltaX: 10.6, deltaY: 0 });
    expect(width).toBe(111);
  });

  it('does not lock aspect on edge handles even if requested', () => {
    const { width, height } = resizeDragSize({
      ...base, direction: 'e', deltaX: 50, deltaY: 0, lockAspect: true,
    });
    expect(width).toBe(150);
    expect(height).toBe(50);
  });

  it('locks aspect on corners: dominant axis (larger scaled delta) drives the other', () => {
    // startWidth 100, startHeight 50, ratio 2. deltaX dominant -> width=130, height=width/ratio=65
    const { width, height } = resizeDragSize({
      ...base, direction: 'se', deltaX: 30, deltaY: 5, lockAspect: true,
    });
    expect(width).toBe(130);
    expect(height).toBe(65);
  });

  it('locks aspect on corners: when deltaY dominant, width follows height', () => {
    // startWidth 100, startHeight 50, ratio 2. deltaY dominant -> height=80, width=height*ratio=160
    const { width, height } = resizeDragSize({
      ...base, direction: 'se', deltaX: 5, deltaY: 30, lockAspect: true,
    });
    expect(height).toBe(80);
    expect(width).toBe(160);
  });
});

describe('resizeCssCommitStyles', () => {
  const identity = {
    size: { width: 120, height: 50 },
    startSize: { width: 120, height: 50 },
  };

  it('e/w commit width only', () => {
    expect(resizeCssCommitStyles({ direction: 'e', ...identity })).toEqual({ width: '120px' });
    expect(resizeCssCommitStyles({ direction: 'w', ...identity })).toEqual({ width: '120px' });
  });

  it('n/s commit height only', () => {
    expect(resizeCssCommitStyles({ direction: 'n', ...identity })).toEqual({ height: '50px' });
    expect(resizeCssCommitStyles({ direction: 's', ...identity })).toEqual({ height: '50px' });
  });

  it('corners commit both width and height', () => {
    for (const direction of ['nw', 'ne', 'se', 'sw'] as const) {
      expect(resizeCssCommitStyles({ direction, ...identity })).toEqual({
        width: '120px',
        height: '50px',
      });
    }
  });

  it('applies the drag delta to the CSS base size divided by rectScale', () => {
    // rect 500x100 under a 1.25x ancestor transform; CSS box 400x80.
    // +40/+20 rect px is +32/+16 CSS px.
    expect(resizeCssCommitStyles({
      direction: 'se',
      size: { width: 540, height: 120 },
      startSize: { width: 500, height: 100 },
      baseStyles: { width: '400px', height: '80px' },
      rectScale: { x: 1.25, y: 1.25 },
    })).toEqual({ width: '432px', height: '96px' });
  });

  it('keeps box-sizing padding out of the committed value via the delta form', () => {
    // content-box: CSS width 400 renders as a 440px rect (padding 2x20), no
    // transform. Dragging +40 must write 440, not the raw rect width 480.
    expect(resizeCssCommitStyles({
      direction: 'e',
      size: { width: 480, height: 100 },
      startSize: { width: 440, height: 100 },
      baseStyles: { width: '400px' },
      rectScale: { x: 1, y: 1 },
    })).toEqual({ width: '440px' });
  });

  it('falls back to rect size divided by rectScale when the CSS base is not px', () => {
    expect(resizeCssCommitStyles({
      direction: 'e',
      size: { width: 540, height: 100 },
      startSize: { width: 500, height: 100 },
      baseStyles: { width: 'auto' },
      rectScale: { x: 1.25, y: 1.25 },
    })).toEqual({ width: '432px' });
  });

  it('anchors on computedSize when the base CSS is not px (content-box safe)', () => {
    // No inline width; content-box padding makes rect 440 for CSS width 400.
    // The absolute fallback (rect/k = 480) would jump the element by the
    // padding+border constant; the computed px baseline keeps the delta form.
    expect(resizeCssCommitStyles({
      direction: 'e',
      size: { width: 480, height: 100 },
      startSize: { width: 440, height: 100 },
      baseStyles: { width: 'auto' },
      computedSize: { width: '400px' },
      rectScale: { x: 1, y: 1 },
    })).toEqual({ width: '440px' });
  });

  it('anchors on computedSize when the inline base disagrees with it (clamped commit)', () => {
    // A previous drag committed width:900px but max-width clamped the element
    // at 600px. Anchoring on the inline 900 creates a dead zone: dragging
    // inward changes nothing until the value drops under the clamp.
    expect(resizeCssCommitStyles({
      direction: 'e',
      size: { width: 550, height: 100 },
      startSize: { width: 600, height: 100 },
      baseStyles: { width: '900px' },
      computedSize: { width: '600px' },
    })).toEqual({ width: '550px' });
  });

  it('keeps the inline base when it agrees with computedSize within 1px', () => {
    expect(resizeCssCommitStyles({
      direction: 'e',
      size: { width: 540, height: 100 },
      startSize: { width: 500, height: 100 },
      baseStyles: { width: '400px' },
      computedSize: { width: '400.4px' },
      rectScale: { x: 1.25, y: 1.25 },
    })).toEqual({ width: '432px' });
  });

  it('treats missing or degenerate rectScale as 1 and clamps to at least 1px', () => {
    expect(resizeCssCommitStyles({
      direction: 'e',
      size: { width: 540, height: 100 },
      startSize: { width: 500, height: 100 },
      baseStyles: { width: '400px' },
      rectScale: { x: 0, y: Number.NaN },
    })).toEqual({ width: '440px' });
    expect(resizeCssCommitStyles({
      direction: 'e',
      size: { width: 8, height: 100 },
      startSize: { width: 500, height: 100 },
      baseStyles: { width: '2px' },
    })).toEqual({ width: '1px' });
  });
});

describe('resizeCssCommitStyles anchor compensation (west/north drags)', () => {
  // CSS width/height alone always grow an in-flow element east/south: the
  // grabbed west/north edge would stay put while the cursor walks away. The
  // commit shifts the box back via margins so the grabbed edge tracks the
  // pointer and the opposite edge stays fixed.
  const westDrag = {
    size: { width: 540, height: 100 },
    startSize: { width: 500, height: 100 },
    baseStyles: { width: '400px', height: '80px' },
  };

  it('w: compensates marginLeft by the CSS width delta', () => {
    expect(resizeCssCommitStyles({
      ...westDrag,
      direction: 'w',
      baseMargins: { marginLeft: '10px' },
      rectScale: { x: 1.25, y: 1.25 },
    })).toEqual({ width: '432px', marginLeft: '-22px' });
  });

  it('n: compensates marginTop by the CSS height delta', () => {
    expect(resizeCssCommitStyles({
      direction: 'n',
      size: { width: 500, height: 130 },
      startSize: { width: 500, height: 100 },
      baseStyles: { height: '100px' },
      baseMargins: { marginTop: '0px' },
    })).toEqual({ height: '130px', marginTop: '-30px' });
  });

  it('nw: compensates both margins', () => {
    expect(resizeCssCommitStyles({
      direction: 'nw',
      size: { width: 540, height: 120 },
      startSize: { width: 500, height: 100 },
      baseStyles: { width: '500px', height: '100px' },
      baseMargins: { marginLeft: '0px', marginTop: '0px' },
    })).toEqual({
      width: '540px', height: '120px',
      marginLeft: '-40px', marginTop: '-20px',
    });
  });

  it('treats an empty margin base as 0', () => {
    expect(resizeCssCommitStyles({
      ...westDrag,
      direction: 'w',
      baseMargins: { marginLeft: '' },
    })).toEqual({ width: '440px', marginLeft: '-40px' });
  });

  it('skips compensation when the margin base is not px (inline auto)', () => {
    expect(resizeCssCommitStyles({
      ...westDrag,
      direction: 'w',
      baseMargins: { marginLeft: 'auto' },
    })).toEqual({ width: '440px' });
  });

  it('pins a nonzero opposite margin so auto-centering slack cannot jump the box', () => {
    // margin: 0 auto centering resolves to a used px on both sides; writing
    // only marginLeft would hand ALL slack to the still-auto marginRight.
    expect(resizeCssCommitStyles({
      ...westDrag,
      direction: 'w',
      baseMargins: { marginLeft: '174px', marginRight: '174px' },
    })).toEqual({ width: '440px', marginLeft: '134px', marginRight: '174px' });
  });

  it('does not pin a zero opposite margin', () => {
    expect(resizeCssCommitStyles({
      ...westDrag,
      direction: 'w',
      baseMargins: { marginLeft: '0px', marginRight: '0px' },
    })).toEqual({ width: '440px', marginLeft: '-40px' });
  });

  it('east/south drags emit no margins', () => {
    // base height 80px + (120-100) delta = 100px.
    expect(resizeCssCommitStyles({
      ...westDrag,
      direction: 'se',
      size: { width: 540, height: 120 },
      baseMargins: { marginLeft: '10px', marginTop: '10px' },
    })).toEqual({ width: '440px', height: '100px' });
  });

  it('emits no margins at all when baseMargins is not provided', () => {
    expect(resizeCssCommitStyles({ ...westDrag, direction: 'w' })).toEqual({ width: '440px' });
  });

  it('sw compensates only the west axis', () => {
    const styles = resizeCssCommitStyles({
      direction: 'sw',
      size: { width: 540, height: 120 },
      startSize: { width: 500, height: 100 },
      baseStyles: { width: '500px', height: '100px' },
      baseMargins: { marginLeft: '0px', marginTop: '0px' },
    });
    expect(styles.marginLeft).toBe('-40px');
    expect(styles.marginTop).toBeUndefined();
  });
});

describe('resizeCssCommitStyles flex pinning', () => {
  const drag = {
    size: { width: 250, height: 120 },
    startSize: { width: 200, height: 100 },
    baseStyles: { width: '200px', height: '100px' },
  };

  it('pins flex on a main-axis width commit for flex-row items', () => {
    // A bare width on a flex-row item is a suggestion: flex-grow/shrink win.
    // The commit must also detach the item (flex: none) or the drag result
    // silently snaps back to whatever the flex algorithm decides.
    const styles = resizeCssCommitStyles({ ...drag, direction: 'e', flexItemAxis: 'row' });
    expect(styles.width).toBe('250px');
    expect(styles.height).toBeUndefined();
    expect(styles.flex).toBe('none');
  });

  it('does not pin flex on a cross-axis commit', () => {
    // Height on a flex-row item is the cross axis: an explicit height already
    // wins over align-items stretch, no pinning needed.
    const styles = resizeCssCommitStyles({ ...drag, direction: 's', flexItemAxis: 'row' });
    expect(styles.height).toBe('120px');
    expect(styles.width).toBeUndefined();
    expect(styles.flex).toBeUndefined();
  });

  it('pins flex on a main-axis height commit for flex-column items', () => {
    const styles = resizeCssCommitStyles({ ...drag, direction: 's', flexItemAxis: 'column' });
    expect(styles.height).toBe('120px');
    expect(styles.flex).toBe('none');
  });

  it('pins flex on corner commits for flex items', () => {
    const styles = resizeCssCommitStyles({ ...drag, direction: 'se', flexItemAxis: 'row' });
    expect(styles.width).toBe('250px');
    expect(styles.height).toBe('120px');
    expect(styles.flex).toBe('none');
  });

  it('leaves non-flex items unpinned', () => {
    const styles = resizeCssCommitStyles({ ...drag, direction: 'se' });
    expect(styles.flex).toBeUndefined();
    const nullAxis = resizeCssCommitStyles({ ...drag, direction: 'e', flexItemAxis: null });
    expect(nullAxis.flex).toBeUndefined();
  });
});

describe('parseTranslate', () => {
  it('treats empty/undefined/none as {0,0}', () => {
    expect(parseTranslate('')).toEqual({ x: 0, y: 0 });
    expect(parseTranslate(undefined)).toEqual({ x: 0, y: 0 });
    expect(parseTranslate('none')).toEqual({ x: 0, y: 0 });
  });

  it('parses two px tokens', () => {
    expect(parseTranslate('10px 20px')).toEqual({ x: 10, y: 20 });
  });

  it('defaults y to 0 when only one token', () => {
    expect(parseTranslate('10px')).toEqual({ x: 10, y: 0 });
  });

  it('parses negative values', () => {
    expect(parseTranslate('-5px -8px')).toEqual({ x: -5, y: -8 });
  });

  it('treats a non-px token as 0 for that axis', () => {
    expect(parseTranslate('10% 20px')).toEqual({ x: 0, y: 20 });
  });

  it('parses fractional px', () => {
    expect(parseTranslate('10.5px 20.5px')).toEqual({ x: 10.5, y: 20.5 });
  });
});

describe('moveCssCommitStyles fractional flag', () => {
  it('keeps up to three decimals on a snapped axis', () => {
    expect(moveCssCommitStyles({
      deltaRect: { x: 5.7, y: 0 },
      baseTranslate: undefined,
      fractional: { x: true },
    })).toEqual({ translate: '5.7px 0px' });
  });

  it('rounds a free axis to a whole px even when the other axis is fractional', () => {
    expect(moveCssCommitStyles({
      deltaRect: { x: 5.7, y: 3.4 },
      baseTranslate: undefined,
      fractional: { x: true, y: false },
    })).toEqual({ translate: '5.7px 3px' });
  });

  it('rounds both axes when neither is flagged fractional', () => {
    expect(moveCssCommitStyles({
      deltaRect: { x: 5.7, y: 3.4 },
      baseTranslate: undefined,
    })).toEqual({ translate: '6px 3px' });
  });

  it('applies rectScale before fractional serialization', () => {
    // 5.7 rect px / scale 2 = 2.85 CSS px, preserved at 3 decimals.
    expect(moveCssCommitStyles({
      deltaRect: { x: 5.7, y: 0 },
      baseTranslate: undefined,
      rectScale: { x: 2, y: 1 },
      fractional: { x: true },
    })).toEqual({ translate: '2.85px 0px' });
  });

  it('normalizes a near-zero fractional result to an empty translate', () => {
    expect(moveCssCommitStyles({
      deltaRect: { x: 0.0004, y: -0.0004 },
      baseTranslate: undefined,
      fractional: { x: true, y: true },
    })).toEqual({ translate: '' });
  });
});

describe('moveCssCommitStyles', () => {
  it('no base, delta only, scale 1', () => {
    expect(moveCssCommitStyles({ deltaRect: { x: 30, y: 40 }, baseTranslate: undefined })).toEqual({
      translate: '30px 40px',
    });
  });

  it('adds delta onto an existing base', () => {
    expect(moveCssCommitStyles({
      deltaRect: { x: 5, y: -5 },
      baseTranslate: '10px 20px',
    })).toEqual({ translate: '15px 15px' });
  });

  it('divides delta by rectScale', () => {
    expect(moveCssCommitStyles({
      deltaRect: { x: 20, y: 20 },
      baseTranslate: undefined,
      rectScale: { x: 2, y: 2 },
    })).toEqual({ translate: '10px 10px' });
  });

  it('emits empty string when result is zero', () => {
    expect(moveCssCommitStyles({ deltaRect: { x: 0, y: 0 }, baseTranslate: undefined })).toEqual({
      translate: '',
    });
  });

  it('normalizes to empty string when base+delta cancel out', () => {
    expect(moveCssCommitStyles({
      deltaRect: { x: -10, y: 0 },
      baseTranslate: '10px 0px',
    })).toEqual({ translate: '' });
  });

  it('rounds to nearest integer', () => {
    expect(moveCssCommitStyles({
      deltaRect: { x: 3.4, y: 3.6 },
      baseTranslate: undefined,
    })).toEqual({ translate: '3px 4px' });
  });
});
