import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { openNewProjectModal } from '@/playwright/new-project-modal';

/**
 * Direct-edit left panel legibility, measured on RENDERED pixels.
 *
 * The user's complaint had two halves, and neither is a static number:
 *   (a) they could not tell whether a component EXISTS at a position — the
 *       control card did not separate from the pane it sits on;
 *   (b) an EMPTY numeric field was indistinguishable from a filled one.
 *
 * `apps/web/tests/styles/manual-edit-panel-legibility.test.ts` computes those
 * ratios from CSS text with `readFileSync`. That cannot settle either half:
 * the pane is `--hub-glass-fill` behind `blur(22px) saturate(165%)` over four
 * moving gradient blooms, so the composited backdrop under any given card
 * depends on where that card lands on the canvas — which moves with scroll and
 * window size. A single algebraic ratio describes one hypothetical backdrop.
 *
 * This spec samples the actual composite through `page.screenshot`, at the
 * BRIGHTEST and DARKEST bloom regions the panel actually covers, in both
 * themes, and compares a genuinely empty numeric field against a filled one.
 *
 * What cannot be asserted mechanically: whether a human perceives the card
 * edge. The closest mechanical proxy that would fail if the fix regressed is
 * the measured contrast ratio of the card fill against its own local pane
 * backdrop at the worst position on the canvas — which is what is asserted.
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

/**
 * The separation floor the unit test asserts algebraically (1.15), applied here
 * to the worst REAL backdrop instead of one assumed one. 1.032:1 shipped and
 * was unreadable; the two prior contrast regressions in this project were
 * 1.081 and 1.09, so the floor has to clear those decisively.
 */
const MIN_SURFACE_SEPARATION = 1.15;
const WCAG_AA = 4.5;

type Rgb = readonly [number, number, number];

function toLinear(channel: number): number {
  const v = channel / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

interface Sampled {
  /** Median colour of the sampled region, robust to text pixels crossing it. */
  readonly median: Rgb;
  readonly min: Rgb;
  readonly max: Rgb;
  readonly pixels: number;
}

/** Median per channel: text glyphs and icons are a minority of any region. */
function samplePng(png: PNG, scale: number, box: { x: number; y: number; width: number; height: number }): Sampled {
  const x0 = Math.round(box.x * scale);
  const y0 = Math.round(box.y * scale);
  const x1 = Math.min(png.width, Math.round((box.x + box.width) * scale));
  const y1 = Math.min(png.height, Math.round((box.y + box.height) * scale));
  const channels: [number[], number[], number[]] = [[], [], []];
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (png.width * y + x) << 2;
      channels[0].push(png.data[offset] ?? 0);
      channels[1].push(png.data[offset + 1] ?? 0);
      channels[2].push(png.data[offset + 2] ?? 0);
    }
  }
  const stat = (values: number[], pick: 'median' | 'min' | 'max'): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    if (pick === 'min') return sorted[0] ?? 0;
    if (pick === 'max') return sorted[sorted.length - 1] ?? 0;
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  };
  return {
    median: [stat(channels[0], 'median'), stat(channels[1], 'median'), stat(channels[2], 'median')],
    min: [stat(channels[0], 'min'), stat(channels[1], 'min'), stat(channels[2], 'min')],
    max: [stat(channels[0], 'max'), stat(channels[1], 'max'), stat(channels[2], 'max')],
    pixels: channels[0].length,
  };
}

async function shootPanel(page: Page): Promise<{ png: PNG; scale: number; origin: { x: number; y: number } }> {
  const host = page.locator('.manual-edit-left-host');
  const box = await host.boundingBox();
  if (!box) throw new Error('the inspector host must be laid out before sampling');
  const buffer = await page.screenshot({ clip: box });
  const png = PNG.sync.read(buffer);
  return { png, scale: png.width / box.width, origin: { x: box.x, y: box.y } };
}

/**
 * Reads the composited colour of a card and of the pane immediately beside it,
 * taken from the SAME screenshot so both carry the same blur/bloom state. The
 * pane strip is the panel's own left gutter at the card's vertical centre —
 * the pixels a user's eye compares the card edge against.
 */
async function measureCardAgainstPane(
  page: Page,
  card: Locator,
): Promise<{ readonly card: Rgb; readonly pane: Rgb; readonly ratio: number; readonly y: number }> {
  const { png, scale, origin } = await shootPanel(page);
  const box = await card.boundingBox();
  if (!box) throw new Error('the card must be laid out before sampling');

  // Inset well past the rounded corners and the rim-light inset shadow so the
  // sample is the card FILL, not its lit edge.
  const inner = {
    x: box.x - origin.x + 6,
    y: box.y - origin.y + 6,
    width: Math.max(1, box.width - 12),
    height: Math.max(1, box.height - 12),
  };
  const cardSample = samplePng(png, scale, inner);

  // Pane strip: 8px wide, immediately left of the card, same vertical band.
  const paneStrip = {
    x: Math.max(0, box.x - origin.x - 12),
    y: inner.y,
    width: 8,
    height: inner.height,
  };
  const paneSample = samplePng(png, scale, paneStrip);
  expect(cardSample.pixels, 'card sample must contain pixels').toBeGreaterThan(50);
  expect(paneSample.pixels, 'pane sample must contain pixels').toBeGreaterThan(20);

  return {
    card: cardSample.median,
    pane: paneSample.median,
    ratio: contrast(cardSample.median, paneSample.median),
    y: box.y,
  };
}

async function preparePage(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Theme is config-driven: app/layout.tsx reads this blob pre-hydration and
  // sets data-theme. `emulateMedia({ colorScheme })` does not drive it.
  await page.addInitScript(
    ([key, config]) => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem(key as string, config as string);
    },
    [STORAGE_KEY, JSON.stringify({ ...BASE_CONFIG, theme })] as const,
  );
  await page.route('**/api/app-config', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({ json: { config: { ...BASE_CONFIG } } });
  });
}

function editorHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Legibility fixture</title>
<style>body{margin:0;font-family:system-ui,sans-serif} .block{padding:48px}</style>
</head><body>
<div class="block"><h1 data-readable-id="hero-title">Legibility Hero</h1>
<p data-readable-id="hero-copy">A paragraph that can be selected for shape controls.</p></div>
</body></html>`;
}

/**
 * Creates a project, seeds one HTML artifact, opens it and enters edit mode
 * with a shape selected, which is the state that renders the geometry card
 * stack the report is about.
 */
async function openInspectorWithSelection(page: Page, name: string): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('home-hero')).toBeVisible();
  await openNewProjectModal(page);
  await page.getByTestId('new-project-name').fill(name);
  await page.getByTestId('create-project').click();
  await expect(page).toHaveURL(/\/projects\//, { timeout: 20_000 });
  const projectId = new URL(page.url()).pathname.split('/')[2] ?? '';
  expect(projectId).not.toBe('');

  const seeded = await page.request.post(`/api/projects/${projectId}/files`, {
    data: {
      name: 'legibility.html',
      content: editorHtml(),
      artifactManifest: {
        schema: 'readable-studio.artifact-manifest.v1',
        kind: 'html',
        title: 'legibility.html',
        entry: 'legibility.html',
        renderer: 'html',
        exports: ['html'],
      },
    },
    timeout: 15_000,
  });
  expect(seeded.ok(), await seeded.text()).toBeTruthy();

  await page.goto(`/projects/${projectId}/files/legibility.html`, { waitUntil: 'domcontentloaded' });
  const preview = page
    .locator(
      '[data-testid="artifact-preview-frame"]:visible, [data-testid="artifact-preview-frame-url-load"]:visible, [data-testid="artifact-preview-frame-srcdoc"]:visible',
    )
    .first();
  await expect(preview).toBeVisible({ timeout: 20_000 });

  await page.getByTestId('manual-edit-mode-toggle').click();
  const inspector = page.locator('.manual-edit-left-inspector');
  await expect(inspector).toBeVisible({ timeout: 20_000 });

  // Select a real element so the geometry (Size & position) card stack renders.
  const frame = page.frameLocator(
    '[data-testid="artifact-preview-frame"]:visible, [data-testid="artifact-preview-frame-url-load"]:visible, [data-testid="artifact-preview-frame-srcdoc"]:visible',
  );
  await frame.locator('[data-readable-id="hero-title"]').click();
  const geometryDisclosure = inspector.getByRole('button', { name: /^Size & position/ });
  await expect(geometryDisclosure).toBeVisible({ timeout: 20_000 });
  const expanded = await geometryDisclosure.getAttribute('aria-expanded');
  if (expanded !== 'true') await geometryDisclosure.click();
  await expect(inspector.getByLabel('Width', { exact: true })).toBeVisible({ timeout: 20_000 });
}

/**
 * Finds the panel's brightest and darkest vertical bands by sampling its own
 * composited pixels. Those bands ARE the bloom extremes as the panel actually
 * sees them, which is the measurement the static ratio cannot produce.
 */
async function bloomExtremes(page: Page): Promise<{
  readonly brightest: { readonly y: number; readonly luminance: number };
  readonly darkest: { readonly y: number; readonly luminance: number };
}> {
  const { png, scale } = await shootPanel(page);
  const bandHeight = 24;
  const bands: { y: number; luminance: number }[] = [];
  for (let y = 0; y + bandHeight < png.height / scale; y += bandHeight) {
    // Sample the left gutter only: that is pane material, not card material.
    const sample = samplePng(png, scale, { x: 4, y, width: 10, height: bandHeight });
    bands.push({ y, luminance: relativeLuminance(sample.median) });
  }
  expect(bands.length, 'the panel must be tall enough to have bloom bands').toBeGreaterThan(4);
  const sorted = [...bands].sort((a, b) => a.luminance - b.luminance);
  return {
    darkest: sorted[0] as { y: number; luminance: number },
    brightest: sorted[sorted.length - 1] as { y: number; luminance: number },
  };
}

function writeEvidence(name: string, body: unknown): void {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(resolve(evidenceDir, name), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

test.describe.configure({ mode: 'serial', timeout: 120_000 });

for (const theme of ['light', 'dark'] as const) {
  test(`[P1] control cards separate from the pane over both bloom extremes (${theme})`, async ({ page }) => {
    await preparePage(page, theme);
    await openInspectorWithSelection(page, `Legibility ${theme} ${Date.now()}`);
    const inspector = page.locator('.manual-edit-left-inspector');
    const extremes = await bloomExtremes(page);
    const widthField = inspector.getByLabel('Width', { exact: true });
    const card = widthField.locator('xpath=ancestor::label[1]');
    await expect(card).toBeVisible();

    // Measure at the panel's own top, then scrolled, so the card lands over a
    // different part of the bloom stack. The pane is blurred glass, so its
    // local colour under the card genuinely changes with this scroll.
    const measurements: {
      position: string;
      ratio: number;
      card: Rgb;
      pane: Rgb;
      y: number;
    }[] = [];

    const atTop = await measureCardAgainstPane(page, card);
    measurements.push({ position: 'rest', ...atTop });

    // The scroll container is a CSS-module class (hashed at build time), so it
    // is found by the behaviour that matters — the descendant that actually
    // scrolls — rather than by an unstable generated class name.
    const scrolledBy = await inspector.evaluate((root) => {
      const scroller = [root, ...root.querySelectorAll('*')].find((node): node is HTMLElement => {
        if (!(node instanceof HTMLElement)) return false;
        const style = getComputedStyle(node);
        return (
          (style.overflowY === 'auto' || style.overflowY === 'scroll')
          && node.scrollHeight - node.clientHeight > 40
        );
      });
      if (!scroller) return 0;
      return new Promise<number>((resolvePromise) => {
        const onScroll = () => {
          scroller.removeEventListener('scroll', onScroll);
          requestAnimationFrame(() =>
            requestAnimationFrame(() => resolvePromise(scroller.scrollTop)),
          );
        };
        scroller.addEventListener('scroll', onScroll);
        scroller.scrollTop = scroller.scrollHeight;
        // No scroll event fires when the container is already at the bottom.
        if (scroller.scrollTop === 0) {
          scroller.removeEventListener('scroll', onScroll);
          resolvePromise(0);
        }
      });
    });
    if (scrolledBy > 0) {
      const scrolled = await measureCardAgainstPane(page, card);
      measurements.push({ position: 'scrolled', ...scrolled });
    }

    // Also resize: the blooms are viewport-anchored radial gradients, so a
    // narrower window slides a different bloom under the panel entirely.
    await page.setViewportSize({ width: 1100, height: 780 });
    await expect(inspector).toBeVisible();
    const narrow = await measureCardAgainstPane(page, card);
    measurements.push({ position: 'narrow-viewport', ...narrow });

    writeEvidence(`legibility-card-vs-pane-${theme}.json`, {
      theme,
      bloomExtremes: extremes,
      measurements,
    });

    // Every sampled position, not the average: the complaint was about the
    // positions where the card vanished, and an average hides those.
    for (const measurement of measurements) {
      expect(
        measurement.ratio,
        `card must separate from the pane at ${measurement.position} (${theme}): `
          + `card rgb(${measurement.card.join(',')}) vs pane rgb(${measurement.pane.join(',')})`,
      ).toBeGreaterThanOrEqual(MIN_SURFACE_SEPARATION);
    }

    if (theme === 'dark') {
      // The 'clay' failure this project has rejected before: a dark card that
      // is merely a darker smudge on a dark pane reads as flat mud. The dark
      // tier engraves by RAISING a warm glass wash, so the card must be
      // LIGHTER than its pane, not darker.
      for (const measurement of measurements) {
        expect(
          relativeLuminance(measurement.card),
          `dark card must be raised (lighter) rather than clay-dark at ${measurement.position}`,
        ).toBeGreaterThan(relativeLuminance(measurement.pane));
      }
    }
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`[P1] an empty numeric field is distinguishable from a filled one (${theme})`, async ({ page }) => {
    await preparePage(page, theme);
    await openInspectorWithSelection(page, `Empty field ${theme} ${Date.now()}`);
    const inspector = page.locator('.manual-edit-left-inspector');

    const widthField = inspector.getByLabel('Width', { exact: true });
    const widthCard = widthField.locator('xpath=ancestor::label[1]');
    const heightField = inspector.getByLabel('Height', { exact: true });
    const heightCard = heightField.locator('xpath=ancestor::label[1]');

    // Auto mode is the genuine EMPTY state: value '' with a placeholder. Fixed
    // mode fills the same control. Both are the same component in the same
    // stack, so the only difference sampled is the state itself.
    await inspector.getByRole('button', { name: 'Auto Width' }).click();
    await expect(widthField).toHaveValue('');
    await inspector.getByRole('button', { name: 'Fixed Height' }).click();
    await expect(heightField).not.toHaveValue('');

    const empty = await measureCardAgainstPane(page, widthCard);
    const filled = await measureCardAgainstPane(page, heightCard);

    // The user cannot see a field they cannot locate. Both states must first
    // clear the same separation floor against their own local pane backdrop.
    expect(
      empty.ratio,
      `an EMPTY field must still read as a field (${theme}): `
        + `card rgb(${empty.card.join(',')}) vs pane rgb(${empty.pane.join(',')})`,
    ).toBeGreaterThanOrEqual(MIN_SURFACE_SEPARATION);
    expect(filled.ratio, `a FILLED field must read as a field (${theme})`).toBeGreaterThanOrEqual(
      MIN_SURFACE_SEPARATION,
    );

    // The empty field carries placeholder ink as its only copy. If that ink
    // does not clear AA against the well it sits in, the well is empty AND
    // mute, which is the reported "cannot tell it is an input" state.
    const placeholderColour = await widthField.evaluate((node) => {
      const style = getComputedStyle(node, '::placeholder');
      return style.color;
    });
    const parsed = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(placeholderColour);
    expect(parsed, `placeholder colour must be resolvable, got ${placeholderColour}`).not.toBeNull();
    const placeholderRgb: Rgb = [
      Number((parsed as RegExpExecArray)[1]),
      Number((parsed as RegExpExecArray)[2]),
      Number((parsed as RegExpExecArray)[3]),
    ];
    const placeholderRatio = contrast(placeholderRgb, empty.card);

    // Placeholder text is a hint, not body copy: WCAG grants 3:1 to
    // non-essential text, and pinning it at 4.5 would demand it look like a
    // real value. It must clearly out-read the well it sits in either way.
    //
    // This floor is also the project's own stated requirement. tokens.css
    // documents that a dark placeholder needs its own rung because
    // `--text-soft` "reads as typed text" at 2.91:1, and targets ~3.9:1
    // against the composer glass. The engraved well introduced by this work is
    // DARKER than that glass, so the same token lands lower here — which is
    // why the ratio has to be measured against the rendered well rather than
    // assumed from the token's original surface.
    const placeholderFloor = 3;

    const filledInkColour = await heightField.evaluate((node) => getComputedStyle(node).color);
    const filledParsed = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(filledInkColour);
    const filledInk: Rgb = [
      Number((filledParsed as RegExpExecArray)[1]),
      Number((filledParsed as RegExpExecArray)[2]),
      Number((filledParsed as RegExpExecArray)[3]),
    ];
    const filledRatio = contrast(filledInk, filled.card);

    writeEvidence(`legibility-empty-vs-filled-${theme}.json`, {
      theme,
      empty: { ...empty, placeholderColour, placeholderRatio },
      filled: { ...filled, filledInkColour, filledRatio },
      separationBetweenStates: contrast(empty.card, filled.card),
    });

    expect(
      placeholderRatio,
      `placeholder ink must be legible in the empty well (${theme}), measured ${placeholderRatio.toFixed(3)}`,
    ).toBeGreaterThanOrEqual(placeholderFloor);
    expect(
      filledRatio,
      `a filled value must clear AA (${theme}), measured ${filledRatio.toFixed(3)}`,
    ).toBeGreaterThanOrEqual(WCAG_AA);

    // And the two states must be TELLABLE APART: a filled value reads darker
    // (light) / lighter (dark) than placeholder ink at the same position. This
    // is the half of the complaint the static ratio never modelled.
    expect(
      filledRatio,
      `a filled value must read more strongly than a placeholder (${theme})`,
    ).toBeGreaterThan(placeholderRatio);
  });
}
