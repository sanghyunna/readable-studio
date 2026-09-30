import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ensureRailOpen } from './rail.js';
import { T } from '../timeouts.js';

// "새 프로젝트" no longer opens a modal. The rail button (and Ctrl/Cmd+N, and
// the Projects empty-state CTA) lands on the Hub and puts the caret in the
// composer; typing a brief and sending is how a project is created. The
// modal's imports and saved-template start moved into the composer "+" menu.
//
// The file keeps its historical name so the many specs that import it keep
// resolving; the exported helpers describe the new flow.

/**
 * The 1.2.0 first-run welcome is a modal backdrop over the whole shell; specs
 * that do not seed `readable-studio:welcome-modal-shown` meet it on first
 * paint. It owns Escape, so dismiss it before driving the rail.
 */
export async function dismissWelcomeModal(page: Page): Promise<void> {
  // The welcome mounts after its `/api/shortcuts` probe resolves and marks
  // its storage flag in the same tick it opens. Wait for that signal (flag
  // set, or the dialog itself) instead of a first-paint visibility check; a
  // failed probe never sets either, and then there is no modal to dismiss.
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

/** Press the rail's New project and assert the Hub composer took the caret. */
export async function pressNewProject(page: Page, context = 'new-project'): Promise<void> {
  await dismissWelcomeModal(page);
  await ensureRailOpen(page);
  const trigger = page.getByTestId('hub-new-project');
  await expect(trigger, `[${context}] control must be visible on the real surface`).toBeVisible({ timeout: T.short });
  await trigger.click();
  await expect(page).toHaveURL(/\/$/, { timeout: T.medium });
  await expect(page.getByTestId('new-project-modal'), `[${context}] the New Project modal no longer exists`).toHaveCount(0);
  const composer = page.getByTestId('home-hero-input');
  await expect(composer).toBeVisible({ timeout: T.medium });
  await expect(composer, `[${context}] the Hub composer must own focus`).toBeFocused({ timeout: T.medium });
}

export interface CreateEmptyProjectOptions {
  /** Project kind; picks the matching Hub chip (the modal's tab). Default: free-form. */
  kind?: 'prototype' | 'deck' | 'other' | 'template';
  /** Display name. The Hub auto-names; specs that assert a name rename through the daemon. */
  name?: string;
  context?: string;
}

/**
 * Create an empty project the way the removed modal's Create button did:
 * land on the Hub composer, optionally pick the kind chip, then "Continue
 * without prompt" (no first message, no run) and wait for the workspace
 * route. Returns the project id.
 */
export async function createEmptyProjectFromHub(page: Page, options: CreateEmptyProjectOptions = {}): Promise<string> {
  const context = options.context ?? 'create-project';
  await pressNewProject(page, context);
  // The Hub keeps its kind chips and "continue without prompt" behind the
  // command palette (Ctrl K); both are the same command chips the composer
  // consumes from pointer input.
  if (options.kind === 'prototype' || options.kind === 'deck') {
    await runPaletteCreateCommand(page, options.kind, context);
    await expect(page.getByTestId('home-hero-active-type-chip')).toHaveAttribute('data-chip-id', options.kind, { timeout: T.medium });
  }
  await runPaletteCreateCommand(page, 'continue', context);
  await expect(page).toHaveURL(/\/projects\//, { timeout: T.long });
  const [, projects, projectId] = new URL(page.url()).pathname.split('/');
  if (projects !== 'projects' || !projectId) throw new Error(`[${context}] unexpected project route: ${page.url()}`);
  if (options.name) {
    // The modal's name field is gone (auto-naming + rail rename is the
    // contract), so specs that assert a name rename through the rail row.
    await ensureRailOpen(page);
    const row = page.getByTestId(`hub-project-${projectId}`);
    await expect(row).toBeVisible({ timeout: T.medium });
    await row.hover();
    await page.getByTestId(`hub-menu-project-${projectId}`).click();
    await page.getByTestId('hub-row-menu-rename').click();
    const field = page.getByTestId(`hub-rename-p-${projectId}`);
    await expect(field).toBeVisible({ timeout: T.short });
    await field.fill(options.name);
    await page.keyboard.press('Enter');
    await expect(row).toContainText(options.name, { timeout: T.medium });
  }
  return projectId;
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
