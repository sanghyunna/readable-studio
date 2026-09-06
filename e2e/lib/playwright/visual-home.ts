import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export const VISUAL_CLI_AGENTS = [
  {
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    available: true,
    version: '2.1.31',
    models: [
      { id: 'default', label: 'Default (CLI config)' },
      { id: 'sonnet-alias', label: 'Sonnet (alias)' },
      { id: 'opus-alias', label: 'Opus (alias)' },
      { id: 'haiku-alias', label: 'Haiku (alias)' },
      { id: 'sonnet-nightly', label: 'Sonnet Nightly' },
      { id: 'opus-nightly', label: 'Opus Nightly' },
      { id: 'sonnet-4.5', label: 'Sonnet 4.5' },
      { id: 'opus-4.5', label: 'Opus 4.5' },
    ],
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    bin: 'codex',
    available: true,
    version: '0.134.0',
    models: [
      { id: 'default', label: 'Default (CLI config)' },
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' },
      { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3-Codex-Spark' },
      { id: 'gpt-5.3', label: 'GPT-5.3' },
      { id: 'gpt-5.2', label: 'GPT-5.2' },
    ],
  },
] as const;

export async function openVisualAvatarMenu(page: Page) {
  // The workspace execution control is the split InlineModelSwitcher in the
  // composer. AvatarMenu is deliberately suppressed whenever that live pair is
  // present, so visual coverage must operate the mounted agent control rather
  // than wait for the obsolete fallback.
  await page.getByTestId('inline-model-switcher-agent-trigger').click();
  const menu = page.getByTestId('inline-model-switcher-agent-popover');
  await expect(menu).toBeVisible();
  return menu;
}

export async function openVisualSettingsDetails(page: Page) {
  await page.getByTestId('hub-footer-settings').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function gotoVisualDestination(
  page: Page,
  destination: 'projects' | 'tasks' | 'design-systems' | 'plugins' | 'integrations',
) {
  await page.getByTestId('hub-library').click();
  await page.getByTestId(`hub-library-${destination}`).click();
  const route = destination === 'tasks' ? 'automations' : destination;
  await expect(page).toHaveURL(new RegExp(`/${route}$`));
}

export async function gotoVisualPlugins(page: Page) {
  await gotoVisualDestination(page, 'plugins');
  const plugins = page.getByTestId('entry-view-plugins');
  await expect(plugins).toBeVisible();
  await expect(plugins.getByTestId('plugins-home-section')).toBeVisible();
  return plugins;
}

export async function gotoVisualWorkspace(page: Page) {
  await page.goto('/projects/visual-project-launchpad', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/projects\/visual-project-launchpad$/);
  await expect(page.getByTestId('chat-composer')).toBeVisible();
}
