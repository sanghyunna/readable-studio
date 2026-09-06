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
});
