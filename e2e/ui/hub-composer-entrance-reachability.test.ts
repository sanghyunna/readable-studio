import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearReachabilityHistory,
  installReachabilitySentinel,
} from '@/playwright/reachability';

/**
 * Hub composer entrance window: visibility and pointer availability are ONE
 * timeline.
 *
 * The defect: `readable-fade-slide-up` starts at `opacity: 0`, and
 * `.home-hero__input-card` applies it with a 100ms delay and `both` fill. For
 * that delay the composer was painted at exactly zero opacity while remaining
 * POINTER-ACTIVE, so a click in the first ~100ms of every Home mount landed on
 * an invisible control. The fix declares `pointer-events` inside the same
 * keyframes as `opacity` (a discrete animatable property), so the two cannot
 * desynchronise. That covers ~41 call sites through the shared `entrance.css`.
 *
 * Why this must be a browser spec: `pointer-events: none` INHERITS. The fix
 * therefore makes descendants genuinely unclickable too — but if inheritance
 * did not apply as expected, a descendant computing `auto` would fall into the
 * reachability guard's OTHER branch ("centre hit test resolves outside the
 * control") and trade one failure class for another. CSS parsing cannot see
 * that; only a live run against the real compositor can.
 *
 * The keyframes hold `pointer-events: none` from `from` to `1%` only, so the
 * inert window is (delay + 1% of duration) = 100ms + 3.5ms for the composer
 * card. The handoff assertions below straddle that boundary deliberately.
 */

const STORAGE_KEY = 'readable-studio:config';
const evidenceDir = resolve(
  fileURLToPath(new URL('../..', import.meta.url)),
  '.omo/evidence/spec-paint-verification',
);

const BASE_CONFIG = {
  mode: 'daemon',
  apiKey: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  agentId: 'mock',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  agentModels: {},
  privacyDecisionAt: 1,
  telemetry: { metrics: false, content: false, artifactManifest: false },
} as const;

/** The two guard verdicts this fix must not produce, quoted from the guard. */
const INERT_SYMPTOM = 'is semantically interactive with effective opacity 0 and retains a hit area';
const HANDOFF_SYMPTOM = 'centre hit test resolves outside the control';

const COMPOSER_CARD = '.home-hero__input-card';
const COMPOSER_INPUT = 'home-hero-input';

interface DescendantState {
  readonly control: string;
  readonly pointerEvents: string;
}

interface EntranceSample {
  readonly elapsed: number;
  readonly cardOpacity: number;
  readonly cardPointerEvents: string;
  readonly descendants: readonly DescendantState[];
  readonly failures: readonly { readonly control: string; readonly reason: string }[];
}

declare global {
  interface Window {
    __entranceSamples?: EntranceSample[];
    __entranceStop?: boolean;
  }
}

function writeEvidence(name: string, body: unknown): void {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(resolve(evidenceDir, name), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

async function preparePage(
  page: Page,
  options: { readonly motion: 'no-preference' | 'reduce' },
): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Theme/config is read pre-hydration from this blob; seeding must precede it.
  await page.addInitScript(
    ([key, config]) => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem(key as string, config as string);
    },
    [STORAGE_KEY, JSON.stringify({ ...BASE_CONFIG, theme: 'light' })] as const,
  );
  await page.route('**/api/app-config', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({ json: { config: { ...BASE_CONFIG } } });
  });
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setEmulatedMedia', {
    media: 'screen',
    features: [{ name: 'prefers-reduced-motion', value: options.motion }],
  });
}

/**
 * Starts per-animation-frame sampling of the composer entrance. Installed as an
 * init script so sampling begins at document start and cannot miss the delay
 * window, which is the entire subject of the test.
 */
async function installEntranceSampler(page: Page): Promise<void> {
  await page.addInitScript(
    ([cardSelector]) => {
      const samples: EntranceSample[] = [];
      window.__entranceSamples = samples;
      window.__entranceStop = false;
      const started = performance.now();
      const interactiveSelector =
        'a[href], button, input, select, textarea, [role="button"], [role="textbox"], [tabindex]:not([tabindex="-1"])';
      const describe = (node: Element): string => {
        const id = node.id ? `#${node.id}` : '';
        const testId = node.getAttribute('data-testid');
        return `${node.tagName.toLowerCase()}${id}${testId ? `[${testId}]` : ''}`;
      };
      const tick = () => {
        const card = document.querySelector(cardSelector as string);
        if (card) {
          const cardStyle = getComputedStyle(card);
          const descendants: DescendantState[] = [];
          for (const node of card.querySelectorAll(interactiveSelector)) {
            descendants.push({
              control: describe(node),
              pointerEvents: getComputedStyle(node).pointerEvents,
            });
          }
          const report = window.__readableReachability?.audit();
          samples.push({
            elapsed: performance.now() - started,
            cardOpacity: Number(cardStyle.opacity),
            cardPointerEvents: cardStyle.pointerEvents,
            descendants,
            failures: (report?.failures ?? []).map((failure) => ({
              control: failure.control,
              reason: failure.reason,
            })),
          });
        }
        if (!window.__entranceStop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    [COMPOSER_CARD] as const,
  );
}

async function readSamples(page: Page): Promise<readonly EntranceSample[]> {
  return page.evaluate(() => {
    window.__entranceStop = true;
    return window.__entranceSamples ?? [];
  });
}

test.describe.configure({ mode: 'serial', timeout: 120_000 });

// The entrance window is ~100ms wide, so the sampler needs frames to spare
// inside it. Headless Chromium is vsync-locked to ~50fps by default, which
// yields only ~5 samples across the whole window; unlocking the compositor
// raises the observed in-page rate to ~200fps and makes the window legible.
test.use({
  launchOptions: { args: ['--disable-frame-rate-limit', '--disable-gpu-vsync'] },
});

test('[P1] the composer entrance never leaves a control invisible-but-clickable', async ({ page }) => {
  await preparePage(page, { motion: 'no-preference' });
  await installReachabilitySentinel(page);
  await installEntranceSampler(page);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('home-hero')).toBeVisible();
  await expect(page.getByTestId(COMPOSER_INPUT)).toBeVisible();
  // Let the entrance run to completion so the tail of the timeline is sampled.
  await page.locator(COMPOSER_CARD).evaluate((node) =>
    Promise.all(node.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined))),
  );

  const samples = await readSamples(page);
  const withinEntrance = samples.filter((sample) => sample.cardOpacity < 1);
  const zeroOpacity = samples.filter((sample) => sample.cardOpacity === 0);

  // The composer entrance is what this spec covers, so failures are attributed
  // to the surface under test. The Hub rail runs its own later animation (a
  // separate surface with a separate timeline, and a known pre-existing
  // order-dependence); folding it in here would make this spec fail for a
  // reason it does not govern and cannot fix. Rail-owned failures are reported
  // in the evidence file rather than silently dropped.
  const composerControl = (control: string): boolean =>
    control.includes('home-hero') || control.includes('inline-model-switcher');
  const composerFailures = samples.flatMap((sample) =>
    sample.failures
      .filter((failure) => composerControl(failure.control))
      .map((failure) => ({ elapsed: sample.elapsed, ...failure })),
  );
  const otherSurfaceFailures = samples.flatMap((sample) =>
    sample.failures
      .filter((failure) => !composerControl(failure.control))
      .map((failure) => ({ elapsed: sample.elapsed, ...failure })),
  );
  const inertFailures = composerFailures.filter((failure) => failure.reason === INERT_SYMPTOM);
  const handoffFailures = composerFailures.filter((failure) => failure.reason === HANDOFF_SYMPTOM);

  // Descendant inheritance: while the CARD is inert, every interactive
  // descendant must compute `none` too. A descendant computing `auto` here is
  // the exact silent trade the sibling lane warned about.
  const descendantLeaks = samples
    .filter((sample) => sample.cardPointerEvents === 'none')
    .flatMap((sample) =>
      sample.descendants
        .filter((descendant) => descendant.pointerEvents !== 'none')
        .map((descendant) => ({ elapsed: sample.elapsed, ...descendant })),
    );

  writeEvidence('entrance-reachability.json', {
    sampleCount: samples.length,
    framesDuringFade: withinEntrance.length,
    framesAtZeroOpacity: zeroOpacity.length,
    inertFailureCount: inertFailures.length,
    handoffFailureCount: handoffFailures.length,
    descendantLeakCount: descendantLeaks.length,
    inertFailures: inertFailures.slice(0, 10),
    handoffFailures: handoffFailures.slice(0, 10),
    descendantLeaks: descendantLeaks.slice(0, 10),
    // Not asserted here (different surface, different timeline) but recorded so
    // a real regression elsewhere is visible rather than invisible.
    otherSurfaceFailureCount: otherSurfaceFailures.length,
    otherSurfaceFailures: otherSurfaceFailures.slice(0, 10),
    firstSample: samples.at(0) ?? null,
  });

  // The capture must actually cover the entrance, or the zero counts below are
  // vacuous rather than reassuring.
  expect(samples.length, 'the sampler must observe the composer').toBeGreaterThan(20);
  expect(
    zeroOpacity.length,
    'the capture must include the zero-opacity delay window it is auditing',
  ).toBeGreaterThan(0);

  // Assertion 1 — the one that actually matters: descendants must not fall
  // into the guard's other branch. This is asserted across EVERY sampled
  // control in the card, not a representative one.
  expect(descendantLeaks, 'composer descendants must inherit pointer-events:none while inert').toEqual([]);
  expect(
    handoffFailures,
    'no composer descendant may report "centre hit test resolves outside the control"',
  ).toEqual([]);

  // Assertion 2 — the original symptom.
  expect(
    inertFailures,
    'no composer control may be semantically interactive at effective opacity 0',
  ).toEqual([]);
});

test('[P1] the entrance hands off pointer control in the correct direction', async ({ page }) => {
  await preparePage(page, { motion: 'no-preference' });
  await installEntranceSampler(page);

  // Assertion 3 — direction, with real clicks. A click at ~50ms falls inside
  // the 100ms delay and must NOT activate the composer; a click at ~400ms is
  // past the whole 450ms timeline and MUST focus it. Either half alone proves
  // nothing: "never focuses" and "always focuses" would each pass one of them.
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const earlyClick = await page.evaluate(
    async ([cardSelector, atMs]) => {
      // The card is rendered by React after navigation, so the entrance clock
      // starts when the element first EXISTS, not when this script runs.
      // Waiting for it here is what makes the 50ms offset meaningful.
      const card = await new Promise<Element | null>((resolvePromise) => {
        const existing = document.querySelector(cardSelector as string);
        if (existing) {
          resolvePromise(existing);
          return;
        }
        const observer = new MutationObserver(() => {
          const found = document.querySelector(cardSelector as string);
          if (found) {
            observer.disconnect();
            resolvePromise(found);
          }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        setTimeout(() => {
          observer.disconnect();
          resolvePromise(document.querySelector(cardSelector as string));
        }, 15_000);
      });
      if (!card) return { attempted: false, focusedInside: false, elapsed: 0, opacity: null as number | null };
      const started = performance.now();
      // Wait on the animation clock, not a fixed sleep: resolve as soon as the
      // entrance timeline has advanced to the requested offset.
      await new Promise<void>((resolvePromise) => {
        const wait = () => {
          if (performance.now() - started >= (atMs as number)) resolvePromise();
          else requestAnimationFrame(wait);
        };
        requestAnimationFrame(wait);
      });
      const rect = card.getBoundingClientRect();
      const opacity = Number(getComputedStyle(card).opacity);
      const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      // Dispatch through the real hit-test result, which is what a user's
      // pointer would reach at this instant.
      if (target instanceof HTMLElement) target.click();
      const active = document.activeElement;
      return {
        attempted: true,
        focusedInside: active !== null && card.contains(active),
        elapsed: performance.now() - started,
        opacity,
      };
    },
    [COMPOSER_CARD, 50] as const,
  );

  await expect(page.getByTestId(COMPOSER_INPUT)).toBeVisible();
  await page.locator(COMPOSER_CARD).evaluate((node) =>
    Promise.all(node.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined))),
  );

  // Late click: through Playwright's real mouse, after the entrance completed.
  await page.getByTestId(COMPOSER_INPUT).click();
  const lateFocused = await page.evaluate(
    ([cardSelector]) => {
      const card = document.querySelector(cardSelector as string);
      const active = document.activeElement;
      return card !== null && active !== null && card.contains(active);
    },
    [COMPOSER_CARD] as const,
  );

  writeEvidence('entrance-handoff.json', { earlyClick, lateFocused });

  expect(earlyClick.attempted, 'the composer card must exist during the entrance').toBe(true);
  expect(
    earlyClick.focusedInside,
    `a click at ~50ms (opacity ${String(earlyClick.opacity)}) must NOT activate the composer`,
  ).toBe(false);
  expect(lateFocused, 'a click after the entrance MUST focus the composer').toBe(true);
});

test('[P1] the entrance still reads as motion rather than an instant appearance', async ({ page }) => {
  await preparePage(page, { motion: 'no-preference' });
  await installEntranceSampler(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId(COMPOSER_INPUT)).toBeVisible();
  await page.locator(COMPOSER_CARD).evaluate((node) =>
    Promise.all(node.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined))),
  );

  const samples = await readSamples(page);
  // Assertion 4 — the fade must not have been flattened into a step. Sampling
  // near 150ms and 250ms lands inside the 100ms..450ms fade, where a genuine
  // ease must sit strictly between 0 and 1.
  //
  // The offsets are measured from when the card MOUNTS, not from navigation.
  // The sampler starts at document-start (so it cannot miss the delay window),
  // but React renders the card several hundred ms later, and the animation
  // clock starts then. Anchoring to navigation would sample before the
  // animation exists and read a spurious 0.
  const mountElapsed = samples.at(0)?.elapsed ?? 0;
  const at = (target: number): EntranceSample | null =>
    samples.reduce<EntranceSample | null>((best, sample) => {
      const offset = Math.abs(sample.elapsed - mountElapsed - target);
      if (best === null) return sample;
      return offset < Math.abs(best.elapsed - mountElapsed - target) ? sample : best;
    }, null);

  const at150 = at(150);
  const at250 = at(250);
  const partial = samples.filter((sample) => sample.cardOpacity > 0 && sample.cardOpacity < 1);

  writeEvidence('entrance-fade-shape.json', {
    sampleCount: samples.length,
    mountElapsed,
    partialOpacityFrames: partial.length,
    at150,
    at250,
    opacityTrace: samples
      .filter((sample) => sample.elapsed - mountElapsed < 600)
      .map((sample) => ({
        sinceMount: Number((sample.elapsed - mountElapsed).toFixed(1)),
        opacity: sample.cardOpacity,
      })),
  });

  expect(at150, 'a sample near 150ms must exist').not.toBeNull();
  expect(at250, 'a sample near 250ms must exist').not.toBeNull();
  // Intermediate opacity at both offsets is what distinguishes a fade from an
  // instant appearance; a step function would read 0 or 1 at every sample.
  expect(
    (at150 as EntranceSample).cardOpacity,
    `opacity at ~150ms must be mid-fade, got ${String((at150 as EntranceSample).cardOpacity)}`,
  ).toBeGreaterThan(0);
  expect((at150 as EntranceSample).cardOpacity).toBeLessThan(1);
  expect(
    (at250 as EntranceSample).cardOpacity,
    `opacity at ~250ms must be mid-fade, got ${String((at250 as EntranceSample).cardOpacity)}`,
  ).toBeGreaterThan(0);
  expect((at250 as EntranceSample).cardOpacity).toBeLessThan(1);
  // And the fade must progress, not sit still.
  expect(
    (at250 as EntranceSample).cardOpacity,
    'the fade must advance between 150ms and 250ms',
  ).toBeGreaterThan((at150 as EntranceSample).cardOpacity);
  expect(partial.length, 'the fade must span multiple frames').toBeGreaterThan(3);
});

test('[P1] reduced motion collapses the entrance without leaving a control inert', async ({ page }) => {
  // `entrance.css` collapses every animation to 0.01ms with 0ms delay under
  // reduced motion. That removes the inert phase along with the animation, so
  // the risk inverts: instead of a lingering inert window, a control could be
  // left permanently `pointer-events: none` if the collapsed timeline never
  // reached the `1%` keyframe that restores `auto`.
  await preparePage(page, { motion: 'reduce' });
  await installReachabilitySentinel(page);
  await installEntranceSampler(page);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  expect(
    await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
    'the reduced-motion preference must actually be observed by the page',
  ).toBe(true);
  await expect(page.getByTestId('home-hero')).toBeVisible();
  await expect(page.getByTestId(COMPOSER_INPUT)).toBeVisible();
  await clearReachabilityHistory(page);

  const samples = await readSamples(page);
  const settled = samples.at(-1);
  expect(settled, 'the sampler must observe the settled composer').toBeDefined();

  const settledSample = settled as EntranceSample;
  const stuckDescendants = settledSample.descendants.filter(
    (descendant) => descendant.pointerEvents === 'none',
  );

  writeEvidence('entrance-reduced-motion.json', {
    sampleCount: samples.length,
    settled: settledSample,
    stuckDescendants,
  });

  // Settled state under reduced motion: fully opaque and fully interactive.
  expect(settledSample.cardOpacity, 'reduced motion must settle the composer at full opacity').toBe(1);
  expect(
    settledSample.cardPointerEvents,
    'reduced motion must not leave the composer card inert',
  ).not.toBe('none');
  expect(stuckDescendants, 'reduced motion must not leave any descendant inert').toEqual([]);

  // And the control must be genuinely operable, not merely computed as such.
  await page.getByTestId(COMPOSER_INPUT).click();
  expect(
    await page.evaluate(
      ([cardSelector]) => {
        const card = document.querySelector(cardSelector as string);
        const active = document.activeElement;
        return card !== null && active !== null && card.contains(active);
      },
      [COMPOSER_CARD] as const,
    ),
    'the composer must be clickable under reduced motion',
  ).toBe(true);
});
