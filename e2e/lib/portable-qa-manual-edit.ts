import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, type ElectronApplication, type Page, type Response } from '@playwright/test';

import { observeTransactionActions, transactionActionCount, type ActionEvidence } from './portable-qa-evidence.ts';
import { captureCompactFooterGeometry } from './portable-qa-footer-geometry.ts';
import { previewSelector, toRecord } from '../scripts/portable-qa-support.ts';

export type ManualEditSession = {
  readonly daemonUrl: string;
  readonly electronApp: ElectronApplication;
  readonly evidenceRoot: string;
  readonly page: Page;
  readonly projectId: string;
  readonly sourcePath: string;
};

function isProjectFileWrite(response: Response, projectId: string): boolean {
  return response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/projects/${projectId}/files`;
}

export async function runManualEditTransactions(input: ManualEditSession) {
  const { daemonUrl, evidenceRoot, page, projectId, sourcePath } = input;
  const rendererWrites: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    if (new URL(request.url()).pathname !== `/api/projects/${projectId}/files`) return;
    rendererWrites.push(request.postData() ?? '');
  });

  await page.evaluate((path) => {
    window.history.pushState(null, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, `/projects/${projectId}`);
  const preview = page.locator(previewSelector).first();
  const fileButton = page.getByRole('button', { name: /portable-deck\.html/i });
  await fileButton.waitFor({ state: 'visible', timeout: 30_000 });
  await fileButton.click();
  const openButton = page.getByTestId('design-file-preview').getByRole('button', { name: 'Open' });
  if (await openButton.isVisible()) await openButton.click();
  await preview.waitFor({ state: 'visible', timeout: 60_000 });
  const frame = page.frameLocator(previewSelector);
  const title = frame.locator('[data-readable-id="task30-title"]');
  const editToggle = page.getByTestId('manual-edit-mode-toggle');
  const saveButton = page.getByRole('button', { name: /^(Save changes|저장하기)$/u });
  const discardButton = page.getByRole('button', { name: /^(Discard changes|저장 안함)$/u });
  await title.waitFor({ state: 'visible', timeout: 30_000 });
  const baselineSource = await readFile(sourcePath, 'utf8');
  const baselineHash = createHash('sha256').update(baselineSource).digest('hex');

  await editToggle.click();
  await expect(frame.locator('html[data-readable-edit-mode]')).toHaveCount(1);
  const cleanActionCount = (await observeTransactionActions(page)).length;
  assert.equal(cleanActionCount, 0, 'clean edit mode exposed transaction actions');
  await title.dblclick();
  await expect(title).toHaveAttribute('contenteditable', 'true');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Portable Edited');
  await page.keyboard.press('Enter');
  await expect(title).toHaveText('Portable Edited');
  await expect(title).toHaveAttribute('data-readable-edit-selected', 'true');
  const inspector = page.locator('.manual-edit-left-inspector');
  await inspector.getByLabel(/^(Font size|글꼴 크기)$/u).fill('44');
  await inspector.getByLabel(/^(Text color value|텍스트 색상 값)$/u).fill('#2563eb');
  await expect(title).toHaveCSS('font-size', '44px');
  await expect(title).toHaveCSS('color', 'rgb(37, 99, 235)');
  const orderedVisibleLabels = await observeTransactionActions(page);
  const dirtyActionCount = orderedVisibleLabels.length;
  assert.equal(dirtyActionCount, 2, 'dirty edit mode did not expose exactly Save and Discard');
  const writesBeforeSave = rendererWrites.length;
  assert.equal(writesBeforeSave, 0, 'manual edits wrote before Save');
  assert.equal(await readFile(sourcePath, 'utf8'), baselineSource, 'source changed before Save');

  const geometry = await inspector.evaluate((root) => {
    if (!(root instanceof HTMLElement)) return null;
    const footer = root.querySelector('.manual-edit-left-inspector-footer');
    if (!(footer instanceof HTMLElement)) return null;
    const scrollRegion = footer.previousElementSibling;
    if (!(scrollRegion instanceof HTMLElement)) return null;
    const topBeforeScroll = footer.getBoundingClientRect().top;
    scrollRegion.scrollTop = scrollRegion.scrollHeight;
    const inspectorRect = root.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    const buttonsInside = Array.from(footer.querySelectorAll('button')).every((button) => {
      const rect = button.getBoundingClientRect();
      return rect.left >= footerRect.left - 1
        && rect.right <= footerRect.right + 1
        && rect.top >= footerRect.top - 1
        && rect.bottom <= footerRect.bottom + 1;
    });
    return {
      documentHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      footerOverflow: footer.scrollWidth > footer.clientWidth
        || footerRect.left < inspectorRect.left - 1
        || footerRect.right > inspectorRect.right + 1
        || !buttonsInside,
      footerPinned: scrollRegion.parentElement === root
        && footer.parentElement === root
        && Math.abs(footer.getBoundingClientRect().top - topBeforeScroll) <= 1,
    };
  });
  assert.ok(geometry, 'manual edit footer geometry was unavailable');
  assert.equal(geometry.footerPinned, true, 'manual edit footer moved with the scroll region');
  assert.equal(geometry.footerOverflow, false, 'manual edit footer or actions overflowed the inspector');
  assert.equal(geometry.documentHorizontalOverflow, false, 'document has horizontal overflow');
  await page.screenshot({ path: join(evidenceRoot, 'dirty-footer.png'), fullPage: true });
  await captureCompactFooterGeometry({ electronApp: input.electronApp, evidenceRoot, page });

  const saveResponsePromise = page.waitForResponse((response) => isProjectFileWrite(response, projectId));
  await saveButton.click();
  const saveResponse = await saveResponsePromise;
  const saveStatus = saveResponse.status();
  assert.ok(saveStatus >= 200 && saveStatus < 300, `Save returned ${saveStatus}`);
  await expect(inspector).toHaveCount(0);
  await expect(saveButton).toHaveCount(0);
  await expect(discardButton).toHaveCount(0);
  await expect(editToggle).toHaveAttribute('aria-pressed', 'false');
  const writesAfterSave = rendererWrites.length;
  assert.equal(writesAfterSave, 1, 'Save did not produce exactly one renderer file write');
  const saveRequest = toRecord(JSON.parse(rendererWrites[0] ?? ''), 'Save request body');
  assert.equal(saveRequest.expectedContentSha256, baselineHash, 'Save request entry hash differs from the baseline');
  assert.ok(typeof saveRequest.content === 'string', 'Save request has no source content');
  const requestedSource = saveRequest.content;
  assert.match(requestedSource, /Portable Edited/u);
  assert.match(requestedSource, /font-size:\s*44px/u);
  assert.match(requestedSource, /rgb\(37,\s*99,\s*235\)/u);
  const savedSource = await readFile(sourcePath, 'utf8');
  assert.equal(savedSource, requestedSource, 'authoritative saved source differs from the Save request');
  const saveExited = await editToggle.getAttribute('aria-pressed') === 'false' && await transactionActionCount(page) === 0;
  assert.equal(saveExited, true, 'successful Save did not exit edit mode cleanly');

  await preview.evaluate((node) => {
    node.removeAttribute('data-task30-save-reload');
    node.addEventListener('load', () => node.setAttribute('data-task30-save-reload', 'true'), { once: true });
  });
  await title.evaluate(() => window.location.reload());
  await expect(preview).toHaveAttribute('data-task30-save-reload', 'true');
  await expect(frame.getByText('Portable Edited', { exact: true })).toBeVisible();
  await expect(title).toHaveCSS('font-size', '44px');

  await editToggle.click();
  await title.click();
  await expect(title).toHaveAttribute('data-readable-edit-selected', 'true');
  await inspector.getByLabel(/^(Font size|글꼴 크기)$/u).fill('52');
  await expect(title).toHaveCSS('font-size', '52px');
  assert.equal(await transactionActionCount(page), 2, 'Discard transaction did not become dirty');
  const discardActionsRemoved = Promise.all([
    inspector.waitFor({ state: 'detached' }),
    expect(saveButton).toHaveCount(0),
    expect(discardButton).toHaveCount(0),
  ]);
  const discardPreviewRestored = expect(title).toHaveCSS('font-size', '44px');
  await discardButton.click();
  await discardActionsRemoved;
  await discardPreviewRestored;
  const writesAfterDiscard = rendererWrites.length;
  assert.equal(writesAfterDiscard, 1, 'Discard issued a renderer file write');
  const discardExited = await transactionActionCount(page) === 0;
  const discardRestored = await readFile(sourcePath, 'utf8') === savedSource
    && await title.evaluate((element) => getComputedStyle(element).fontSize) === '44px'
    && discardExited;
  assert.equal(discardRestored, true, 'Discard did not restore the saved baseline');
  await page.screenshot({ path: join(evidenceRoot, 'discard-restored.png'), fullPage: true });

  await preview.evaluate((node) => {
    node.removeAttribute('data-task30-discard-reload');
    node.addEventListener('load', () => node.setAttribute('data-task30-discard-reload', 'true'), { once: true });
  });
  await title.evaluate(() => window.location.reload());
  await expect(preview).toHaveAttribute('data-task30-discard-reload', 'true');
  await expect(frame.getByText('Portable Edited', { exact: true })).toBeVisible();
  assert.equal(await readFile(sourcePath, 'utf8'), savedSource, 'reload after Discard changed the saved baseline');

  await editToggle.click();
  await title.click();
  await expect(title).toHaveAttribute('data-readable-edit-selected', 'true');
  await preview.focus();
  await page.keyboard.press('ArrowRight');
  await expect(title).toHaveAttribute('style', /translate:/u);
  assert.equal(await transactionActionCount(page), 2, 'geometry edit did not become dirty');
  const undoButton = page.getByRole('button', { name: /^(Undo|실행 취소)$/u }).last();
  const redoButton = page.getByRole('button', { name: /^(Redo|다시 실행)$/u }).last();
  await undoButton.click();
  await expect(title).not.toHaveAttribute('style', /translate:/u);
  await expect(saveButton).toHaveCount(0);
  await expect(discardButton).toHaveCount(0);
  const undoClean = await editToggle.getAttribute('aria-pressed') === 'true'
    && await transactionActionCount(page) === 0
    && rendererWrites.length === 1
    && await readFile(sourcePath, 'utf8') === savedSource;
  assert.equal(undoClean, true, 'Undo to entry was not clean, active, and write-free');
  await redoButton.click();
  await expect(title).toHaveAttribute('style', /translate:/u);
  assert.equal(await transactionActionCount(page), 2, 'Redo did not restore the dirty geometry edit');
  await undoButton.click();
  await expect(title).not.toHaveAttribute('style', /translate:/u);
  await expect(saveButton).toHaveCount(0);
  await editToggle.click();
  await expect(editToggle).toHaveAttribute('aria-pressed', 'false');
  assert.equal(rendererWrites.length, 1, 'clean edit-mode exit issued a renderer file write');

  await editToggle.click();
  await title.click();
  await inspector.getByLabel(/^(Font size|글꼴 크기)$/u).fill('54');
  await expect(title).toHaveCSS('font-size', '54px');
  const externalSource = savedSource.replace('Portable Edited', 'External Conflict');
  const conflictSetup = await page.request.post(`${daemonUrl}/api/projects/${projectId}/files`, {
    data: { name: 'portable-deck.html', content: externalSource },
  });
  assert.ok(conflictSetup.ok(), `conflict setup returned ${conflictSetup.status()}`);
  assert.equal(rendererWrites.length, 1, 'external conflict setup was counted as a renderer write');
  const conflictResponsePromise = page.waitForResponse((response) => isProjectFileWrite(response, projectId));
  await saveButton.click();
  const conflictResponse = await conflictResponsePromise;
  assert.equal(conflictResponse.status(), 409, 'conflicting Save did not return 409');
  await expect(title).toHaveCSS('font-size', '54px');
  await expect(editToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(saveButton).toBeEnabled();
  await expect(discardButton).toBeEnabled();
  const conflictActionsRetained = await editToggle.getAttribute('aria-pressed') === 'true'
    && await title.evaluate((element) => getComputedStyle(element).fontSize) === '54px'
    && await saveButton.isEnabled()
    && await discardButton.isEnabled()
    && JSON.stringify(await observeTransactionActions(page)) === JSON.stringify(orderedVisibleLabels);
  assert.equal(conflictActionsRetained, true, 'conflicting Save did not retain the local actions');
  const conflictRestore = await page.request.post(`${daemonUrl}/api/projects/${projectId}/files`, {
    data: { name: 'portable-deck.html', content: savedSource },
  });
  assert.ok(conflictRestore.ok(), `conflict restore returned ${conflictRestore.status()}`);
  assert.equal(rendererWrites.length, 2, 'external conflict restore was counted as a renderer write');
  const conflictDiscarded = inspector.waitFor({ state: 'detached' });
  await discardButton.click();
  await conflictDiscarded;
  assert.equal(await readFile(sourcePath, 'utf8'), savedSource, 'conflict cleanup did not restore the fixture');

  await writeFile(join(evidenceRoot, 'portable-deck-source.html'), savedSource, 'utf8');
  const actionEvidence: ActionEvidence = {
    cleanActionCount,
    conflictActionsRetained,
    conflictStatus: conflictResponse.status(),
    discardExited,
    discardRestored,
    dirtyActionCount,
    orderedVisibleLabels,
    saveExited,
    saveStatus,
    undoClean,
    writesAfterDiscard,
    writesAfterSave,
    writesBeforeSave,
  };
  return {
    ...actionEvidence,
    actionEvidence,
    documentHorizontalOverflow: geometry.documentHorizontalOverflow,
    footerOverflow: geometry.footerOverflow,
    footerPinned: geometry.footerPinned,
  };
}
