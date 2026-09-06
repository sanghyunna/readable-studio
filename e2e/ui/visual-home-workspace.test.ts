import { expect, test } from '@playwright/test';
import {
  captureVisual,
  configureVisualPage,
  gotoVisualHome,
  waitForVisualFonts,
} from '@/playwright/visual';
import {
  gotoVisualWorkspace,
  openVisualAvatarMenu,
  openVisualSettingsDetails,
  VISUAL_CLI_AGENTS,
} from '@/playwright/visual-home';

test('[P2] captures the project workspace surface', async ({ page }) => {
  await configureVisualPage(page);
  await gotoVisualHome(page);
  await gotoVisualWorkspace(page);

  await expect(page.getByTestId('chat-composer-input')).toBeVisible();
  await expect(page.getByTestId('file-workspace')).toBeVisible();
  await waitForVisualFonts(page);

  await captureVisual(page, 'visual-project-workspace');
});

test('[P2] captures the workspace staged contexts surface', async ({ page }) => {
  await configureVisualPage(page);
  await gotoVisualHome(page);
  await gotoVisualWorkspace(page);

  await page.getByTestId('design-files-tab').click();
  await expect(page.getByTestId('design-files-tab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('staged-contexts')).toBeVisible();
  await expect(page.getByTestId('staged-contexts')).not.toBeEmpty();
  await waitForVisualFonts(page);

  await captureVisual(page, 'visual-workspace-staged-contexts');
});

test('[P2] captures the topbar execution switcher surface', async ({ page }) => {
  await configureVisualPage(page);
  await gotoVisualHome(page);

  await page.getByTestId('inline-model-switcher-agent-trigger').click();
  await expect(page.getByTestId('inline-model-switcher-agent-popover')).toBeVisible();
  await expect(page.getByTestId('inline-model-switcher-mode-daemon')).toBeVisible();

  await captureVisual(page, 'visual-topbar-execution-switcher');
});

test('[P2] captures the topbar local CLI model dropdown surface', async ({ page }) => {
  await configureVisualPage(page, {
    agents: VISUAL_CLI_AGENTS,
    config: {
      agentId: 'claude',
      agentModels: { claude: { model: 'default', reasoning: 'default' } },
    },
  });
  await gotoVisualHome(page);

  await page.getByTestId('inline-model-switcher-model-trigger').click();
  await expect(page.getByTestId('inline-model-switcher-model-popover')).toBeVisible();
  await expect(page.getByTestId('inline-model-switcher-model-list')).toBeVisible();
  await expect(page.getByTestId('inline-model-switcher-model-option-sonnet-alias')).toBeVisible();

  await captureVisual(page, 'visual-topbar-local-cli-model-dropdown');
});

test('[P2] captures the topbar BYOK execution switcher surface', async ({ page }) => {
  await configureVisualPage(page, {
    config: {
      mode: 'api',
      apiKey: 'sk-visual',
      apiProtocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      agentId: null,
    },
  });
  await gotoVisualHome(page);

  await page.getByTestId('inline-model-switcher-agent-trigger').click();
  await expect(page.getByTestId('inline-model-switcher-agent-popover')).toBeVisible();
  await expect(page.getByTestId('inline-model-switcher-mode-api')).toHaveAttribute('aria-selected', 'true');

  await captureVisual(page, 'visual-topbar-byok-switcher');
});

test('[P2] captures the topbar BYOK model dropdown surface', async ({ page }) => {
  await configureVisualPage(page, {
    config: {
      mode: 'api',
      apiKey: 'sk-visual',
      apiProtocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      agentId: null,
    },
  });
  await gotoVisualHome(page);

  await page.getByTestId('inline-model-switcher-model-trigger').click();
  await expect(page.getByTestId('inline-model-switcher-model-popover')).toBeVisible();
  await page.getByTestId('inline-model-switcher-api-model').click();
  await expect(page.getByTestId('inline-model-switcher-api-model-popover')).toBeVisible();

  await captureVisual(page, 'visual-topbar-byok-model-dropdown');
});

test('[P2] captures the avatar menu surface', async ({ page }) => {
  await configureVisualPage(page);
  await gotoVisualHome(page);
  await gotoVisualWorkspace(page);

  const menu = await openVisualAvatarMenu(page);
  // Settings moved out of this surface; assert the live agent choice instead.
  await expect(menu.locator('.inline-switcher__agent').first()).toBeVisible();

  await captureVisual(page, 'visual-avatar-menu');
});

test('[P2] captures the avatar local agent list surface', async ({ page }) => {
  await configureVisualPage(page, {
    agents: VISUAL_CLI_AGENTS,
    config: {
      agentId: 'codex',
      agentModels: { codex: { model: 'default', reasoning: 'default' } },
    },
  });
  await gotoVisualHome(page);
  await gotoVisualWorkspace(page);

  const menu = await openVisualAvatarMenu(page);
  await expect(menu.getByTestId('inline-model-switcher-agent-claude')).toBeVisible();
  await expect(menu.getByTestId('inline-model-switcher-agent-codex')).toBeVisible();

  await captureVisual(page, 'visual-avatar-local-agent-list');
});

test('[P2] captures the avatar local agent model dropdown surface', async ({ page }) => {
  await configureVisualPage(page, {
    agents: VISUAL_CLI_AGENTS,
    config: {
      agentId: 'claude',
      agentModels: { claude: { model: 'default', reasoning: 'default' } },
    },
  });
  await gotoVisualHome(page);
  await gotoVisualWorkspace(page);

  await page.getByTestId('inline-model-switcher-model-trigger').click();
  await expect(page.getByTestId('inline-model-switcher-model-popover')).toBeVisible();
  await expect(page.getByTestId('inline-model-switcher-model-list')).toBeVisible();
  await expect(page.getByTestId('inline-model-switcher-model-option-sonnet-alias')).toBeVisible();

  await captureVisual(page, 'visual-project-avatar-model-dropdown');
});

test('[P2] captures the settings execution surface', async ({ page }) => {
  await configureVisualPage(page);
  await gotoVisualHome(page);

  const dialog = await openVisualSettingsDetails(page);
  await expect(dialog.getByRole('tab', { name: /Local CLI/i })).toBeVisible();
  await expect(dialog.getByRole('tablist', { name: 'Execution mode' })).toBeVisible();
  await waitForVisualFonts(page);

  await captureVisual(page, 'visual-settings-execution');
});

test('[P2] captures the settings local CLI surface', async ({ page }) => {
  await configureVisualPage(page, {
    agents: VISUAL_CLI_AGENTS,
    config: {
      agentId: 'codex',
      agentModels: { codex: { model: 'default', reasoning: 'default' } },
    },
  });
  await gotoVisualHome(page);

  const dialog = await openVisualSettingsDetails(page);
  await dialog.getByRole('tab', { name: /Local CLI/i }).click();
  await expect(dialog.getByTestId('settings-agent-select-codex')).toBeVisible();
  await waitForVisualFonts(page);

  await captureVisual(page, 'visual-settings-local-cli');
});

test('[P2] captures the settings local CLI model dropdown surface', async ({ page }) => {
  await configureVisualPage(page, {
    agents: VISUAL_CLI_AGENTS,
    config: {
      agentId: 'codex',
      agentModels: { codex: { model: 'default', reasoning: 'default' } },
    },
  });
  await gotoVisualHome(page);

  const dialog = await openVisualSettingsDetails(page);
  await dialog.getByRole('tab', { name: /Local CLI/i }).click();
  await dialog.getByTestId('settings-agent-select-codex').click();
  const modelSelect = dialog.locator('.agent-card.active [role="combobox"]').first();
  await expect(modelSelect).toBeVisible();
  await modelSelect.click();
  await expect(page.getByTestId('settings-agent-model-popover-codex')).toBeVisible();
  await expect(page.getByTestId('settings-agent-model-search-codex')).toBeVisible();
  await waitForVisualFonts(page);

  await captureVisual(page, 'visual-settings-local-cli-model-dropdown');
});

test('[P2] captures the settings BYOK surface', async ({ page }) => {
  await configureVisualPage(page);
  await gotoVisualHome(page);

  const dialog = await openVisualSettingsDetails(page);
  await dialog.getByRole('tab', { name: 'BYOK' }).click();
  await expect(dialog.getByRole('tablist', { name: 'API protocol' })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Anthropic API' })).toBeVisible();
  await waitForVisualFonts(page);

  await captureVisual(page, 'visual-settings-byok');
});

test('[P2] captures the settings BYOK OpenAI surface', async ({ page }) => {
  await configureVisualPage(page, {
    config: {
      mode: 'api',
      apiKey: 'sk-visual',
      apiProtocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      agentId: null,
    },
  });
  await gotoVisualHome(page);

  const dialog = await openVisualSettingsDetails(page);
  await dialog.getByRole('tab', { name: 'BYOK' }).click();
  await dialog.getByRole('tab', { name: 'OpenAI', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'OpenAI API' })).toBeVisible();
  await waitForVisualFonts(page);

  await captureVisual(page, 'visual-settings-byok-openai');
});

test('[P2] captures the settings BYOK model dropdown surface', async ({ page }) => {
  await configureVisualPage(page, {
    config: {
      mode: 'api',
      apiKey: 'sk-visual',
      apiProtocol: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      agentId: null,
    },
  });
  await gotoVisualHome(page);

  const dialog = await openVisualSettingsDetails(page);
  await dialog.getByRole('tab', { name: 'BYOK' }).click();
  await dialog.getByRole('tab', { name: 'OpenAI', exact: true }).click();
  const modelSelect = dialog.getByRole('combobox', { name: 'Model', exact: true });
  await expect(modelSelect).toBeVisible();
  await modelSelect.click();
  await expect(page.getByTestId('settings-byok-model-popover')).toBeVisible();
  await waitForVisualFonts(page);

  await captureVisual(page, 'visual-settings-byok-model-dropdown');
});
