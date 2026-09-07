import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Repo-wide EXIT sweep.
//
// The invisible-but-interactive class was solved for entrances twice - once in
// CSS (`pointer-events` inside every zero-opacity `@keyframes` step) and once
// in the component (`useTransparentPhaseInert`, because focus is not
// animatable). Both are blind to dismissals: an exit is a TRANSITION, so no
// keyframe rule applies to it, and a browser run proved that forcing
// `pointer-events: none` onto the fading ancestor still returns the descendant
// button from `elementFromPoint` - a descendant's `auto` overrides an
// ancestor's `none`.
//
// So the exit gate cannot live in CSS at all. It lives in `useFadingSurface`,
// which bundles the presence variants together with `inert` gating, and this
// sweep asserts that EVERY animated root in the app that fades out goes through
// that bundle rather than hand-rolling `variants/initial/animate/exit`. That is
// what makes this structural instead of a per-surface patch: a new fading
// surface either uses the bundle or fails here.
// ---------------------------------------------------------------------------

const srcRoot = new URL('../../src/', import.meta.url);

function listSources(directory: URL): readonly URL[] {
  const found: URL[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...listSources(new URL(`${entry.name}/`, directory)));
    } else if (entry.name.endsWith('.tsx')) {
      found.push(new URL(entry.name, directory));
    }
  }
  return found;
}

interface ExitSurface {
  readonly file: string;
  /** How this root receives its presence props. */
  readonly kind: 'bundle' | 'literal';
}

/**
 * Every animated root in the app that fades out, found by how it receives its
 * presence props rather than by one JSX spelling:
 *
 * - `bundle`  - spreads `useFadingSurface(...)`, so the exit gate came with it.
 * - `literal` - hand-rolls `exit="exit"` / `exit={...}`, so nothing gates it.
 *
 * Counting both is what keeps this sweep non-vacuous after the fix: the
 * surfaces do not disappear, they move from `literal` to `bundle`.
 */
function collectExitSurfaces(): readonly ExitSurface[] {
  const surfaces: ExitSurface[] = [];
  for (const url of listSources(srcRoot)) {
    const source = readFileSync(url, 'utf8');
    const file = url.href.slice(srcRoot.href.length);
    for (const _ of source.matchAll(/\{\.\.\.[A-Za-z0-9_]*[Mm]otion\}/g)) {
      surfaces.push({ file, kind: 'bundle' });
    }
    for (const _ of source.matchAll(/\bexit=["{]/g)) {
      surfaces.push({ file, kind: 'literal' });
    }
  }
  return surfaces;
}

describe('exit-transition reachability contract', () => {
  it('gates every fading surface in the app, not just the reported one', () => {
    const surfaces = collectExitSurfaces();

    // Non-vacuous: the sweep must still find the app's dismissible surfaces
    // after the fix - they move from hand-rolled to bundled, they do not vanish.
    expect(
      surfaces.filter((surface) => surface.kind === 'bundle').length,
      'the sweep must discover the gated fading roots',
    ).toBeGreaterThan(0);

    const ungated = [
      ...new Set(surfaces.filter((surface) => surface.kind === 'literal').map((s) => s.file)),
    ];
    expect(
      ungated,
      'every surface that fades out must route its exit through the inert gate: '
        + 'an exit is a transition, so neither the keyframe `pointer-events` fix nor an '
        + "ancestor's `pointer-events: none` can close its invisible-but-interactive window",
    ).toEqual([]);
  });

  it('keeps the exit motion itself intact', async () => {
    // The fix must not be "delete the fade". Every exit variant still animates
    // opacity to 0 over a real duration; only reachability changes.
    const motion = await import('../../src/motion');
    const variants: [string, Record<string, unknown>][] = [];
    for (const [name, value] of Object.entries(motion)) {
      if (typeof value !== 'object' || value === null) continue;
      const exit: unknown = Reflect.get(value, 'exit');
      if (typeof exit !== 'object' || exit === null) continue;
      variants.push([name, exit as Record<string, unknown>]);
    }

    expect(variants.length).toBeGreaterThan(0);
    for (const [name, exit] of variants) {
      expect(exit.opacity, `${name} must still fade out`).toBe(0);
      const transition = exit.transition as { duration?: number } | undefined;
      if (transition?.duration !== undefined) {
        expect(transition.duration, `${name} exit must still take real time`).toBeGreaterThan(0);
      }
    }
  });
});
