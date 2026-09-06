import { expect, test } from '@playwright/test';
import {
  captureVisual,
  configureVisualPage,
  gotoVisualHome,
  waitForVisualFonts,
  waitForVisualProjects,
} from '@/playwright/visual';
import { gotoVisualPlugins } from '@/playwright/visual-home';

test('[P2] captures the visual home harness', async ({ page }) => {
  await configureVisualPage(page, { projects: [] });
  await gotoVisualHome(page);

  await expect(page.getByTestId('home-hero')).toBeVisible();
  await expect(page.getByTestId('home-hero-input')).toBeVisible();
  await waitForVisualProjects(page, []);

  await captureVisual(page, 'visual-home');
});

test('[P2] captures the plugins catalog reached from the Hub', async ({ page }) => {
  await configureVisualPage(page);
  await gotoVisualHome(page);

  const plugins = await gotoVisualPlugins(page);
  await expect(plugins.getByTestId('plugins-home-section')).toBeVisible();
  await expect(plugins.getByText('Prototype Starter').first()).toBeVisible();

  await captureVisual(page, 'visual-plugins-catalog');
});

test('[P2] captures the plugins filtered surface reached from the Hub', async ({ page }) => {
  await configureVisualPage(page);
  await gotoVisualHome(page);

  const plugins = await gotoVisualPlugins(page);
  await plugins.getByTestId('plugins-home-pill-category-deck').click();
  await expect(plugins.locator('article.plugins-home__card[data-plugin-id="visual-deck-writer"]')).toBeVisible();

  await captureVisual(page, 'visual-plugins-filter');
});

test('[P2] captures the plugin detail surface reached from the Hub', async ({ page }) => {
  await configureVisualPage(page);
  await gotoVisualHome(page);

  const plugins = await gotoVisualPlugins(page);
  await plugins.getByTestId('plugins-home-pill-category-deck').click();
  const card = plugins.locator('article.plugins-home__card[data-plugin-id="visual-deck-writer"]');
  await expect(card).toBeVisible();
  await card.hover();
  await plugins.getByTestId('plugins-home-details-visual-deck-writer').click({ force: true });
  await expect(page.getByRole('dialog', { name: /Deck Writer preview/i })).toBeVisible();
  await expect(page.getByTestId('plugin-details-use-visual-deck-writer')).toBeVisible();
  await expect(page.locator('.ds-modal-stage-iframe-scaler iframe')).toBeVisible();

  await captureVisual(page, 'visual-plugin-details');
});

test('[P2] captures the plugin detail share menu surface reached from the Hub', async ({ page }) => {
  await configureVisualPage(page);
  await gotoVisualHome(page);

  const plugins = await gotoVisualPlugins(page);
  await plugins.getByTestId('plugins-home-pill-category-deck').click();
  const card = plugins.locator('article.plugins-home__card[data-plugin-id="visual-deck-writer"]');
  await expect(card).toBeVisible();
  await card.hover();
  await plugins.getByTestId('plugins-home-details-visual-deck-writer').click({ force: true });
  await expect(page.getByRole('dialog', { name: /Deck Writer preview/i })).toBeVisible();
  await page.locator('.template-share-trigger').click();
  await expect(page.locator('.template-share-popover[role="menu"]')).toBeVisible();

  await captureVisual(page, 'visual-plugin-share-menu');
});

test('[P2] captures the home context picker surface', async ({ page }) => {
  await configureVisualPage(page);
  await gotoVisualHome(page);

  await page.getByTestId('home-hero-input').fill('@visual');
  await expect(page.getByTestId('home-hero-plugin-picker')).toBeVisible();
  await expect(page.getByRole('option', { name: /Prototype Starter/i })).toBeVisible();

  await captureVisual(page, 'visual-home-context-picker');
});

test('[P2] captures the home staged attachment surface', async ({ page }) => {
  await configureVisualPage(page);
  await gotoVisualHome(page);

  await page.getByTestId('home-hero-file-input').setInputFiles({
    name: 'visual-brief.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Visual regression fixture for staged home attachments.\n', 'utf8'),
  });
  await expect(page.getByTestId('home-hero-staged-files')).toContainText('visual-brief.txt');

  await captureVisual(page, 'visual-home-staged-attachment');
});

test('[P2] captures plugin use staged on the Hub composer', async ({ page }) => {
  await configureVisualPage(page);
  await gotoVisualHome(page);

  const plugins = await gotoVisualPlugins(page);
  await plugins.getByTestId('plugins-home-details-visual-prototype-starter').click({ force: true });
  await expect(page.getByRole('dialog', { name: /Prototype Starter details/i })).toBeVisible();
  await page.getByTestId('plugin-details-use-visual-prototype-starter').click();
  await expect(page.getByTestId('home-hero-active-plugin')).toContainText('Prototype Starter');
  await expect(page.getByTestId('home-hero-input')).toBeVisible();

  await captureVisual(page, 'visual-home-plugin-use-staged');
});

test('[P2] captures plugin use with query on the Hub composer', async ({ page }) => {
  await configureVisualPage(page);
  await gotoVisualHome(page);

  const plugins = await gotoVisualPlugins(page);
  await plugins.getByTestId('plugins-home-pill-category-deck').click();
  const card = plugins.locator('article.plugins-home__card[data-plugin-id="visual-deck-writer"]');
  await expect(card).toBeVisible();
  await plugins.getByTestId('plugins-home-details-visual-deck-writer').click({ force: true });
  // Deck Writer ships an example output, so its detail surface is the
  // PreviewModal (aria-label "Deck Writer preview"), not the scenario
  // detail's "... details" dialog. Match on the plugin name only.
  await expect(page.getByRole('dialog', { name: /Deck Writer/i })).toBeVisible();
  await page.getByTestId('plugin-details-use-visual-deck-writer-menu').click();
  await page.getByTestId('plugin-details-use-with-query-visual-deck-writer').click();
  // use-with-query now seeds the rendered preset text (placeholders filled in),
  // not the raw `{{...}}` query — matching the example-prompt card path.
  await expect(page.getByTestId('home-hero-input')).toContainText('Draft a topic deck.');

  await captureVisual(page, 'visual-home-plugin-use-with-query');
});
