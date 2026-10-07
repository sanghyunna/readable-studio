import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { ensureRailOpen } from './rail.js';
import { T } from '../timeouts.js';

// This historical filename remains the shared import boundary. Creation is now
// session-first: the rail opens the Hub composer and submission creates a
// standalone session or one in the selected folder.

export async function dismissWelcomeModal(page: Page): Promise<void> {
  const welcome = page.getByTestId('welcome-modal');
  await expect
    .poll(
      async () =>
        (await welcome.count()) > 0
        || (await page.evaluate(() => window.localStorage.getItem('readable-studio:welcome-modal-shown') === '1')),
      { timeout: T.short },
    )
    .toBe(true)
    .catch(() => undefined);
  if (await welcome.isVisible()) {
    await page.keyboard.press('Escape');
    await expect(welcome).toHaveCount(0, { timeout: T.short });
  }
}

/** Opens a new standalone session composer and proves it owns focus. */
export async function pressNewSession(page: Page, context = 'new-session'): Promise<void> {
  await dismissWelcomeModal(page);
  await ensureRailOpen(page);
  const trigger = page.getByTestId('hub-new-session');
  await expect(trigger, `[${context}] control must be visible on the real surface`).toBeVisible({ timeout: T.short });
  await trigger.click();
  await expect(page).toHaveURL(/\/$/, { timeout: T.medium });
  const composer = page.getByTestId('home-hero-input');
  await expect(composer).toBeVisible({ timeout: T.medium });
  await expect(composer, `[${context}] the Hub composer must own focus`).toBeFocused({ timeout: T.medium });
}

export interface CreateEmptySessionOptions {
  kind?: 'prototype' | 'deck' | 'other' | 'template';
  name?: string;
  context?: string;
}

/** Creates a session through the Hub's explicit "Continue without prompt" command. */
export async function createEmptySessionFromHub(page: Page, options: CreateEmptySessionOptions = {}): Promise<string> {
  const context = options.context ?? 'create-session';
  await pressNewSession(page, context);
  if (options.kind === 'prototype' || options.kind === 'deck') {
    await runPaletteCreateCommand(page, options.kind, context);
    await expect(page.getByTestId('home-hero-active-type-chip')).toHaveAttribute('data-chip-id', options.kind, { timeout: T.medium });
  }
  await runPaletteCreateCommand(page, 'continue', context);
  await expect(page).toHaveURL(/\/projects\/[^/]+\/conversations\/[^/]+$/, { timeout: T.long });
  const parts = new URL(page.url()).pathname.split('/');
  const sessionId = parts.at(-1);
  if (!sessionId) throw new Error(`[${context}] unexpected session route: ${page.url()}`);
  if (options.name) {
    await ensureRailOpen(page);
    const row = page.getByTestId(`hub-session-${sessionId}`);
    await expect(row).toBeVisible({ timeout: T.medium });
    await row.hover();
    await page.getByTestId(`hub-menu-session-${sessionId}`).click();
    await page.getByTestId('hub-row-menu-rename').click();
    const field = page.getByTestId(`hub-rename-s-${sessionId}`);
    await expect(field).toBeVisible({ timeout: T.short });
    await field.fill(options.name);
    await field.press('Enter');
    await expect(row).toContainText(options.name, { timeout: T.medium });
  }
  return sessionId;
}

/** Moves one rendered session via its keyboard-equivalent context menu. */
export async function moveSessionViaMenu(
  page: Page,
  sessionId: string,
  destination: string | null,
): Promise<void> {
  const row = page.getByTestId(`hub-session-${sessionId}`);
  await expect(row).toBeVisible({ timeout: T.medium });
  await row.hover();
  await page.getByTestId(`hub-menu-session-${sessionId}`).click();
  await page.getByTestId('hub-row-menu-move').click();
  await page.getByTestId(`hub-row-menu-move-${destination ?? 'none'}`).click();
  await expect(row).toHaveAttribute('data-folder', destination ?? 'none', { timeout: T.medium });
}

/** Drags one rendered session to a folder row or the recent-session drop target. */
export async function dragSessionTo(
  page: Page,
  sessionId: string,
  destination: string | null,
): Promise<void> {
  const source = page.getByTestId(`hub-session-${sessionId}`);
  const target: Locator = destination === null
    ? page.getByTestId('hub-section-recents')
    : page.getByTestId(`hub-project-${destination}`);
  await expect(source).toBeVisible({ timeout: T.medium });
  await expect(target).toBeVisible({ timeout: T.medium });
  await source.dragTo(target);
  await expect(source).toHaveAttribute('data-folder', destination ?? 'none', { timeout: T.medium });
}

async function runPaletteCreateCommand(page: Page, command: string, context: string): Promise<void> {
  await page.getByTestId('hub-open-palette').click();
  const item = page.getByTestId(`hub-palette-item-command-create-${command}`);
  await expect(item, `[${context}] palette command ${command} must be listed`).toBeVisible({ timeout: T.medium });
  await item.click();
  await expect(page.getByTestId('hub-command-palette')).toHaveCount(0, { timeout: T.medium });
}

/** Open the composer "+" menu on the Hub; returns nothing, asserts it opened. */
export async function openComposerPlusMenu(page: Page): Promise<void> {
  await dismissWelcomeModal(page);
  await page.getByTestId('home-hero-plus-trigger').click();
  await expect(page.getByTestId('composer-plus-attach')).toBeVisible({ timeout: T.short });
}

// Compatibility aliases keep older e2e callers on the session-first surface.
export const pressNewProject = pressNewSession;
export type CreateEmptyProjectOptions = CreateEmptySessionOptions;
export const createEmptyProjectFromHub = createEmptySessionFromHub;
