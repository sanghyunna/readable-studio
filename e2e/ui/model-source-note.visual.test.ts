// Real-browser check for the built-in-defaults note under the home model
// picker (apps/web/src/components/ModelSourceNote.tsx). Mocks `/api/agents`
// with one fallback-source agent and one live-source agent, opens the model
// list for each at desktop and small-laptop widths, and saves screenshots
// under .omo/evidence/next-version/model-source-ui/.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { routeAgents } from '../lib/playwright/mock-factory.js';
import { addStorageInitScript } from '@/playwright/storage-init';

const STORAGE_KEY = 'readable-studio:config';
const EVIDENCE = fileURLToPath(new URL('../../.omo/evidence/next-version/model-source-ui/', import.meta.url));

function agent(id: string, name: string, modelsSource: 'live' | 'fallback') {
  return {
    id, name, bin: id, versionArgs: ['--version'], available: true, authStatus: null,
    modelsSource, path: `/usr/local/bin/${id}`, version: '1.0.0',
    models: [
      { id: 'default', label: 'Default' },
      { id: `${id}-fast`, label: `${name} Fast` },
      { id: `${id}-pro`, label: `${name} Pro` },
    ],
  };
}

const FALLBACK = agent('fixture-fb', 'Fixture Fallback CLI', 'fallback');
const LIVE = agent('fixture-live', 'Fixture Live CLI', 'live');

// The app selects the first available agent, so each case lists its agent first.
async function setup(page: Page, agents: readonly unknown[]) {
  const agentId = (agents[0] as { id: string }).id;
  await page.route('**/api/health', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
  await routeAgents(page, agents);
  await addStorageInitScript(
    page,
    ({ key, config }) => {
      window.localStorage.setItem(key, JSON.stringify(config));
    },
    { key: STORAGE_KEY, config: { mode: 'daemon', agentId, onboardingCompleted: true, agentModels: {} } },
  );
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.readable-loading-shell')).toHaveCount(0, { timeout: 15_000 });
  const privacyDialog = page.getByRole('dialog').filter({ hasText: 'Help us improve Readable Studio' });
  if (await privacyDialog.isVisible().catch(() => false)) {
    await privacyDialog.getByRole('button', { name: /I get it|not now|got it|don't share/i }).click();
  }
}

for (const width of [1280, 1024]) {
  test(`fallback-source agent shows the built-in note at ${width}px; live agent stays clean`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await setup(page, [FALLBACK, LIVE]);
    await page.getByTestId('inline-model-switcher-model-trigger').click();
    const list = page.getByTestId('inline-model-switcher-model-list');
    await expect(list).toBeVisible();
    const note = page.getByTestId('inline-model-switcher-source-note');
    await expect(note).toHaveText('Built-in defaults · not reported by Fixture Fallback CLI');
    await expect(list).toHaveAttribute('aria-describedby', (await note.getAttribute('id')) ?? '');
    const settled = () => page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)).then(() => undefined));
    await settled();
    const box = await list.boundingBox();
    await page.screenshot({ path: `${EVIDENCE}picker-fallback-${width}.png` });
    // Selection still works and the list did not move once the note rendered.
    await page.getByTestId('inline-model-switcher-model-option-fixture-fb-pro').click();
    await page.getByTestId('inline-model-switcher-model-trigger').click();
    await settled();
    expect(await list.boundingBox()).toEqual(box);
  });

  test(`live-source agent shows no note at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await setup(page, [LIVE, FALLBACK]);
    await page.getByTestId('inline-model-switcher-model-trigger').click();
    await expect(page.getByTestId('inline-model-switcher-model-list')).toBeVisible();
    await expect(page.getByTestId('inline-model-switcher-source-note')).toHaveCount(0);
    await page.screenshot({ path: `${EVIDENCE}picker-live-${width}.png` });
  });
}
