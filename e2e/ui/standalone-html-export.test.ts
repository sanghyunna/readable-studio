import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { waitForSaveResponse } from '@/playwright/manual-edit-events';

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

test('[P0] saved ordinary width and escaped data record survive standalone export for document and fragment', async ({ page, context }, testInfo) => {
  const projectId = `width-export-${Date.now()}`;
  const record = { schema: 'readable.width-sample.v1', text: 'A & "B" <C>' };
  try {
    const created = await page.request.post('/api/projects', {
      data: { id: projectId, name: 'Width export characterization', metadata: { kind: 'prototype' }, skipDiscoveryBrief: true },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    for (const [kind, source] of [
      ['document', `<!doctype html><html><body><main><div data-readable-id="width-target" data-sample="${JSON.stringify(record).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}" style="width:200px">Width target</div></main></body></html>`],
      ['fragment', `<main><div data-readable-id="width-target" data-sample="${JSON.stringify(record).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}" style="width:200px">Width target</div></main>`],
    ] as const) {
      const name = `${kind}.html`;
      await seedTextFile(page, projectId, name, source, true);
      await page.goto(`/projects/${projectId}/files/${name}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('file-workspace')).toBeVisible({ timeout: T.medium });
      const frame = page.frameLocator('[data-testid="artifact-preview-frame"]:visible, [data-testid="artifact-preview-frame-srcdoc"]:visible');
      await expect(frame.locator('[data-readable-id="width-target"]')).toBeVisible();
      await page.getByTestId('manual-edit-mode-toggle').click();
      await frame.locator('[data-readable-id="width-target"]').click();
      const inspector = page.locator('.manual-edit-left-inspector');
      await expect(inspector.getByRole('button', { name: /Size & position/ })).toBeVisible();
      await inspector.getByRole('button', { name: /Size & position/ }).click();
      await inspector.getByRole('button', { name: 'Fill Width' }).click();
      const save = waitForSaveResponse(page, projectId);
      await page.getByRole('button', { name: 'Save changes' }).click();
      expect((await save).status()).toBe(200);
      const persisted = await page.request.get(`/api/projects/${projectId}/files/${name}`);
      const savedSource = await persisted.text();
      expect(savedSource).toMatch(/width:\s*100%/);
      expect(savedSource).toContain('data-sample=');
      const download = page.waitForEvent('download', { timeout: T.long });
      await page.getByRole('button', { name: 'Download', exact: true }).last().click();
      await page.getByRole('menuitem', { name: /Export as standalone HTML/i }).click();
      const savedPath = testInfo.outputPath(`${kind}-offline.html`);
      await (await download).saveAs(savedPath);
      const html = await readFile(savedPath, 'utf8');
      await context.setOffline(true);
      const offline = await context.newPage();
      try {
        await offline.goto(pathToFileURL(savedPath).href);
        const result = await offline.locator('[data-readable-id="width-target"]').evaluate((node) => ({
          record: JSON.parse(node.getAttribute('data-sample')!),
          width: getComputedStyle(node).width,
          parentWidth: getComputedStyle(node.parentElement!).width,
          inlineWidth: (node as HTMLElement).style.width,
        }));
        expect(result.record).toEqual(record);
        expect(result.inlineWidth).toBe('100%');
        expect(Math.abs(Number.parseFloat(result.width) - Number.parseFloat(result.parentWidth))).toBeLessThan(1);
        console.log(`WIDTH_EXPORT ${kind} ${JSON.stringify({ ...result, rawRecord: html.includes('data-sample=') })}`);
        await testInfo.attach(`${kind}-export.json`, { body: JSON.stringify(result), contentType: 'application/json' });
      } finally {
        await offline.close();
        await context.setOffline(false);
      }
      await seedTextFile(page, projectId, `reimport-${name}`, html, true);
      const reimported = await page.request.get(`/api/projects/${projectId}/files/reimport-${name}`);
      expect(await reimported.text()).toBe(html);
      await page.goto(`/projects/${projectId}/files/reimport-${name}`, { waitUntil: 'domcontentloaded' });
      await expect(page.frameLocator('[data-testid="artifact-preview-frame"]:visible, [data-testid="artifact-preview-frame-srcdoc"]:visible')
        .locator('[data-readable-id="width-target"]')).toHaveAttribute('data-sample', JSON.stringify(record));
    }
    // A Vite module entry exports its built dist HTML instead of edited source HTML.
    await seedTextFile(page, projectId, 'vite.html', '<!doctype html><p data-sample="source-only">Source</p><script type="module" src="/src/main.ts"></script>', true);
    await seedTextFile(page, projectId, 'dist/index.html', '<!doctype html><p data-sample="dist-only">Built</p>');
    await page.goto(`/projects/${projectId}/files/vite.html`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('file-workspace')).toBeVisible({ timeout: T.medium });
    const viteDownload = page.waitForEvent('download', { timeout: T.long });
    await page.getByRole('button', { name: 'Download', exact: true }).last().click();
    await page.getByRole('menuitem', { name: /Export as standalone HTML/i }).click();
    const vitePath = testInfo.outputPath('vite-selection.html');
    await (await viteDownload).saveAs(vitePath);
    const viteHtml = await readFile(vitePath, 'utf8');
    expect(viteHtml).toContain('dist-only');
    expect(viteHtml).not.toContain('source-only');
    console.log('WIDTH_EXPORT vite-module source=false dist=true');
  } finally {
    const deleted = await page.request.delete(`/api/projects/${projectId}`);
    expect(deleted.ok()).toBe(true);
  }
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
