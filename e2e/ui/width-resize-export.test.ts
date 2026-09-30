import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { addStorageInitScript } from '@/playwright/storage-init';
import { waitForSaveResponse } from '@/playwright/manual-edit-events';

const active = 'iframe[data-readable-active="true"]';

test('[P0] a newly dragged release exports offline at narrow widths and restores after reimport', async ({ page, browser }, testInfo) => {
  // Given: a real project with an authored cap and a restorable inline baseline.
  await applyStandardMocks(page);
  await addStorageInitScript(page, () => { window.localStorage.setItem('readable-studio:welcome-modal-shown', '1'); }, undefined);
  const projectId = `width-export-${randomUUID()}`;
  const created = await page.request.post('/api/projects', { data: { id: projectId, name: 'Width export', metadata: { kind: 'prototype' }, skipDiscoveryBrief: true } });
  expect(created.ok()).toBe(true);
  const source = '<!doctype html><html><head><style>body{margin:0;padding:24px;font:16px Arial}p{max-width:20ch;margin:0}</style></head><body><p data-readable-id="copy" style="width:auto">A user-owned reading measure with a durable restore baseline.</p></body></html>';
  const written = await page.request.post(`/api/projects/${projectId}/files`, { data: { name: 'width.html', content: source, artifactManifest: { schema: 'readable-studio.artifact-manifest.v1', kind: 'html', title: 'Width', entry: 'width.html', renderer: 'html', exports: ['html'] } } });
  expect(written.ok()).toBe(true);
  try {
    await page.goto(`/projects/${projectId}/files/width.html`);
    await page.getByTestId('manual-edit-mode-toggle').click();
    const frame = page.frameLocator(active);
    await expect(frame.locator('html[data-readable-edit-mode]')).toHaveCount(1);
    await frame.locator('[data-readable-id="copy"]').click();
    const handle = page.getByLabel('Resize right edge', { exact: true });
    const box = await handle.boundingBox();
    if (!box) throw new Error('Missing resize handle');
    // When: use real pointer input, explicit Save and the actual download menu.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect(frame.locator('[data-readable-id="copy"]')).toHaveAttribute('data-readable-width-release', /readable.width-release.v1/);
    const saved = waitForSaveResponse(page, projectId);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    expect((await saved).ok()).toBe(true);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).last().click();
    await page.getByRole('menuitem', { name: /Export as standalone HTML/i }).click();
    const stream = await (await download).createReadStream();
    if (!stream) throw new Error('Download stream missing');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const exported = Buffer.concat(chunks).toString('utf8');
    // Then: inspect the downloaded bytes offline, not the preview draft.
    expect(exported).toContain('max-width: 100%; max-width: -moz-available; max-width: stretch;');
    const offlineContext = await browser.newContext({ offline: true });
    const offline = await offlineContext.newPage();
    const measurements = [];
    try {
      await offline.goto(`data:text/html;base64,${Buffer.from(exported).toString('base64')}`);
      for (const width of [768, 375, 320]) {
        await offline.setViewportSize({ width, height: 700 });
        const measured = await offline.locator('[data-readable-id="copy"]').evaluate(node => {
          const rect = node.getBoundingClientRect();
          const record = JSON.parse(node.getAttribute('data-readable-width-release') ?? 'null');
          return { width: window.innerWidth, left: rect.left, right: rect.right, preferred: record.preferredCssPx, before: record.before };
        });
        expect(measured.left).toBeGreaterThanOrEqual(23);
        expect(measured.right).toBeLessThanOrEqual(width - 23);
        expect(measured.before).toEqual([{ property: 'width', value: 'auto', priority: '' }]);
        measurements.push(measured);
      }
      await offline.screenshot({ path: testInfo.outputPath('offline-320.png') });
    } finally { await offlineContext.close(); }
    const imported = await page.request.post(`/api/projects/${projectId}/files`, { data: { name: 'reimport.html', content: exported } });
    expect(imported.ok()).toBe(true);
    await page.goto(`/projects/${projectId}/files/reimport.html`);
    await page.getByTestId('manual-edit-mode-toggle').click();
    await expect(frame.locator('html[data-readable-edit-mode]')).toHaveCount(1);
    await frame.locator('[data-readable-id="copy"]').click();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Restore authored sizing', exact: true }).click();
    await expect(frame.locator('[data-readable-id="copy"]')).not.toHaveAttribute('data-readable-width-release');
    const restoreSaved = waitForSaveResponse(page, projectId);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    expect((await restoreSaved).ok()).toBe(true);
    const restored = await (await page.request.get(`/api/projects/${projectId}/files/reimport.html`)).text();
    expect(restored).toContain('width: auto;');
    expect(restored).not.toContain('data-readable-width-release');
    await writeFile(testInfo.outputPath('offline-measurements.json'), JSON.stringify(measurements, null, 2));
  } finally {
    const deleted = await page.request.delete(`/api/projects/${projectId}`);
    expect(deleted.ok()).toBe(true);
  }
});
