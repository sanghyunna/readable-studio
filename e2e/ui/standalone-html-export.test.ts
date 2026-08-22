import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { applyStandardMocks } from '@/playwright/mock-factory';
import { configureVisualPage, gotoVisualHome } from '@/playwright/visual';
import { T } from '@/timeouts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII=',
  'base64',
);

test.describe.configure({ timeout: T.xlong });

test.beforeEach(async ({ page }) => {
  await applyStandardMocks(page);
});

test('[P1] FileViewer downloads offline standalone HTML and reports unresolved references', async ({ page, context }, testInfo) => {
  const projectId = `standalone-export-${Date.now()}`;
  try {
    const created = await page.request.post('/api/projects', {
      data: { id: projectId, name: 'Standalone export', metadata: { kind: 'prototype' }, skipDiscoveryBrief: true },
    });
    expect(created.ok(), await created.text()).toBeTruthy();

    await seedTextFile(page, projectId, 'index.html',
      '<!doctype html><link rel="stylesheet" href="styles.css"><main class="hero"><img id="logo" src="logo.png"></main>',
      true,
    );
    await seedTextFile(page, projectId, 'styles.css', '.hero{width:20px;height:20px;background-image:url(bg.png)}');
    await uploadPng(page, projectId, 'logo.png');
    await uploadPng(page, projectId, 'bg.png');

    await page.goto(`/projects/${projectId}/files/index.html`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('file-workspace')).toBeVisible({ timeout: T.medium });
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).last().click();
    await page.getByRole('menuitem', { name: /Export as standalone HTML/i }).click();
    const completedDownload = await download;
    const savedPath = testInfo.outputPath('standalone.html');
    await completedDownload.saveAs(savedPath);
    const html = await readFile(savedPath, 'utf8');
    expect(html.match(/data:image\/png;base64,/g)).toHaveLength(2);
    expect(html).not.toContain('logo.png');
    expect(html).not.toContain('bg.png');

    await context.setOffline(true);
    const offline = await context.newPage();
    try {
      await offline.goto(pathToFileURL(savedPath).href);
      await expect.poll(() => offline.locator('#logo').evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(1);
      await expect.poll(() => offline.locator('.hero').evaluate((node) => getComputedStyle(node).backgroundImage)).toContain('data:image/png;base64,');
    } finally {
      await offline.close();
      await context.setOffline(false);
    }

    await seedTextFile(page, projectId, 'warnings.html',
      '<!doctype html><img src="https://example.invalid/external.png"><img src="missing.png">',
      true,
    );
    await page.goto(`/projects/${projectId}/files/warnings.html`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('file-workspace')).toBeVisible({ timeout: T.medium });
    const warningDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).last().click();
    await page.getByRole('menuitem', { name: /Export as standalone HTML/i }).click();
    await warningDownload;
    await expect(page.locator('.readable-toast')).toContainText('1 external');
    await expect(page.locator('.readable-toast')).toContainText('1 missing');
  } finally {
    await page.request.delete(`/api/projects/${projectId}`).catch(() => undefined);
  }
});

test('[P1] PreviewModal exports plugin examples and design-system views through the shared endpoint', async ({ page }) => {
  const requests: unknown[] = [];
  await page.unrouteAll();
  await configureVisualPage(page);
  await page.route('**/api/exports/standalone-html', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      contentType: 'text/html',
      headers: {
        'x-readable-studio-external-reference-count': '0',
        'x-readable-studio-missing-local-reference-count': '0',
        'x-readable-studio-skipped-system-font-count': '0',
      },
      body: '<!doctype html><p>standalone</p>',
    });
  });
  await gotoVisualHome(page);
  await page.goto('/plugins', { waitUntil: 'domcontentloaded' });
  const plugins = page.getByTestId('plugins-home-section');
  await plugins.getByTestId('plugins-home-pill-category-deck').click();
  await plugins.getByTestId('plugins-home-details-visual-deck-writer').click({ force: true });
  await expect(page.getByRole('dialog', { name: /Deck Writer preview/i })).toBeVisible();
  await page.locator('.template-share-trigger').click();
  let download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /standalone HTML/i }).click();
  await download;
  expect(requests.at(-1)).toEqual({
    source: { kind: 'plugin', pluginId: 'visual-deck-writer', exampleName: 'deck' },
  });

  await page.keyboard.press('Escape');
  await page.goto('/design-systems', { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Official presets' }).click();
  await page.getByTestId('design-system-preview-agentic').click();
  await expect(page.getByRole('dialog', { name: /Agentic/i })).toBeVisible();
  await page.locator('.template-share-trigger').click();
  download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /standalone HTML/i }).click();
  await download;
  expect(requests.at(-1)).toEqual({
    source: { kind: 'design-system', designSystemId: 'agentic', view: 'showcase' },
  });
});

async function seedTextFile(page: Page, projectId: string, name: string, content: string, artifact = false) {
  const response = await page.request.post(`/api/projects/${projectId}/files`, {
    data: {
      name,
      content,
      ...(artifact ? {
        artifactManifest: { schema: 'readable-studio.artifact-manifest.v1', kind: 'html', title: name, entry: name, renderer: 'html', exports: ['html'] },
      } : {}),
    },
  });
  expect(response.ok(), `${name}: ${await response.text()}`).toBeTruthy();
}

async function uploadPng(page: Page, projectId: string, name: string) {
  const response = await page.request.post(`/api/projects/${projectId}/files`, {
    multipart: { name, file: { name, mimeType: 'image/png', buffer: PNG } },
  });
  expect(response.ok(), `${name}: ${await response.text()}`).toBeTruthy();
}
