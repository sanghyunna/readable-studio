import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { addStorageInitScript } from '@/playwright/storage-init';
import { randomUUID } from 'node:crypto';
import { waitForSaveResponse } from '@/playwright/manual-edit-events';
import { T } from '@/timeouts';

const active = 'iframe[data-readable-active="true"]';
const html = (targetStyle = '', parentStyle = '', measure = '20ch') => `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:24px;font:16px Arial}main{width:100%;box-sizing:border-box;${parentStyle}}.measure{max-width:${measure};margin:0 0 20px}p{line-height:1.5}</style></head><body><main><p data-readable-id="copy" class="measure" style="${targetStyle}">The user chooses the reading measure for this paragraph, not the generated default.</p><p data-readable-id="peer" class="measure">The same class stays capped.</p></main></body></html>`;

async function openSample(page: Page, source: string) {
  await applyStandardMocks(page);
  await addStorageInitScript(page, () => { window.localStorage.setItem('readable-studio:welcome-modal-shown', '1'); }, undefined);
  // Project creation is fixture setup, not the gesture under test. Avoid the
  // unrelated first-home hydration/modal race while keeping all file I/O real.
  const projectId = `width-release-${randomUUID()}`;
  expect((await page.request.post('/api/projects', { data: { id: projectId, name: 'Width release contract', metadata: { kind: 'prototype' }, skipDiscoveryBrief: true } })).ok()).toBe(true);
  const response = await page.request.post(`/api/projects/${projectId}/files`, { data: { name: 'width.html', content: source,
    artifactManifest: { schema: 'readable-studio.artifact-manifest.v1', kind: 'html', title: 'Width', entry: 'width.html', renderer: 'html', exports: ['html'] } } });
  expect(response.ok()).toBe(true);
  await page.goto(`/projects/${projectId}/files/width.html`);
  await expect(page.locator(active)).toBeVisible();
  await page.getByTestId('manual-edit-mode-toggle').click();
  const frame = page.frameLocator(active);
  await expect(frame.locator('html[data-readable-edit-mode]')).toHaveCount(1);
  await frame.locator('[data-readable-id="copy"]').click();
  await expect(page.getByLabel('Resize right edge', { exact: true })).toBeVisible();
  return projectId;
}

async function drag(page: Page, delta = 100, overshoot = false) {
  const handle = page.getByLabel('Resize right edge', { exact: true });
  const box = (await handle.boundingBox())!;
  // Subscribe to the exact final bridge acknowledgement before the gesture.
  await page.evaluate(timeout => {
    (window as unknown as { widthFinal: Promise<unknown> }).widthFinal = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.removeEventListener('message', listener); reject(new Error('final resize acknowledgement missing')); }, timeout);
      function listener(event: MessageEvent) {
        const frame = document.querySelector<HTMLIFrameElement>('iframe[data-readable-active="true"]');
        if (event.source !== frame?.contentWindow || event.data?.type !== 'readable-edit-preview-style-applied' || event.data.stage !== 'finalize') return;
        clearTimeout(timer); window.removeEventListener('message', listener); resolve(event.data.resize);
      }
      window.addEventListener('message', listener);
    });
  }, T.medium);
  if (overshoot) await page.evaluate(timeout => {
    (window as unknown as { widthPreview: Promise<void> }).widthPreview = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.removeEventListener('message', listener); reject(new Error('safe preview missing')); }, timeout);
      function listener(event: MessageEvent) {
        const frame = document.querySelector<HTMLIFrameElement>('iframe[data-readable-active="true"]');
        if (event.source !== frame?.contentWindow || event.data?.stage !== 'preview' || event.data.resize?.decision !== 'release-own') return;
        clearTimeout(timer); window.removeEventListener('message', listener); resolve();
      }
      window.addEventListener('message', listener);
    });
  }, T.medium);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + delta, box.y + box.height / 2, { steps: 5 });
  if (overshoot) {
    await page.evaluate(() => (window as unknown as { widthPreview: Promise<void> }).widthPreview);
    await page.mouse.move(box.x + box.width / 2 + 1500, box.y + box.height / 2);
  }
  await page.mouse.up();
  return page.evaluate(() => (window as unknown as { widthFinal: Promise<{ decision: string; proposedDeclarations?: unknown[] }> }).widthFinal);
}

test('[P0] 65ch own cap drag releases, saves, reloads and restores without Undo', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const source = html('width:auto; max-width:65ch', '', '65ch');
  const projectId = await openSample(page, source);
  const frame = page.frameLocator(active);
  const before = await frame.locator('[data-readable-id="copy"]').boundingBox();
  const peer = await frame.locator('[data-readable-id="peer"]').boundingBox();
  let writes = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/projects/${projectId}/files`) writes++; });
  const result = await drag(page);
  expect(result.decision).toBe('release-own');
  await expect(frame.locator('[data-readable-id="copy"]')).toHaveAttribute('data-readable-width-release', /readable.width-release.v1/);
  const after = await frame.locator('[data-readable-id="copy"]').boundingBox();
  expect(after!.width).toBeGreaterThan(before!.width + 90);
  expect((await frame.locator('[data-readable-id="peer"]').boundingBox())!.width).toBeCloseTo(peer!.width, 0);
  expect(writes).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('released.png') });
  // An unrelated edit must not let this browser's CSSOM erase other engines' fallbacks.
  await page.getByRole('textbox', { name: 'Text color value', exact: true }).fill('#123456');
  const saved = waitForSaveResponse(page, projectId);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  expect((await saved).ok()).toBe(true);
  expect(writes).toBe(1);
  const persisted = await (await page.request.get(`/api/projects/${projectId}/files/width.html`)).text();
  expect(persisted).toContain('data-readable-width-release');
  expect(persisted).not.toContain('!important');
  expect(persisted).toContain('max-width: 100%');
  expect(persisted).toContain('max-width: -moz-available');
  expect(persisted).toContain('max-width: stretch');
  const persistedRecord = await page.evaluate(source => {
    const node = new DOMParser().parseFromString(source, 'text/html').querySelector('[data-readable-id="copy"]');
    return JSON.parse(node?.getAttribute('data-readable-width-release') ?? 'null');
  }, persisted);
  expect(persistedRecord.before).toEqual([{ property: 'width', value: 'auto', priority: '' }, { property: 'max-width', value: '65ch', priority: '' }]);
  await page.reload();
  await page.getByTestId('manual-edit-mode-toggle').click();
  await expect(frame.locator('html[data-readable-edit-mode]')).toHaveCount(1);
  await frame.locator('[data-readable-id="copy"]').click();
  const restored = frame.locator('[data-readable-id="copy"]');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('reloaded-release.png') });
  await page.getByRole('button', { name: 'Restore authored sizing', exact: true }).click();
  await expect(restored).not.toHaveAttribute('data-readable-width-release');
  expect((await restored.boundingBox())!.width).toBeCloseTo(before!.width, 0);
  const savedRestore = waitForSaveResponse(page, projectId);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  expect((await savedRestore).ok()).toBe(true);
  expect(await (await page.request.get(`/api/projects/${projectId}/files/width.html`)).text()).not.toContain('data-readable-width-release');
  expect(await page.locator('[data-readable-width-preflight]').count()).toBe(0);
  const restoredStyle = await frame.locator('[data-readable-id="copy"]').getAttribute('style');
  expect(restoredStyle).toContain('width: auto; max-width: 65ch;');
  expect(restoredStyle).toContain('rgb(18, 52, 86)');
  await page.screenshot({ path: testInfo.outputPath('restored.png') });
  await writeFile(testInfo.outputPath('measurements.json'), JSON.stringify({ projectId, before, after, peer, persistedRecord, restoredStyle }, null, 2));
});

for (const mode of ['Auto', 'Fill'] as const) {
  test(`[P0] released width ${mode} mode preserves restoration ownership`, async ({ page }) => {
    // Given
    await openSample(page, html('width:100px'));
    await drag(page);
    const target = page.frameLocator(active).locator('[data-readable-id="copy"]');
    await expect(target).toHaveAttribute('data-readable-width-release', /readable.width-release.v1/);
    const original = JSON.parse((await target.getAttribute('data-readable-width-release')) ?? 'null');
    await page.getByRole('button', { name: /^Size & position/ }).click();
    // When
    await page.getByRole('button', { name: `${mode} Width`, exact: true }).click();
    // Then
    await expect(target).toHaveAttribute('data-readable-width-release', new RegExp(`"mode":"${mode.toLowerCase()}"`));
    const updated = JSON.parse((await target.getAttribute('data-readable-width-release')) ?? 'null');
    expect(updated.before).toEqual(original.before);
    expect(updated.id).toBe(original.id);
    expect(updated.after.filter((d: { property: string }) => d.property === 'max-width').map((d: { value: string }) => d.value)).toEqual(['100%', '-moz-available', 'stretch']);
  });
}

test('[P0] released width inspector updates retain the first restoration baseline', async ({ page }) => {
  // Given
  await openSample(page, html());
  await drag(page);
  const target = page.frameLocator(active).locator('[data-readable-id="copy"]');
  await expect(target).toHaveAttribute('data-readable-width-release', /readable.width-release.v1/);
  const original = JSON.parse((await target.getAttribute('data-readable-width-release')) ?? 'null');
  await page.getByRole('button', { name: /^Size & position/ }).click();
  // When
  await page.getByRole('textbox', { name: 'Width', exact: true }).fill('400');
  // Then
  await expect(target).toHaveAttribute('data-readable-width-release', /"preferredCssPx":400/);
  const updated = JSON.parse((await target.getAttribute('data-readable-width-release')) ?? 'null');
  expect(updated.before).toEqual(original.before);
  expect(updated.id).toBe(original.id);
});

for (const priority of ['', '!important']) {
  test(`[P0] stretch-only narrow fit ${priority || 'normal'} refuses and offers agent handoff without a source write`, async ({ page }) => {
    const source = html('padding:20px;border:2px solid;box-sizing:content-box').replace('max-width:20ch', `max-width:20ch${priority}`);
    const projectId = await openSample(page, source);
    await drag(page);
    await expect(page.getByRole('button', { name: 'Make this widenable', exact: true })).toBeVisible();
    expect(await (await page.request.get(`/api/projects/${projectId}/files/width.html`)).text()).toBe(source);
    expect(await page.frameLocator(active).locator('[data-readable-width-release]').count()).toBe(0);
    expect(await page.locator('[data-readable-width-preflight]').count()).toBe(0);
  });
}

for (const [name, targetStyle, parentStyle, extraCss] of [
  ['scale', '', 'transform:scale(.75);transform-origin:top left', ''],
  ['zoom', '', 'zoom:1.25', ''],
  ['logical cap', 'max-width:none;max-inline-size:20ch', '', ''],
  ['percentage cap', 'max-width:30%', '', ''],
  ['inline important', 'max-width:20ch !important', '', ''],
  ['unchanged grid area', 'grid-column:1', 'display:grid;grid-template-columns:1fr 1fr;gap:20px', ''],
  ['independent inline', 'display:inline', '', ''],
  ['padded Q3 parent', '', 'width:min(920px,100%);padding-inline:64px', ''],
  ['media cap', '', '', '@media (min-width:600px){.measure{max-width:22ch}}'],
  ['container cap', '', 'container-type:inline-size', '@container (min-width:600px){.measure{max-width:22ch}}'],
] as const) {
  test(`[P1] ${name} own cap releases inside its unchanged content allocation`, async ({ page }) => {
    // Given
    await page.setViewportSize({ width: 1920, height: 1080 });
    const source = html(targetStyle, parentStyle).replace('</style>', `${extraCss}</style>`);
    await openSample(page, source);
    const target = page.frameLocator(active).locator('[data-readable-id="copy"]');
    const before = await target.boundingBox();
    // When
    const result = await drag(page, 60);
    // Then
    expect(result.decision, JSON.stringify(result)).toBe('release-own');
    await expect(target).toHaveAttribute('data-readable-width-release', /readable.width-release.v1/);
    expect((await target.boundingBox())!.width).toBeGreaterThan(before!.width + 58);
  });
}

for (const property of ['max-width', 'width'] as const) {
  test(`[P0] stylesheet-important ${property} routes to the agent without source mutation`, async ({ page }) => {
    // Given
    const source = html().replace('max-width:20ch', `${property}:20ch!important`);
    const projectId = await openSample(page, source);
    const frame = page.frameLocator(active);
    const target = frame.locator('[data-readable-id="copy"]');
    const before = await target.boundingBox();
    const peerBefore = await frame.locator('[data-readable-id="peer"]').boundingBox();
    const beforeStyle = await target.getAttribute('style');
    let writes = 0;
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/projects/${projectId}/files`) writes++; });
    // When
    const outcome = await drag(page, 60);
    // Then
    expect(outcome).toMatchObject({ decision: 'refused', classification: 'shared-style',
      causes: expect.arrayContaining([expect.objectContaining({ code: 'shared-style-width', confidence: 'confirmed',
        declaration: expect.objectContaining({ property, priority: 'important', origin: 'stylesheet' }) })]) });
    await expect(target).not.toHaveAttribute('data-readable-width-release');
    expect(await target.getAttribute('style')).toBe(beforeStyle);
    expect((await target.boundingBox())?.width).toBe(before?.width);
    expect((await frame.locator('[data-readable-id="peer"]').boundingBox())?.width).toBe(peerBefore?.width);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Make this widenable', exact: true }).click();
    const composer = page.getByTestId('chat-composer-input');
    await expect(composer).toContainText('<readable-width-request>');
    const text = await composer.innerText();
    const payload = JSON.parse(text.split('<readable-width-request>')[1]?.split('</readable-width-request>')[0] ?? 'null');
    expect(payload.causes).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'shared-style-width' })]));
    expect(payload.requestedRectWidth).toBeGreaterThan(payload.actualRectWidth + 58);
    expect(writes).toBe(0);
    expect(await (await page.request.get(`/api/projects/${projectId}/files/width.html`)).text()).toBe(source);
  });
}

test('[P0] an overshooting pointer commits only the last safe release candidate', async ({ page }) => {
  // Given
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openSample(page, html());
  const target = page.frameLocator(active).locator('[data-readable-id="copy"]');
  const before = await target.boundingBox();
  // When
  await drag(page, 100, true);
  // Then
  await expect(target).toHaveAttribute('data-readable-width-release', /readable.width-release.v1/);
  const after = await target.boundingBox();
  expect(after!.width).toBeGreaterThan(before!.width);
  expect(after!.width).toBeLessThanOrEqual(before!.width + 101);
});

test('[P0] parent grid allocation refuses and writes nothing', async ({ page }) => {
  // Given
  const source = html('max-width:none;grid-column:1', 'display:grid;grid-template-columns:120px 1fr;gap:20px');
  const projectId = await openSample(page, source);
  // When
  const result = await drag(page);
  // Then
  expect(result.decision).toBe('parent-owned');
  await expect(page.getByRole('button', { name: 'Make this widenable', exact: true })).toBeVisible();
  expect(await (await page.request.get(`/api/projects/${projectId}/files/width.html`)).text()).toBe(source);
});

test('[P0] parent flex allocation still refuses and writes nothing', async ({ page }) => {
  const source = html('flex:1 1 0;max-width:none', 'display:flex;gap:20px');
  const projectId = await openSample(page, source);
  const result = await drag(page);
  expect(result.decision).toBe('parent-owned');
  await expect(page.getByRole('button', { name: 'Make this widenable', exact: true })).toBeVisible();
  expect(await (await page.request.get(`/api/projects/${projectId}/files/width.html`)).text()).toBe(source);
});
