// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaretFloatingLayer } from '../../src/components/composer/CaretFloatingLayer';

function rect({
  left,
  top,
  width,
  height,
}: {
  left: number;
  top: number;
  width: number;
  height: number;
}): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('CaretFloatingLayer', () => {
  it('is the single floating-layer owner used by HomeHero', () => {
    const homeHeroSource = readFileSync(
      resolve(process.cwd(), 'src/components/HomeHero.tsx'),
      'utf8',
    );

    expect(homeHeroSource).toContain("import { CaretFloatingLayer } from './composer/CaretFloatingLayer';");
    expect(homeHeroSource).toContain('<CaretFloatingLayer');
    expect(homeHeroSource).not.toContain('setPickerPosition');
    expect(homeHeroSource).not.toContain("window.addEventListener('resize', place)");
  });

  it('owns measured control placement, throttled movement, and immediate teardown', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 700 });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(200);

    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    let controlRect = rect({ left: 100, top: 500, width: 80, height: 30 });
    const control = document.createElement('button');
    control.getBoundingClientRect = () => controlRect;
    const anchorRef = { current: control };

    const view = render(
      <CaretFloatingLayer caret={null} anchorRef={anchorRef} open>
        <div data-testid="panel" />
      </CaretFloatingLayer>,
    );

    const layer = document.body.querySelector<HTMLElement>('.caret-floating-layer');
    expect(layer).not.toBeNull();
    expect(layer?.dataset.placement).toBe('above');
    expect(layer?.style.left).toBe('100px');
    expect(layer?.style.top).toBe('292px');
    expect(layer?.style.width).toBe('300px');
    expect(layer?.style.getPropertyValue('--cfl-max-h')).toBe('460px');

    controlRect = rect({ left: 100, top: 400, width: 80, height: 30 });
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('scroll'));
    expect(frames).toHaveLength(1);
    act(() => frames[0]?.(0));

    expect(layer?.dataset.placement).toBe('below');
    expect(layer?.style.top).toBe('438px');
    expect(layer?.style.getPropertyValue('--cfl-max-h')).toBe('250px');

    view.rerender(
      <CaretFloatingLayer caret={null} anchorRef={anchorRef} open={false}>
        <div data-testid="panel" />
      </CaretFloatingLayer>,
    );
    expect(document.body.querySelector('.caret-floating-layer')).toBeNull();
  });

  it('preserves caret-first placement and boundary clamping for workspace composers', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(420);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(180);

    render(
      <CaretFloatingLayer
        caret={{ left: 760, right: 760, top: 520, bottom: 540 }}
        open
      >
        <div />
      </CaretFloatingLayer>,
    );

    const layer = document.body.querySelector<HTMLElement>('.caret-floating-layer');
    expect(layer?.dataset.placement).toBe('above');
    expect(layer?.style.left).toBe('372px');
    expect(layer?.style.top).toBe('332px');
    expect(layer?.style.getPropertyValue('--cfl-max-h')).toBe('460px');
  });

  it.each<[number, string]>([[800, '640px'], [500, '484px']])('clamps a wider preview to a %i-pixel composer boundary', (boundaryWidth, expectedWidth) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 700 });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(200);
    const boundary = document.createElement('div');
    boundary.getBoundingClientRect = () => rect({ left: 100, top: 400, width: boundaryWidth, height: 240 });

    render(
      <CaretFloatingLayer
        caret={{ left: 150, right: 150, top: 520, bottom: 540 }}
        boundaryRef={{ current: boundary }} preferredWidth={640} open
      >
        <div />
      </CaretFloatingLayer>,
    );

    const layer = document.body.querySelector<HTMLElement>('.caret-floating-layer');
    expect(layer?.style.width).toBe(expectedWidth);
    expect(Number.parseFloat(layer?.style.left ?? '')).toBeGreaterThanOrEqual(108);
    expect(Number.parseFloat(layer?.style.left ?? '') + Number.parseFloat(expectedWidth)).toBeLessThanOrEqual(100 + boundaryWidth - 8);
  });

  it('clamps a control-anchored preview and responds to an explicit width change', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 700 });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(640);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(200);
    const control = document.createElement('button');
    control.getBoundingClientRect = () => rect({ left: 450, top: 500, width: 80, height: 30 });
    const boundary = document.createElement('div');
    boundary.getBoundingClientRect = () => rect({ left: 100, top: 400, width: 500, height: 240 });
    const props = { caret: null, anchorRef: { current: control }, boundaryRef: { current: boundary }, open: true };
    const view = render(<CaretFloatingLayer {...props} preferredWidth={640}><div /></CaretFloatingLayer>);
    const layer = document.body.querySelector<HTMLElement>('.caret-floating-layer');

    expect(layer?.style.width).toBe('484px');
    expect(layer?.style.left).toBe('108px');

    view.rerender(<CaretFloatingLayer {...props} preferredWidth={420}><div /></CaretFloatingLayer>);
    expect(layer?.style.width).toBe('420px');
    expect(layer?.style.left).toBe('172px');
  });

  it.each(['caret', 'control'] as const)('keeps a %s preview inside a 736px viewport while its composer extends beyond it', (anchor) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 736 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(444);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(347);
    const boundary = document.createElement('div');
    // The failing browser trace recorded left 310 + width 444 = 754; these
    // boundary edges reproduce those values through the previous calculation.
    boundary.getBoundingClientRect = () => rect({ left: 302, top: 700, width: 460, height: 150 });
    const control = document.createElement('button');
    control.getBoundingClientRect = () => rect({ left: 330, top: 771, width: 80, height: 20 });
    render(
      <CaretFloatingLayer
        caret={{ left: 330, right: 330, top: 771, bottom: 791 }}
        anchorRef={anchor === 'control' ? { current: control } : undefined}
        boundaryRef={{ current: boundary }} preferredWidth={640} open
      ><div /></CaretFloatingLayer>,
    );

    const layer = document.body.querySelector<HTMLElement>('.caret-floating-layer');
    expect(layer?.style.left).toBe('310px');
    expect(layer?.style.width).toBe(anchor === 'caret' ? '418px' : '414px');
    expect(Number.parseFloat(layer?.style.left ?? '') + Number.parseFloat(layer?.style.width ?? '')).toBeLessThanOrEqual(736);
  });

  it('remeasures content height at the same caret and cleans up its resize subscription', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
    let height = 200;
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(444);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => height);
    let notifyResize: (() => void) | undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { notifyResize = callback; }
      observe = observe;
      disconnect = disconnect;
    });
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancelFrame = vi.fn();
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);
    const props = { caret: { left: 330, right: 330, top: 800, bottom: 820 }, preferredWidth: 444 };
    const view = render(<CaretFloatingLayer {...props} open><div /></CaretFloatingLayer>);
    const layer = document.body.querySelector<HTMLElement>('.caret-floating-layer');
    expect(layer?.style.top).toBe('592px');

    height = 400;
    notifyResize?.();
    notifyResize?.();
    act(() => frames[0]?.(0));

    expect(layer?.style.top).toBe('392px');
    expect(Number.parseFloat(layer?.style.top ?? '') + height).toBeLessThanOrEqual(900);
    expect(observe).toHaveBeenCalledWith(layer);
    expect(frames).toHaveLength(1);

    notifyResize?.();
    view.rerender(<CaretFloatingLayer {...props} open={false}><div /></CaretFloatingLayer>);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(cancelFrame).toHaveBeenCalledWith(2);
  });
});
