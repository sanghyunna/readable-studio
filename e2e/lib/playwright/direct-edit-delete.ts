import { expect, type Page, type Request } from '@playwright/test';
import { T } from '../timeouts.ts';

export type DeleteFocusOwner = 'host' | 'iframe';
export const deletePreviewSelector = '[data-testid="artifact-preview-frame"]:visible, [data-testid="artifact-preview-frame-url-load"]:visible, [data-testid="artifact-preview-frame-srcdoc"]:visible';
export const deletePreview = (page: Page) => page.locator(deletePreviewSelector).first();
export const deleteFrame = (page: Page) => page.frameLocator(deletePreviewSelector);

export async function armDeletePreviewLoad(page: Page) {
  const marker = `${Date.now()}-${Math.random()}`;
  const preview = deletePreview(page);
  await preview.evaluate((node, value) => {
    node.addEventListener('load', () => node.setAttribute('data-delete-qa-load', value), { once: true });
  }, marker);
  return () => expect(preview).toHaveAttribute('data-delete-qa-load', marker, { timeout: T.medium });
}

export type DeleteFixture = {
  projectId: string;
  fileName: string;
  targetSelector: string;
  survivorSelector: string;
  originalSource: string;
  readSource(): Promise<string>;
};

export function captureDeleteWrites(page: Page, projectId: string) {
  const writes: string[] = [];
  const listener = (request: Request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/projects/${projectId}/files`) {
      writes.push(request.postData() ?? '');
    }
  };
  page.on('request', listener);
  return { writes, stop: () => page.off('request', listener) };
}

export async function enterDeleteEditMode(page: Page) {
  await page.getByTestId('manual-edit-mode-toggle').click();
  await expect(deleteFrame(page).locator('html[data-readable-edit-mode]')).toHaveCount(1, { timeout: T.medium });
}

export async function focusDeleteOwner(page: Page, owner: DeleteFocusOwner) {
  if (owner === 'host') {
    const surface = page.getByRole('group', { name: 'Move element' }).locator('[data-region="interior"]');
    await surface.focus();
    await expect(surface).toBeFocused();
  } else {
    await deleteFrame(page).locator('body').evaluate(body => {
      const active = body.ownerDocument.activeElement;
      if (active instanceof HTMLElement) active.blur();
      body.ownerDocument.defaultView?.focus();
    });
    await expect(deletePreview(page)).toBeFocused();
  }
}

export async function selectDeleteTarget(page: Page, selector: string, owner: DeleteFocusOwner) {
  const target = deleteFrame(page).locator(selector);
  await target.click();
  await expect(target).toHaveAttribute('data-readable-edit-selected', 'true');
  await expect(target).not.toHaveAttribute('contenteditable');
  await focusDeleteOwner(page, owner);
}

export async function pressDeleteBurst(page: Page) {
  // Playwright marks consecutive down events as repeats, just like a held key.
  await page.keyboard.down('Delete');
  await page.keyboard.down('Delete');
  await page.keyboard.down('Delete');
  await page.keyboard.up('Delete');
}

export async function assertLinkedDeleteAppearance(page: Page) {
  const frame = deleteFrame(page);
  await expect(frame.locator('.linked-proof')).toHaveCSS('background-color', 'rgb(12, 34, 56)');
  const background = await frame.locator('.linked-proof').evaluate(node => getComputedStyle(node).backgroundImage);
  expect(background).toMatch(/(?:data:image\/|\/assets\/images\/pattern\.svg)/);
  const image = frame.locator('img.linked-image');
  await expect(image).toBeVisible();
  await image.evaluate(async element => { await (element as HTMLImageElement).decode(); });
  expect(await image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(24);
  return { background, image: await image.getAttribute('src') };
}

export async function assertNativeDelete(page: Page, targetSelector: string) {
  const target = deleteFrame(page).locator(targetSelector);
  await target.dblclick();
  await expect(target).toHaveAttribute('contenteditable', /^(true|plaintext-only)$/);
  await page.keyboard.press('Home');
  const before = await target.textContent();
  await page.keyboard.press('Delete');
  await expect(target).toHaveText((before ?? '').slice(1));
  await expect(target).toHaveCount(1);
  await page.keyboard.press('Escape');
}

export type DeleteJourneyInput = {
  page: Page;
  fixture: DeleteFixture;
  owner: DeleteFocusOwner;
  finish: 'save' | 'discard';
  pendingColor?: string;
  linked?: boolean;
  scroll?: boolean;
  slide?: string;
  screenshot?: (state: string) => Promise<void>;
  evidence?: {
    scrollBefore: { x: number; y: number } | null;
    scrollAfter: { x: number; y: number } | null;
  };
};

function pendingColorHex(color: string) {
  const rgb = /^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/.exec(color);
  if (!rgb) return color;
  return '#' + rgb.slice(1, 4).map(n => Number(n).toString(16).padStart(2, '0')).join('');
}

export async function runDeleteJourney(input: DeleteJourneyInput) {
  const { page, fixture, owner, finish } = input;
  const capture = captureDeleteWrites(page, fixture.projectId);
  const frame = deleteFrame(page);
  const target = frame.locator(fixture.targetSelector);
  const survivor = frame.locator(fixture.survivorSelector);
  try {
    await enterDeleteEditMode(page);
    if (input.slide) await expect(frame.locator('#deck-cur')).toHaveText(input.slide);
    const linkedBefore = input.linked ? await assertLinkedDeleteAppearance(page) : undefined;
    await selectDeleteTarget(page, fixture.targetSelector, owner);
    if (input.pendingColor) {
      // The inspector only accepts #rrggbb; callers pass the computed rgb() form.
      await page.locator('.manual-edit-left-inspector').getByLabel('Text color value', { exact: true }).fill(pendingColorHex(input.pendingColor));
      await expect(target).toHaveCSS('color', input.pendingColor);
      await expect(page.locator('.manual-edit-error')).toHaveCount(0);
      await focusDeleteOwner(page, owner);
    }
    // Selection scrolls the target into view. Capture that actual position, not a
    // requested offset which the browser may clamp.
    const scrollBefore = await frame.locator('body').evaluate(() => ({ x: scrollX, y: scrollY }));
    if (input.evidence) input.evidence.scrollBefore = scrollBefore;
    if (input.scroll) expect(scrollBefore.y).toBeGreaterThan(0);
    await input.screenshot?.('selected');
    const deletedLoad = await armDeletePreviewLoad(page);
    await pressDeleteBurst(page);
    await deletedLoad();
    await expect(frame.locator('html[data-readable-edit-mode]')).toHaveCount(1);
    await expect(target).toHaveCount(0, { timeout: T.medium });
    await expect(survivor).toHaveCount(1);
    await expect(page.locator('.manual-edit-error')).toHaveCount(0);
    const scrollAfter = await frame.locator('body').evaluate(() => new Promise<{ x: number; y: number }>(done => {
      requestAnimationFrame(() => done({ x: scrollX, y: scrollY }));
    }));
    if (input.evidence) input.evidence.scrollAfter = scrollAfter;
    if (input.scroll) {
      expect(Math.abs(scrollAfter.y - scrollBefore.y)).toBeLessThanOrEqual(2);
      expect(Math.abs(scrollAfter.x - scrollBefore.x)).toBeLessThanOrEqual(2);
    }
    if (input.slide) await expect(frame.locator('#deck-cur')).toHaveText(input.slide);
    expect(capture.writes).toHaveLength(0);
    expect(await fixture.readSource()).toBe(fixture.originalSource);
    await input.screenshot?.('deleted');
    // Structural replacement clears selection; a new held-key event must not
    // remove the id-less sibling even after the original transaction settles.
    await page.keyboard.press('Delete');
    await expect(survivor).toHaveCount(1);
    await deletePreview(page).focus();
    const undoneLoad = await armDeletePreviewLoad(page);
    await page.keyboard.press('Control+z');
    await undoneLoad();
    await expect(target).toHaveCount(1, { timeout: T.medium });
    if (input.pendingColor) await expect(target).toHaveCSS('color', input.pendingColor);
    await input.screenshot?.('restored');
    await deletePreview(page).focus();
    const redoneLoad = await armDeletePreviewLoad(page);
    await page.keyboard.press('Control+Shift+z');
    await redoneLoad();
    await expect(target).toHaveCount(0, { timeout: T.medium });
    expect(capture.writes).toHaveLength(0);
    const inspector = page.locator('.manual-edit-left-inspector');
    const exited = inspector.waitFor({ state: 'detached', timeout: T.medium });
    if (finish === 'save') {
      const response = page.waitForResponse(r => r.request().method() === 'POST'
        && new URL(r.url()).pathname === `/api/projects/${fixture.projectId}/files`, { timeout: T.medium });
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      expect((await response).ok()).toBe(true);
      await exited;
      expect(capture.writes).toHaveLength(1);
      const saved = JSON.parse(capture.writes[0]!);
      expect(saved.name).toBe(fixture.fileName);
      expect(await fixture.readSource()).toBe(saved.content);
      await enterDeleteEditMode(page);
      await expect(target).toHaveCount(0);
      await expect(survivor).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Undo', exact: true }).last()).toBeDisabled();
      await page.getByTestId('manual-edit-mode-toggle').click();
    } else {
      await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
      await exited;
      await expect(target).toHaveCount(1);
      expect(capture.writes).toHaveLength(0);
      expect(await fixture.readSource()).toBe(fixture.originalSource);
    }
    const linkedAfter = input.linked ? await assertLinkedDeleteAppearance(page) : undefined;
    await input.screenshot?.(finish);
    return { owner, finish, writeCount: capture.writes.length, writes: capture.writes,
      scrollBefore, scrollAfter, slide: input.slide, linkedBefore, linkedAfter };
  } finally {
    capture.stop();
  }
}
