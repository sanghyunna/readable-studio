import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const transitionCss = readFileSync(
  new URL('../../src/components/WorkspaceTransition.module.css', import.meta.url),
  'utf8',
);

function ruleBody(selector: string, source = transitionCss): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]+)\\}`).exec(source);
  if (!match?.[1]) throw new Error(`Missing CSS rule: ${selector}`);
  return match[1];
}

function reducedMotionBlock(source = transitionCss): string {
  const start = source.indexOf('@media (prefers-reduced-motion: reduce)');
  if (start === -1) throw new Error('Missing prefers-reduced-motion block');
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error('Unterminated prefers-reduced-motion block');
}

describe('Hub -> workspace transition motion contract', () => {
  it('animates the incoming workspace surface inside the 200-320ms band with the product easing', () => {
    const workspace = ruleBody(".surface[data-transition='workspace']");
    const match = /animation:\s*workspaceEnter\s+(\d+)ms\s+var\(--ease-out\)\s+both\s*;/.exec(
      workspace,
    );

    expect(match).not.toBeNull();
    const duration = Number(match?.[1]);
    expect(duration).toBeGreaterThanOrEqual(200);
    expect(duration).toBeLessThanOrEqual(320);
  });

  it('animates the return to the Hub in the opposite direction, same band and easing', () => {
    const hub = ruleBody(".surface[data-transition='hub']");
    const match = /animation:\s*hubEnter\s+(\d+)ms\s+var\(--ease-out\)\s+both\s*;/.exec(hub);

    expect(match).not.toBeNull();
    const duration = Number(match?.[1]);
    expect(duration).toBeGreaterThanOrEqual(200);
    expect(duration).toBeLessThanOrEqual(320);

    // Workspace pushes forward/up, Hub recedes — inverse translate signs.
    expect(transitionCss).toMatch(/@keyframes workspaceEnter\s*\{[\s\S]*?translate3d\(0, 10px, 0\)/);
    expect(transitionCss).toMatch(/@keyframes hubEnter\s*\{[\s\S]*?translate3d\(0, -8px, 0\)/);
  });

  it('does not animate the first painted surface of the session', () => {
    expect(ruleBody(".surface[data-transition='none']")).toMatch(/animation:\s*none\s*;/);
  });

  it('never animates a property that can shift layout or force paint', () => {
    // The point of this assertion is that the transition cannot cause reflow.
    // `opacity` and `transform` are compositor properties; `pointer-events` is
    // a discrete, non-interpolated property that affects hit testing only and
    // never triggers layout or paint, so it belongs to the same safe set. The
    // assertion stays a strict allow-list: anything else still fails.
    const keyframeBlocks = transitionCss.match(
      /@keyframes\s+\w+\s*\{(?:\s*(?:from|to|\d+%)\s*\{[^}]*\}\s*)+\}/g,
    ) ?? [];
    expect(keyframeBlocks.length).toBe(4);

    for (const block of keyframeBlocks) {
      const declarations = block.match(/^\s*([a-z-]+)\s*:/gm) ?? [];
      for (const declaration of declarations) {
        const property = declaration.trim().replace(':', '');
        expect(['opacity', 'transform', 'pointer-events']).toContain(property);
      }
    }
  });

  it('gates pointer input for exactly the frames the surface is transparent', () => {
    // This assertion previously read "never gates pointer input during the
    // transition", on the belief that the incoming surface is interactive from
    // its first frame. A browser run disproved it: this wrapper is the ancestor
    // of the ENTIRE incoming surface - for the Hub, the whole rail - and it runs
    // with `both` fill from `opacity: 0`, so every rail control was hit-testable
    // while invisible. The run recorded 12 such failures on `.hub__*` controls
    // at ~1634ms (.omo/evidence/spec-paint-verification/entrance-reachability.json).
    //
    // The contract is therefore not "never gate" but "gate exactly the
    // transparent frames, and no longer". `pointer-events` is discrete, so
    // declaring it in the same keyframe as `opacity` makes visibility and
    // clickability one timeline that cannot desynchronise.
    for (const name of ['workspaceEnter', 'hubEnter']) {
      const block = new RegExp(`@keyframes ${name}\\s*\\{[\\s\\S]*?\\n\\}`).exec(transitionCss)?.[0];
      expect(block, `${name} keyframes must exist`).toBeDefined();
      if (!block) throw new Error(`${name} keyframes were not found`);

      const steps = [...block.matchAll(/(from|to|[\d.]+%)\s*\{([^}]*)\}/g)].map((match) => {
        const selector = match[1] ?? '';
        const body = match[2] ?? '';
        return {
          offset: selector === 'from' ? 0 : selector === 'to' ? 100 : Number.parseFloat(selector),
          opacity: /opacity:\s*([\d.]+)/.exec(body)?.[1],
          pointerEvents: /pointer-events:\s*(\w+)/.exec(body)?.[1],
        };
      });

      // Non-vacuous: the transparent frame this exists to cover must still ship.
      const transparent = steps.filter((step) => step.opacity !== undefined && Number(step.opacity) === 0);
      expect(transparent.length, `${name} must still fade in from transparent`).toBeGreaterThan(0);

      for (const step of transparent) {
        expect(
          step.pointerEvents,
          `${name} is transparent at ${step.offset}% and must not be hit-testable there`,
        ).toBe('none');
      }

      // ...and must hand pointers back at the very start of the visible phase,
      // or the fix would trade an invisible-but-clickable surface for a
      // visible-but-dead one for the whole 260-280ms.
      const restored = steps.filter((step) => step.pointerEvents === 'auto').map((step) => step.offset);
      expect(restored.length, `${name} must restore pointer-events`).toBeGreaterThan(0);
      expect(
        Math.min(...restored),
        `${name} must return pointers as soon as it carries luminance`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it('leaves nothing gated once the transition is over or collapsed', () => {
    // The failure mode that matters more than the one being fixed: a surface
    // stuck pointer-inert is permanently unusable. Both the reduced-motion path
    // and the reduced-transparency variants must land on the interactive side.
    expect(reducedMotionBlock()).toMatch(/pointer-events:\s*auto/);

    // The reduced-transparency keyframes drop the opacity ramp entirely, so the
    // surface is never transparent and must never be gated there.
    const opaqueFrames = transitionCss.match(/@keyframes \w+Opaque\s*\{[\s\S]*?\n  \}/g) ?? [];
    expect(opaqueFrames.length).toBe(2);
    for (const frames of opaqueFrames) {
      expect(frames).not.toMatch(/pointer-events\s*:\s*none/);
    }
  });

  it('disables the movement entirely under prefers-reduced-motion', () => {
    const reduced = reducedMotionBlock();

    expect(reduced).toMatch(/\.surface\[data-transition='workspace'\]/);
    expect(reduced).toMatch(/\.surface\[data-transition='hub'\]/);
    expect(reduced).toMatch(/animation:\s*none\s*;/);
    // No residual transformed/transparent frame can survive the reset.
    expect(reduced).toMatch(/opacity:\s*1\s*;/);
    expect(reduced).toMatch(/transform:\s*none\s*;/);
  });

  it('drops the opacity ramp but keeps motion under prefers-reduced-transparency', () => {
    const start = transitionCss.indexOf('@media (prefers-reduced-transparency: reduce)');
    expect(start).toBeGreaterThan(-1);
    const block = transitionCss.slice(start);

    expect(block).toMatch(/@keyframes workspaceEnterOpaque/);
    expect(block).toMatch(/@keyframes hubEnterOpaque/);
    const opaqueFrames = block.match(/@keyframes \w+Opaque\s*\{[\s\S]*?\n  \}/g) ?? [];
    expect(opaqueFrames.length).toBe(2);
    for (const frames of opaqueFrames) {
      expect(frames).not.toMatch(/opacity\s*:/);
    }
  });

  it('does not restate the header-less Hub layout rules — entry-layout.css owns them', () => {
    // The rules used to be duplicated here at the wrapper depth as a
    // workaround. entry-layout.css now matches the wrapper depth itself, so a
    // copy in this module would be a second source of truth that drifts.
    expect(transitionCss).not.toMatch(/entry-shell--no-header/);
    expect(transitionCss).not.toMatch(/workspace-tabs-chrome/);
    expect(transitionCss).not.toMatch(/grid-template-rows/);
  });
});


