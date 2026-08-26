import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { routeAgents } from '@/playwright/mock-factory';

// Regression guard for the dark-on-dark mention bug fixed in 302e3c6: a plugin
// pill inserted while the app was in light mode kept its near-black brand hue
// after the user switched to dark mode, so the pill's text and dot vanished
// into the panel. The unit suite pins the arithmetic; only a real browser
// proves the live restamp reaches the painted element, because the hue lands on
// an inline custom property that CSS `color-mix()` consumes at paint time.

const STORAGE_KEY = 'readable-studio:config';
const WCAG_AA_NORMAL = 4.5;
const PILL = '.composer-inline-mention--plugin';

const EVIDENCE_DIR = fileURLToPath(new URL('../../.omo/evidence', import.meta.url));

const LIGHT_CONFIG = {
  theme: 'light',
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
};

// A complete InstalledPluginRecord (packages/contracts/src/plugins/installed.ts).
// A partial record is filtered out before the picker renders, so the mention
// would never appear. `id: 'notion'` is what keys the curated brand table, and
// `readable.kind: 'scenario'` is what keeps it in the composer's plugin list.
const NOTION_PLUGIN = {
  id: 'notion',
  title: 'Notion',
  version: '0.1.0',
  trust: 'bundled',
  sourceKind: 'bundled',
  source: '/tmp/notion',
  fsPath: '/tmp/notion',
  capabilitiesGranted: ['prompt:inject'],
  installedAt: 0,
  updatedAt: 0,
  manifest: {
    name: 'notion',
    title: 'Notion',
    version: '0.1.0',
    description: 'Notion workspace context.',
    readable: {
      kind: 'scenario',
      taskKind: 'new-generation',
      useCase: { query: 'Summarise {{topic}} from the Notion workspace.' },
      inputs: [
        { name: 'topic', type: 'string', required: true, default: 'the launch plan', label: 'Topic' },
      ],
    },
  },
};

const NOTION_APPLY = {
  query: 'Summarise the launch plan from the Notion workspace.',
  contextItems: [],
  inputs: [],
  assets: [],
  mcpServers: [],
  trust: 'trusted',
  capabilitiesGranted: ['prompt:inject'],
  capabilitiesRequired: ['prompt:inject'],
  appliedPlugin: {
    snapshotId: 'snap-notion',
    pluginId: 'notion',
    pluginVersion: '0.1.0',
    manifestSourceDigest: 'a'.repeat(64),
    inputs: { topic: 'the launch plan' },
    resolvedContext: { items: [] },
    capabilitiesGranted: ['prompt:inject'],
    capabilitiesRequired: ['prompt:inject'],
    assetsStaged: [],
    taskKind: 'new-generation',
    appliedAt: 0,
    mcpServers: [],
    status: 'fresh',
  },
  projectMetadata: {},
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, JSON.stringify(value));
    },
    { key: STORAGE_KEY, value: LIGHT_CONFIG },
  );

  await page.route('**/api/health', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/api/app-config', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({ json: { config: LIGHT_CONFIG } });
  });
  await routeAgents(page, [
    {
      id: 'mock',
      name: 'Mock Agent',
      bin: 'mock-agent',
      available: true,
      version: 'test',
      models: [{ id: 'default', label: 'Default' }],
    },
  ]);

  // The deterministic seam: stubbing the registry is what makes the `@` picker
  // offer a plugin, and it touches no product code.
  await page.route('**/api/plugins', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ plugins: [NOTION_PLUGIN] }),
    });
  });
  // Picking a plugin mention also resolves its snapshot; stub it so the run
  // never depends on a live plugin folder.
  await page.route('**/api/plugins/*/apply', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(NOTION_APPLY),
    });
  });
});

/** Reads the inline `--m-hue` the brand-hue manager stamps on the pill. */
async function readHue(page: Page): Promise<string> {
  return page
    .locator(PILL)
    .first()
    .evaluate((el) => (el as HTMLElement).style.getPropertyValue('--m-hue').trim());
}

function luminance255(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * WCAG contrast of the pill's painted text against the background a user
 * actually sees — ancestors are folded front-to-back, because the pill's own
 * `background: var(--m-tint)` is a translucent `color-mix` over the panel and a
 * raw `backgroundColor` read would overstate the ratio.
 */
async function measurePillContrast(page: Page, selector: string) {
  return page.evaluate((sel) => {
    function srgb(v: number) {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    function lum(c: [number, number, number]) {
      return 0.2126 * srgb(c[0]) + 0.7152 * srgb(c[1]) + 0.0722 * srgb(c[2]);
    }
    // Chrome resolves `color-mix(in srgb, ...)` to `color(srgb ...)`, not to a
    // legacy `rgb()` string, so hand-parsing the serialized value is brittle.
    // Painting the computed value onto a 1x1 canvas normalizes ANY CSS colour
    // syntax to exact 8-bit RGBA, which is also what the compositor shows.
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    function parse(s: string): number[] | null {
      if (!ctx || !s) return null;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000000';
      const before = ctx.fillStyle;
      ctx.fillStyle = s;
      // An unparseable value leaves fillStyle untouched; guard that case.
      if (ctx.fillStyle === before && s.trim() !== '#000000' && s.trim() !== 'black') {
        if (!/^(#|rgb|hsl|color|oklab|oklch|lab|lch|transparent)/i.test(s.trim())) return null;
      }
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      if (r === undefined || g === undefined || b === undefined || a === undefined) return null;
      // Canvas premultiplies; undo it so the alpha compositing below is correct.
      const alpha = a / 255;
      if (alpha === 0) return [0, 0, 0, 0];
      return [r / alpha, g / alpha, b / alpha, alpha];
    }
    function ratio(a: [number, number, number], b: [number, number, number]) {
      const l1 = lum(a);
      const l2 = lum(b);
      const [lo, hi] = l1 < l2 ? [l1, l2] : [l2, l1];
      return (hi + 0.05) / (lo + 0.05);
    }
    function resolveBg(n: Element): [number, number, number] {
      const layers: Array<{ r: number; g: number; b: number; a: number }> = [];
      let c: Element | null = n;
      while (c) {
        const cs = getComputedStyle(c);
        const p = parse(cs.backgroundColor);
        if (p && p[0] !== undefined && p[1] !== undefined && p[2] !== undefined) {
          const a = p.length === 4 && p[3] !== undefined ? p[3] : 1;
          if (a > 0) layers.push({ r: p[0], g: p[1], b: p[2], a });
          if (a === 1) break;
        }
        c = c.parentElement;
      }
      const base = layers[layers.length - 1];
      if (!base) return [255, 255, 255];
      let r = base.r;
      let g = base.g;
      let b = base.b;
      for (let i = layers.length - 2; i >= 0; i--) {
        const l = layers[i];
        if (!l) continue;
        r = l.r * l.a + r * (1 - l.a);
        g = l.g * l.a + g * (1 - l.a);
        b = l.b * l.a + b * (1 - l.a);
      }
      return [Math.round(r), Math.round(g), Math.round(b)];
    }

    const el = document.querySelector(sel);
    if (!el) throw new Error(`selector matched nothing: ${sel}`);
    const fgRaw = parse(getComputedStyle(el).color);
    if (!fgRaw || fgRaw[0] === undefined || fgRaw[1] === undefined || fgRaw[2] === undefined) {
      throw new Error(`unparseable color on ${sel}`);
    }
    const fg: [number, number, number] = [
      Math.round(fgRaw[0]),
      Math.round(fgRaw[1]),
      Math.round(fgRaw[2]),
    ];
    const bg = resolveBg(el);
    return { ratio: +ratio(fg, bg).toFixed(2), fg, bg };
  }, selector);
}

async function openProjectChat(page: Page): Promise<void> {
  const response = await page.request.post('/api/projects', {
    data: {
      id: randomUUID(),
      name: 'Mention brand hue',
      skillId: null,
      designSystemId: null,
      metadata: { kind: 'prototype', nameSource: 'user' },
    },
  });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { project: { id: string }; conversationId: string };
  await page.goto(`/projects/${body.project.id}/conversations/${body.conversationId}`);
  await expect(page.getByTestId('chat-composer-input')).toBeVisible();
}

test('[P1] plugin mention pill restamps its brand hue on a live theme flip', async ({ page }) => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });

  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await openProjectChat(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  // Insert through the composer's own `@` trigger — the only supported path.
  // It runs LexicalComposerInput's insertMention, which builds the node with
  // mentionKind 'plugin' and mentionId 'notion', the two values the curated
  // hue table keys on.
  const editor = page.getByTestId('chat-composer-input');
  await editor.click();
  await editor.pressSequentially('@Notion');

  const popover = page.getByTestId('mention-popover');
  await expect(popover).toBeVisible();
  const option = popover.getByRole('option').filter({ hasText: 'Notion' }).first();
  await expect(option).toBeVisible();
  await option.click();

  const pill = page.locator(PILL).first();
  await expect(pill).toBeVisible();
  await expect(pill).toHaveAttribute('data-mention-id', 'notion');

  // 1. Light mode carries a concrete inline hue, not the CSS var fallback.
  const lightHue = await readHue(page);
  expect(lightHue, 'light-mode inline --m-hue').toMatch(/^#[0-9a-fA-F]{6}$/);
  await pill.screenshot({ path: join(EVIDENCE_DIR, 'f3-pill-light.png') });

  // Flip the theme the way the product does — state/appearance.ts and the
  // pre-hydration script always move both attributes together — with no
  // reload. That live transition is exactly what used to strand the pill on
  // its light hue.
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.setAttribute('data-theme-scheme', 'dark');
  });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect
    .poll(async () => readHue(page), { message: 'inline --m-hue after the theme flip' })
    .not.toBe(lightHue);

  // 2 + 3. The hue changed, and it got strictly brighter.
  const darkHue = await readHue(page);
  expect(darkHue, 'dark-mode inline --m-hue').toMatch(/^#[0-9a-fA-F]{6}$/);
  expect(darkHue, 'hue must change on a live theme flip').not.toBe(lightHue);
  expect(
    luminance255(darkHue),
    `dark hue ${darkHue} must be brighter than light hue ${lightHue}`,
  ).toBeGreaterThan(luminance255(lightHue));

  // 4. The painted text actually clears WCAG AA against what is behind it.
  const measurement = await measurePillContrast(page, PILL);
  expect(
    measurement.ratio,
    `dark pill contrast ${measurement.ratio} below WCAG AA (${WCAG_AA_NORMAL}). ` +
      `fg=rgb(${measurement.fg.join(',')}) bg=rgb(${measurement.bg.join(',')}) hue=${darkHue}`,
  ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);

  // 5. Visual evidence of both states.
  await pill.screenshot({ path: join(EVIDENCE_DIR, 'f3-pill-dark.png') });
});
