import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * QA for todo 3 of hub-restore-and-match-mockup:
 *   (a) defect #79 - the brand mark must be the REAL logo asset, not a
 *       CSS-drawn approximation painted with linear-gradients.
 *   (b) defect #80 - filter text and the canonical single sort icon must be
 *       vertically centred inside their fixed-height controls.
 *
 * Every assertion is a RUNTIME measurement against the rendered page. Nothing
 * here passes by inspecting source, and nothing passes merely because a node
 * exists - the logo assertions require the asset to have actually PAINTED.
 */

test.describe.configure({ timeout: 60_000 });

const STORAGE_KEY = 'readable-studio:config';

const HOME_CONFIG = {
  mode: 'daemon',
  apiKey: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  agentId: 'codex',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  agentModels: { codex: { model: 'default', reasoning: 'default' } },
  privacyDecisionAt: 1,
  telemetry: { metrics: false, content: false, artifactManifest: false },
};

/**
 * Evidence lands in the MAIN repo's `.omo/evidence/task-3`, not in this
 * worktree: `.omo/` is gitignored and the orchestrator collects from the main
 * tree. `e2e/ui` -> worktree root is two levels, and the worktree lives at
 * `<main>/.tmp/wt/todo3`, so the main repo is three more - five in total.
 * READABLE_TASK3_EVIDENCE_DIR overrides it when the layout differs.
 */
const evidenceDir =
  process.env.READABLE_TASK3_EVIDENCE_DIR ??
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../.omo/evidence/task-3');

/**
 * Lands on the hub with a settled config so no onboarding/first-run surface
 * intercepts the home view. Waits on the brand button rather than a timeout.
 */
async function openHub(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, JSON.stringify(value));
    },
    { key: STORAGE_KEY, value: HOME_CONFIG },
  );
  await page.goto('/');
  await expect(page.getByTestId('hub-brand')).toBeVisible();
}

/**
 * The control's own box vs its visible direct content. Text controls use a
 * `Range` for the real inline text box; the canonical sort control uses its
 * direct SVG icon. Measuring only the button box would hide alignment defects.
 */
async function measureControlCentring(control: Locator) {
  return control.evaluate((el) => {
    const textNode = Array.from(el.childNodes).find(
      (node): node is Text =>
        node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim().length > 0,
    );
    const contentRect = (() => {
      if (textNode) {
        const range = document.createRange();
        range.selectNodeContents(textNode);
        return range.getBoundingClientRect();
      }
      const icon = el.querySelector(':scope > svg');
      if (!icon) throw new Error('control has no visible direct content');
      return icon.getBoundingClientRect();
    })();
    const controlRect = el.getBoundingClientRect();
    return {
      label: (textNode?.textContent ?? el.getAttribute('aria-label') ?? '').trim(),
      controlCentre: controlRect.top + controlRect.height / 2,
      contentCentre: contentRect.top + contentRect.height / 2,
      controlHeight: controlRect.height,
      contentHeight: contentRect.height,
      alignItems: getComputedStyle(el).alignItems,
    };
  });
}

test('[P1] hub brand mark renders the real logo asset, painted', async ({ page }) => {
  await openHub(page, 1280);

  const mark = page.locator('[data-testid="hub-brand"] .hub__brand-mark');
  await expect(mark).toHaveCount(1);

  const info = await mark.evaluate((el) => {
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const base = {
      tag: el.tagName.toLowerCase(),
      backgroundImage: cs.backgroundImage,
      width: box.width,
      height: box.height,
    };
    if (el instanceof HTMLImageElement) {
      return {
        ...base,
        // `src` is the RESOLVED absolute URL, not the authored attribute.
        resolved: el.src,
        complete: el.complete,
        naturalWidth: el.naturalWidth,
        naturalHeight: el.naturalHeight,
      };
    }
    if (el instanceof SVGImageElement) {
      return {
        ...base,
        resolved: new URL(el.href.baseVal, document.baseURI).href,
        complete: true,
        naturalWidth: box.width,
        naturalHeight: box.height,
      };
    }
    return { ...base, resolved: '', complete: false, naturalWidth: 0, naturalHeight: 0 };
  });

  console.log('BRAND_MARK=' + JSON.stringify(info));

  // ACCEPTANCE: it is a real image element, not a decorated span.
  expect(['img', 'svg', 'image']).toContain(info.tag);

  // ACCEPTANCE: the RESOLVED url points at the real shipped asset.
  expect(info.resolved).toMatch(/\/logo\.(svg|png)(\?.*)?$/);

  // ADVERSARIAL misleading_success_output: existence is not proof of paint.
  // A 404 or a broken path still yields a visible element with a layout box,
  // so require decoded intrinsic dimensions from the actual asset bytes.
  expect(info.complete).toBe(true);
  expect(info.naturalWidth).toBeGreaterThan(0);
  expect(info.naturalHeight).toBeGreaterThan(0);

  // ACCEPTANCE: the 22x22 footprint is preserved.
  expect(info.width).toBeCloseTo(22, 1);
  expect(info.height).toBeCloseTo(22, 1);

  // FAILURE PROBE: no CSS-drawn approximation may survive.
  expect(info.backgroundImage.toLowerCase()).not.toContain('linear-gradient');
  expect(info.backgroundImage).toBe('none');

  // The asset must be independently fetchable at its resolved URL and be the
  // white-plate rounded variant, not a stray 404 page.
  const assetResponse = await page.request.get(info.resolved);
  expect(assetResponse.status()).toBe(200);
  const assetBody = await assetResponse.text();
  console.log('ASSET_STATUS=' + assetResponse.status() + ' ASSET_BYTES=' + assetBody.length);
  expect(assetBody).toContain('rx="10.5"');
  expect(assetBody).toContain('fill="#ffffff"');
});

test('[P1] hub brand hover behaviour is preserved', async ({ page }) => {
  await openHub(page, 1280);
  const brand = page.getByTestId('hub-brand');

  const before = await brand.evaluate((el) => getComputedStyle(el).backgroundColor);
  await brand.hover();
  // The hover background is a token swap on the button, applied synchronously
  // by CSS; poll the computed value rather than sleeping.
  await expect
    .poll(async () => brand.evaluate((el) => getComputedStyle(el).backgroundColor))
    .not.toBe(before);
  const after = await brand.evaluate((el) => getComputedStyle(el).backgroundColor);
  console.log('BRAND_HOVER before=' + before + ' after=' + after);
});

for (const width of [1280, 1920]) {
  test(`[P1] filter and sort controls are vertically centred at ${width}`, async ({ page }) => {
    await openHub(page, width);

    const controls = [
      'hub-filter-all',
      'hub-filter-attention',
      'hub-filter-running',
      'hub-sort',
    ];

    for (const id of controls) {
      const control = page.getByTestId(id);
      await expect(control).toBeVisible();
      const measured = await measureControlCentring(control);
      const delta = Math.abs(measured.controlCentre - measured.contentCentre);
      console.log(
        `CONTROL width=${width} id=${id} label="${measured.label}" align=${measured.alignItems} ` +
          `controlH=${measured.controlHeight.toFixed(2)} ` +
          `contentH=${measured.contentHeight.toFixed(2)} delta=${delta.toFixed(3)}px`,
      );
      expect(measured.alignItems).toBe('center');
      // ACCEPTANCE: visible content centre within 1px of its control centre.
      expect(delta).toBeLessThanOrEqual(1);
    }
  });
}

test('[P1] no fixed-height inline control in the hub is baseline/flex-start aligned', async ({
  page,
}) => {
  await openHub(page, 1280);

  // Sweep the LIVE hub for the defect class rather than trusting a source read:
  // any flex/inline-flex element whose height is pinned (fixed height, and the
  // box does not grow with content) must not align its children to the text
  // baseline or the cross-start edge.
  const offenders = await page.evaluate(() => {
    const out: Array<{ cls: string; align: string; height: number }> = [];
    const hub = document.querySelector('.hub');
    if (!hub) return out;
    for (const el of Array.from(hub.querySelectorAll<HTMLElement>('*'))) {
      const cs = getComputedStyle(el);
      if (cs.display !== 'flex' && cs.display !== 'inline-flex') continue;
      const fixedHeight = cs.height !== 'auto' && !cs.height.startsWith('0');
      if (!fixedHeight) continue;
      if (cs.alignItems === 'baseline' || cs.alignItems === 'flex-start') {
        out.push({
          cls: el.className || el.tagName.toLowerCase(),
          align: cs.alignItems,
          height: el.getBoundingClientRect().height,
        });
      }
    }
    return out;
  });

  console.log('BASELINE_SWEEP_OFFENDERS=' + JSON.stringify(offenders));
  expect(offenders).toEqual([]);
});

test('[P1] stale CSS bundle cannot mask the fix', async ({ page }) => {
  // ADVERSARIAL stale_state: warm the cache, then hard-reload bypassing it and
  // re-measure. If a cached bundle were serving the old rule, the second
  // measurement would regress.
  await openHub(page, 1280);
  const first = await measureControlCentring(page.getByTestId('hub-filter-all'));

  await page.reload({ waitUntil: 'load' });
  await page.evaluate(async () => {
    if ('caches' in window) {
      for (const k of await caches.keys()) await caches.delete(k);
    }
  });
  await page.context().clearCookies();
  await page.reload({ waitUntil: 'load' });
  await expect(page.getByTestId('hub-brand')).toBeVisible();

  const second = await measureControlCentring(page.getByTestId('hub-filter-all'));
  const mark = await page
    .locator('[data-testid="hub-brand"] .hub__brand-mark')
    .evaluate((el) => ({
      bg: getComputedStyle(el).backgroundImage,
      natural: el instanceof HTMLImageElement ? el.naturalWidth : 0,
    }));

  console.log(
    'STALE_STATE first=' +
      Math.abs(first.controlCentre - first.contentCentre).toFixed(3) +
      ' afterHardReload=' +
      Math.abs(second.controlCentre - second.contentCentre).toFixed(3) +
      ' markBg=' +
      mark.bg +
      ' markNatural=' +
      mark.natural,
  );

  expect(Math.abs(second.controlCentre - second.contentCentre)).toBeLessThanOrEqual(1);
  expect(second.alignItems).toBe('center');
  expect(mark.bg.toLowerCase()).not.toContain('linear-gradient');
  expect(mark.natural).toBeGreaterThan(0);
});

test('[P1] capture rail header evidence screenshot', async ({ page }) => {
  await openHub(page, 1280);
  mkdirSync(evidenceDir, { recursive: true });

  const head = page.locator('.hub__nav-head');
  await expect(head).toBeVisible();
  await head.screenshot({ path: resolve(evidenceDir, 'brand.png') });

  // Also capture the whole rail so the brand crop can be located within the
  // same region of the approved mockup shot.
  await page.locator('.hub__nav').screenshot({ path: resolve(evidenceDir, 'rail.png') });

  const box = await head.boundingBox();
  console.log('BRAND_SHOT_BOX=' + JSON.stringify(box));
  expect(box).not.toBeNull();
});
