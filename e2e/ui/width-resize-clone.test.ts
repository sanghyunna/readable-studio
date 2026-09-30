import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { addStorageInitScript } from '@/playwright/storage-init';
import { waitForSaveResponse } from '@/playwright/manual-edit-events';

const active = 'iframe[data-readable-active="true"]';

test('[P0] released Ctrl-drag clone saves, reloads, exports and restores independently', async ({ page, browser }, testInfo) => {
  // Given: a real released element, not a seeded record or a DOM clone.
  await applyStandardMocks(page);
  await addStorageInitScript(page, () => { window.localStorage.setItem('readable-studio:welcome-modal-shown', '1'); }, undefined);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const projectId = `width-clone-${randomUUID()}`;
  expect((await page.request.post('/api/projects', { data: { id: projectId, name: 'Width clone', metadata: { kind: 'prototype' }, skipDiscoveryBrief: true } })).ok()).toBe(true);
  const source = '<!doctype html><html><head><style>body{margin:0;padding:24px;font:16px Arial}main{height:600px}.measure{max-width:20ch;margin:0 0 24px}</style></head><body><main><p data-readable-id="copy" class="measure" style="width:auto">A released paragraph that keeps its appearance when copied.</p></main></body></html>';
  expect((await page.request.post(`/api/projects/${projectId}/files`, { data: { name: 'width.html', content: source, artifactManifest: { schema: 'readable-studio.artifact-manifest.v1', kind: 'html', title: 'Width', entry: 'width.html', renderer: 'html', exports: ['html'] } } })).ok()).toBe(true);
  try {
    await page.goto(`/projects/${projectId}/files/width.html`);
    await page.getByTestId('manual-edit-mode-toggle').click();
    const frame = page.frameLocator(active);
    await expect(frame.locator('html[data-readable-edit-mode]')).toHaveCount(1);
    const original = frame.locator('[data-readable-id="copy"]');
    await original.click();
    const before = await original.boundingBox();
    const handle = await page.getByLabel('Resize right edge', { exact: true }).boundingBox();
    if (!handle || !before) throw new Error('Missing original resize geometry');
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 100, handle.y + handle.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect(original).toHaveAttribute('data-readable-width-release', /readable.width-release.v1/);
    const widened = await original.boundingBox();
    if (!widened) throw new Error('Missing released geometry');
    expect(widened.width).toBeGreaterThan(before.width + 98);
    let writes = 0;
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/projects/${projectId}/files`) writes++; });

    // When: duplicate using the actual Ctrl-drag interaction and explicitly Save.
    const move = await page.getByRole('group', { name: 'Move element' }).locator('[data-region="interior"]').boundingBox();
    if (!move) throw new Error('Missing move surface');
    await page.evaluate(() => {
      const events: unknown[] = [];
      Reflect.set(window, 'widthCloneEvents', events);
      window.addEventListener('message', event => {
        if (String(event.data?.type).startsWith('readable-edit-duplicate')) events.push(event.data);
      });
    });
    await page.mouse.move(move.x + move.width / 2, move.y + move.height / 2);
    await page.mouse.down();
    await page.mouse.move(move.x + move.width / 2, move.y + move.height / 2 + 12);
    await page.keyboard.down('Control');
    await page.mouse.move(move.x + move.width / 2, move.y + move.height / 2 + 140, { steps: 5 });
    const clone = frame.locator('[data-readable-id="copy-copy"]');
    await expect(clone).toHaveAttribute('data-readable-edit-transient', 'true');
    await page.mouse.up();
    await expect(clone).not.toHaveAttribute('data-readable-edit-transient');
    await page.keyboard.up('Control');
    await expect(clone).toHaveAttribute('data-readable-width-release', /"targetId":"copy-copy"/);
    expect((await clone.boundingBox())?.width).toBeCloseTo(widened.width, 0);
    expect(writes).toBe(0);
    const save = waitForSaveResponse(page, projectId);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    expect((await save).ok()).toBe(true);
    expect(writes).toBe(1);

    // Then: exported source and reopened source both retain independent restore ownership.
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).last().click();
    await page.getByRole('menuitem', { name: /Export as standalone HTML/i }).click();
    const stream = await (await download).createReadStream();
    if (!stream) throw new Error('Missing exported stream');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const exported = Buffer.concat(chunks).toString('utf8');
    const offlineContext = await browser.newContext({ offline: true });
    const offline = await offlineContext.newPage();
    try {
      await offline.goto(`data:text/html;base64,${Buffer.from(exported).toString('base64')}`);
      const ownership = await offline.locator('[data-readable-width-release]').evaluateAll(nodes => nodes.map(node => {
        const record = JSON.parse(node.getAttribute('data-readable-width-release') ?? 'null');
        return { id: record.id, targetId: record.targetId, before: record.before, after: record.after };
      }));
      expect(ownership).toHaveLength(2);
      expect(new Set(ownership.map(record => record.id)).size).toBe(2);
      expect(ownership.map(record => record.targetId)).toEqual(['copy', 'copy-copy']);
      expect(ownership[1]?.before).toEqual(ownership[0]?.before);
      expect(ownership[1]?.after).toEqual(ownership[0]?.after);
      for (const width of [768, 375, 320]) {
        await offline.setViewportSize({ width, height: 800 });
        const boxes = await offline.locator('[data-readable-width-release]').evaluateAll(nodes => nodes.map(node => {
          const rect = node.getBoundingClientRect();
          return { width: rect.width, right: rect.right, left: rect.left };
        }));
        expect(boxes[0]?.width).toBe(boxes[1]?.width);
        expect(boxes.every(box => box.left >= 23 && box.right <= width - 23)).toBe(true);
      }
      await offline.screenshot({ path: testInfo.outputPath('clones-offline-320.png') });
      await writeFile(testInfo.outputPath('clone-ownership.json'), JSON.stringify({ projectId, before, widened, ownership }, null, 2));
    } finally { await offlineContext.close(); }
    await page.reload();
    await page.getByTestId('manual-edit-mode-toggle').click();
    await expect(frame.locator('html[data-readable-edit-mode]')).toHaveCount(1);
    await original.click();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Restore authored sizing', exact: true }).click();
    await expect(original).not.toHaveAttribute('data-readable-width-release');
    expect((await original.boundingBox())?.width).toBeCloseTo(before.width, 0);
    await expect(clone).toHaveAttribute('data-readable-width-release', /readable.width-release.v1/);
    expect((await clone.boundingBox())?.width).toBeCloseTo(widened.width, 0);
    await clone.click();
    await page.getByRole('button', { name: 'Restore authored sizing', exact: true }).click();
    await expect(clone).not.toHaveAttribute('data-readable-width-release');
    expect((await clone.boundingBox())?.width).toBeCloseTo(before.width, 0);
    const restoredSave = waitForSaveResponse(page, projectId);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    expect((await restoredSave).ok()).toBe(true);
    expect(await (await page.request.get(`/api/projects/${projectId}/files/width.html`)).text()).not.toContain('data-readable-width-release');
    await page.screenshot({ path: testInfo.outputPath('clones-restored.png') });
    expect((await page.request.post(`/api/projects/${projectId}/files`, { data: { name: 'reimport.html', content: exported } })).ok()).toBe(true);
    await page.goto(`/projects/${projectId}/files/reimport.html`);
    await page.getByTestId('manual-edit-mode-toggle').click();
    await expect(frame.locator('html[data-readable-edit-mode]')).toHaveCount(1);
    for (const id of ['copy', 'copy-copy']) {
      const target = frame.locator(`[data-readable-id="${id}"]`);
      await target.click();
      await page.getByRole('button', { name: 'Restore authored sizing', exact: true }).click();
      await expect(target).not.toHaveAttribute('data-readable-width-release');
      expect((await target.boundingBox())?.width).toBeCloseTo(before.width, 0);
    }
    const reimportSave = waitForSaveResponse(page, projectId);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    expect((await reimportSave).ok()).toBe(true);
    expect(await (await page.request.get(`/api/projects/${projectId}/files/reimport.html`)).text()).not.toContain('data-readable-width-release');
  } finally {
    await writeFile(testInfo.outputPath('duplicate-events.json'), JSON.stringify(await page.evaluate(() => Reflect.get(window, 'widthCloneEvents') ?? []), null, 2));
    await page.keyboard.up('Control');
    expect((await page.request.delete(`/api/projects/${projectId}`)).ok()).toBe(true);
  }
});
