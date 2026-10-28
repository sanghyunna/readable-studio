import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type {
  DesignTemplateUploadAnalysisResponse as Analysis,
  DesignTemplateUploadBundleAnalysisResponse as Bundle,
  UserDesignTemplateSummary,
} from '@readable-studio/contracts';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { addStorageInitScript } from '@/playwright/storage-init';
import { buildBundle, buildZip } from '@/template-zip';
import { T } from '@/timeouts';

// Strong classifier signals: repeated fixed 16:9 `.slide` sections for the deck,
// an A4 portrait `@page` for the report.
const slides = (n: number) => `<!doctype html><html><head><link rel="stylesheet" href="assets/deck.css"></head><body><main class="deck">${
  [1, 2, 3].map((i) => `<section class="slide"><h1>Slide ${n}.${i}</h1></section>`).join('')}</main></body></html>`;
const deckZip = (name: string) => buildZip([
  { name: 'PROMPT.md', body: `---\nname: ${name}\ncover: slide-1.html\ndescription: Fixed-size slides\n---\nUse these slide layouts.\n` },
  { name: 'assets/deck.css', body: 'html,body{margin:0}.slide{width:1280px;height:720px;overflow:hidden}h1{padding:80px}' },
  ...[1, 2].map((n) => ({ name: `slide-${n}.html`, body: slides(n) })),
]);
const doc = (title: string) => `<!doctype html><html><head><link rel="stylesheet" href="../assets/doc.css"></head><body><article><h1>${title}</h1><p>${'Long form body text. '.repeat(40)}</p></article></body></html>`;
const reportZip = (name: string) => buildZip([
  { name: 'PROMPT.md', body: `---\nname: ${name}\ncover: report/cover.html\ndescription: Pages for an annual report\n---\nKeep the cover sober.\n` },
  { name: 'assets/doc.css', body: '@page{size:A4 portrait;margin:20mm}body{max-width:720px;margin:0 auto;font:16px/1.6 serif}' },
  { name: 'report/cover.html', body: doc('Cover') },
  { name: 'report/body.html', body: doc('Body') },
]);

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ page }) => {
  await applyStandardMocks(page);
  await addStorageInitScript(page, (locale: string) => {
    localStorage.setItem('readable-studio:locale', locale);
    localStorage.setItem('readable-studio:locale-source', 'manual');
  }, 'en');
});

async function userTemplates(page: Page): Promise<UserDesignTemplateSummary[]> {
  const response = await page.request.get('/api/design-templates');
  expect(response.ok(), await response.text()).toBe(true);
  const body = await response.json() as { designTemplates: Array<{ userImported?: boolean }> };
  return body.designTemplates.filter((t): t is UserDesignTemplateSummary => t.userImported === true);
}

async function openWizard(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Upload a template', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Upload through the real file input and press Next; returns the daemon's bundle analysis. */
async function uploadBundle(page: Page, dialog: Locator, fileName: string, zip: Buffer): Promise<Bundle> {
  await dialog.getByTestId('template-upload-file').setInputFiles({ name: fileName, mimeType: 'application/zip', buffer: zip });
  await expect(dialog.getByText(fileName, { exact: true })).toBeVisible();
  const analysed = page.waitForResponse((r) => r.request().method() === 'POST'
    && new URL(r.url()).pathname === '/api/design-template-uploads/analyse');
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  const response = await analysed;
  expect(response.status(), await response.text()).toBe(201);
  const body = await response.json() as Bundle;
  expect(body.kind).toBe('bundle');
  return body;
}

function okItems(bundle: Bundle): Analysis[] {
  return bundle.templates.flatMap((item) => item.ok ? [item.analysis] : []);
}

const isFinalize = (method: string, url: string) => method === 'POST'
  && /^\/api\/design-template-uploads\/[^/]+\/finalize$/.test(new URL(url).pathname);

/** Click the primary review button and return the finalize request body and the saved template. */
async function saveCurrent(page: Page, dialog: Locator, button: string) {
  const response = page.waitForResponse((r) => isFinalize(r.request().method(), r.url()));
  await dialog.getByRole('button', { name: button, exact: true }).click();
  const finalized = await response;
  expect(finalized.status(), await finalized.text()).toBe(201);
  return { body: finalized.request().postDataJSON() as unknown, template: (await finalized.json()).template as UserDesignTemplateSummary };
}

test('[P1] template bundle: no type step, per-template review with detected types, Hub tabs, cancel-all', async ({ page }) => {
  test.setTimeout(T.xlong * 3);
  const run = randomUUID().slice(0, 8);
  const deckName = `Bundle Deck ${run}`;
  const editedDeckName = `Edited Deck ${run}`;
  const reportName = `Bundle Report ${run}`;

  await page.goto('/');
  await expect(page.locator('[data-tab-id="deck"]')).toBeVisible({ timeout: T.long });
  const before = await userTemplates(page);

  // Step 1: three steps only (file, pages + cover, review); no type picker.
  let dialog = await openWizard(page);
  await expect(dialog.getByText('Step 1 of 3', { exact: true })).toBeVisible();
  await expect(dialog.locator('aside ol > li')).toHaveText([/Upload a ZIP/, /Pages and cover/, /Review/]);
  await expect(dialog.getByRole('radio')).toHaveCount(0);
  await expect(dialog.getByText('Slide decks')).toHaveCount(0);
  await expect(dialog.getByText('Reports')).toHaveCount(0);

  const bundle = await uploadBundle(page, dialog, `tb-pack-${run}.zip`, buildBundle([
    { name: 'a-deck.zip', zip: deckZip(deckName) },
    { name: 'b-report.zip', zip: reportZip(reportName) },
  ]));
  expect(bundle.templates.map((t) => [t.index, t.entryName, t.ok])).toEqual([[0, 'a-deck.zip', true], [1, 'b-report.zip', true]]);
  const [deck, report] = okItems(bundle);
  if (!deck || !report) throw new Error(JSON.stringify(bundle));
  expect([deck.detection?.type, deck.detection?.ambiguous]).toEqual(['deck', false]);
  expect([report.detection?.type, report.detection?.ambiguous]).toEqual(['report', false]);
  const deckCover = deck.pages.find((p) => p.file === 'slide-2.html');
  if (!deckCover) throw new Error(JSON.stringify(deck.pages));
  expect(deckCover.id).not.toBe(deck.suggestedCoverPageId);

  // Template 1 of 2 (deck): edit the name, pick slide-2 as the cover.
  const progress = dialog.getByTestId('template-upload-progress');
  await expect(progress).toContainText('Template 1 of 2', { timeout: T.long });
  await expect(progress).toContainText('a-deck.zip');
  await expect(dialog.getByText('Step 2 of 3', { exact: true })).toBeVisible();
  const name = dialog.getByLabel('Template name');
  await expect(name).toHaveValue(deckName);
  await name.fill(editedDeckName);
  const pages = dialog.getByTestId('template-upload-page');
  await expect(pages).toHaveCount(2);
  await expect(pages.filter({ hasText: 'slide-1.html' })).toHaveAttribute('aria-pressed', 'true');
  await pages.filter({ hasText: 'slide-2.html' }).click();
  await expect(pages.filter({ hasText: 'slide-2.html' })).toHaveAttribute('aria-pressed', 'true');
  await expect(pages.filter({ hasText: 'slide-1.html' })).toHaveAttribute('aria-pressed', 'false');
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();

  await expect(dialog.getByText('Step 3 of 3', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: editedDeckName })).toBeVisible();
  await expect(dialog.getByTestId('template-upload-detected-type')).toHaveText('Slide decks');
  await expect(dialog.locator('dt', { hasText: 'Choose a cover' }).locator('xpath=following-sibling::dd[1]')).toHaveText('slide-2.html');
  await expect(dialog.getByRole('button', { name: 'Change', exact: true })).toHaveCount(0);
  const savedDeck = await saveCurrent(page, dialog, 'Save & next');
  // No type override was picked, so the daemon resolves the stored detection.
  expect(savedDeck.body).toEqual({ name: editedDeckName, coverPageId: deckCover.id });
  expect(savedDeck.template).toMatchObject({ displayName: { en: editedDeckName }, templateType: 'deck' });

  // Template 2 of 2 (report): keep the suggested name and cover.
  await expect(progress).toContainText('Template 2 of 2');
  await expect(progress).toContainText('b-report.zip');
  await expect(dialog.getByText('Step 2 of 3', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);
  await expect(name).toHaveValue(reportName);
  await expect(pages.filter({ hasText: 'report/cover.html' })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(dialog.getByText('Step 3 of 3', { exact: true })).toBeVisible();
  await expect(dialog.getByTestId('template-upload-detected-type')).toHaveText('Reports');
  await expect(dialog.getByRole('button', { name: 'Save & next', exact: true })).toHaveCount(0);
  const savedReport = await saveCurrent(page, dialog, 'Finish');
  expect(savedReport.body).toEqual({ name: reportName, coverPageId: report.suggestedCoverPageId });
  expect(savedReport.template).toMatchObject({ displayName: { en: reportName }, templateType: 'report' });

  // Summary: two saved, nothing skipped, failed or invalid.
  const summary = dialog.getByTestId('template-upload-summary');
  await expect(summary).toBeVisible();
  await expect(summary.getByRole('heading')).toHaveText(['Saved (2)']);
  // The names the user confirmed, as on the Hub cards (the summary's `name` is the id slug).
  // Soft, so a failure here still lets the Hub and cancel-all checks below report.
  await expect.soft(summary.getByRole('listitem')).toHaveText([editedDeckName, reportName]);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).toBeHidden();

  // Hub: the first saved template's tab is selected; each card sits only under its own tab.
  const rail = page.getByTestId('hub-template-carousel-rail');
  const card = (id: string) => rail.locator(`[data-testid="hub-template-item"][data-plugin-id="${id}"]`);
  await expect(page.locator('[data-tab-id="deck"]')).toHaveAttribute('aria-selected', 'true');
  await expect(card(savedDeck.template.id)).toBeVisible();
  await expect(card(savedDeck.template.id)).toContainText(editedDeckName);
  await expect(card(savedReport.template.id)).toHaveCount(0);
  await page.locator('[data-tab-id="report"]').click();
  await expect(page.locator('[data-tab-id="report"]')).toHaveAttribute('aria-selected', 'true');
  await expect(card(savedReport.template.id)).toBeVisible();
  await expect(card(savedReport.template.id)).toContainText(reportName);
  await expect(card(savedDeck.template.id)).toHaveCount(0);

  const afterSave = await userTemplates(page);
  expect(afterSave).toHaveLength(before.length + 2);
  expect(Object.fromEntries(afterSave.filter((t) => !before.some((b) => b.id === t.id)).map((t) => [t.id, t.templateType])))
    .toEqual({ [savedDeck.template.id]: 'deck', [savedReport.template.id]: 'report' });

  // Cancel-all on a second bundle: one bundle DELETE, both children gone, nothing registered.
  dialog = await openWizard(page);
  const second = await uploadBundle(page, dialog, `tb-cancel-${run}.zip`, buildBundle([
    { name: 'x-deck.zip', zip: deckZip(`Cancelled Deck ${run}`) },
    { name: 'y-report.zip', zip: reportZip(`Cancelled Report ${run}`) },
  ]));
  const children = okItems(second).map((a) => a.sessionId);
  expect(children).toHaveLength(2);
  await expect(dialog.getByTestId('template-upload-progress')).toContainText('Template 1 of 2', { timeout: T.long });
  const cancelled = page.waitForResponse((r) => r.request().method() === 'DELETE'
    && new URL(r.url()).pathname === `/api/design-template-uploads/bundles/${second.bundleId}`);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  const cancelResponse = await cancelled;
  expect(cancelResponse.status()).toBe(200);
  expect([...(await cancelResponse.json()).cancelledSessionIds].sort()).toEqual([...children].sort());
  await expect(dialog).toBeHidden();
  for (const sessionId of children) {
    expect((await page.request.get(`/api/design-template-uploads/${sessionId}`)).status()).toBe(404);
  }
  expect((await userTemplates(page)).map((t) => t.id).sort()).toEqual(afterSave.map((t) => t.id).sort());
});
