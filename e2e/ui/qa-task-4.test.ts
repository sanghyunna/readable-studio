import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  dismissPrivacyDialog,
  putAppConfig,
  readAppConfig,
  seedBrowserConfig,
  openSettingsDialog,
  waitForLoadingToClear,
} from '@/playwright/amr';
import { fulfillAgentsRoute } from '@/playwright/mock-factory';

// Todo 4 — the welcome/onboarding screen is removed. These specs prove the
// removal from the OUTSIDE: no onboarding surface can be reached by route or
// by first-run state, the hub renders in its place, and every config field the
// onboarding flow used to write stays editable in Settings.

const WORKTREE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVIDENCE_DIR =
  process.env.READABLE_QA_EVIDENCE_DIR ?? join(WORKTREE_ROOT, '.omo', 'evidence', 'task-4');

if (process.env.READABLE_E2E_NAMESPACE == null) {
  throw new Error('qa-task-4 requires a disposable READABLE_E2E_NAMESPACE');
}

// Every selector the removed surface used to render. If any of these ever
// matches again, the welcome screen is back.
const ONBOARDING_SELECTORS = [
  '.onboarding-view',
  '.entry-onboarding-modal',
  '.entry-shell--onboarding',
  '.onboarding-view__card',
] as const;

const QA_AGENTS = [
  {
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    available: true,
    version: '2.1.31',
    models: [
      { id: 'default', label: 'Default (CLI config)' },
      { id: 'sonnet-4.5', label: 'Sonnet 4.5' },
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
    ],
  },
] as const;

async function stubAgents(page: Page) {
  await page.route('**/api/agents**', (route) => fulfillAgentsRoute(route, QA_AGENTS));
}

async function expectNoOnboardingSurface(page: Page) {
  for (const selector of ONBOARDING_SELECTORS) {
    await expect(page.locator(selector), `onboarding selector must not render: ${selector}`)
      .toHaveCount(0);
  }
  // The removed screen was titled from `settings.welcomeTitle` and owned the
  // only "Skip"/"Finish setup" actions on the entry surface.
  await expect(page.getByRole('button', { name: /Finish setup|Skip for now/i })).toHaveCount(0);
}

// Positive proof the HUB actually rendered — never merely "no error was thrown".
async function expectHubRendered(page: Page) {
  await expect(page.getByTestId('hub-nav')).toBeVisible();
  await expect(page.getByTestId('hub-composer')).toBeVisible();
}

async function setOnboardingCompleted(page: Page, value: boolean) {
  const current = await readAppConfig(page);
  const config = { ...(current.config ?? {}), onboardingCompleted: value };
  await putAppConfig(page, config);
}

test('[P0] @critical /onboarding no longer renders an onboarding screen', async ({ page }) => {
  await stubAgents(page);
  await setOnboardingCompleted(page, true);
  await page.goto('/onboarding', { waitUntil: 'domcontentloaded' });
  await waitForLoadingToClear(page);
  await dismissPrivacyDialog(page);

  await expectNoOnboardingSurface(page);
  await expectHubRendered(page);
});

test('[P0] @critical a first run with onboardingCompleted:false lands on the hub, not the welcome screen', async ({
  page,
}) => {
  await stubAgents(page);

  // Console/page errors are collected so "the hub rendered" cannot be faked by
  // a silently broken bundle.
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  // `page.request` shares the context's baseURL, so the daemon config can be
  // flipped before the app ever loads — one page load total keeps this test
  // inside its budget on a cold dev server.
  await setOnboardingCompleted(page, false);

  // The browser merges daemon config over its local copy; seed the local
  // copy false too so the first-run state is unambiguous. Init scripts only
  // apply to later navigations, so this must precede the first goto.
  await seedBrowserConfig(page, {
    mode: 'daemon',
    apiKey: '',
    baseUrl: '',
    model: '',
    agentId: null,
    skillId: null,
    designSystemId: null,
    onboardingCompleted: false,
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForLoadingToClear(page);
  await dismissPrivacyDialog(page);

  // The forced first-run redirect is gone: the URL must stay on the hub.
  await expect(page).toHaveURL(/\/$/);
  await expectNoOnboardingSurface(page);
  await expectHubRendered(page);

  // Operable, not merely present. Scope to the canonical rich composer and
  // require its real contenteditable so a legacy textarea cannot satisfy this.
  const editor = page.getByTestId('hub-composer').locator('[contenteditable="true"]');
  await expect(editor).toBeVisible();
  await editor.fill('todo-4 first run reaches the hub');
  await expect(editor).toHaveText('todo-4 first run reaches the hub');

  // The daemon still reports the first-run flag, so the hub is what a real
  // fresh install sees — not a post-onboarding state.
  const after = await readAppConfig(page);
  expect(after.config?.onboardingCompleted).toBe(false);

  expect(pageErrors, 'no uncaught page errors while rendering the hub').toEqual([]);

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: join(EVIDENCE_DIR, 'first-run.png'), fullPage: false });
});

test('[P0] stale persisted state cannot resurrect the welcome screen', async ({ page }) => {
  await stubAgents(page);
  await setOnboardingCompleted(page, false);

  // A workspace tab persisted by an older build, parked on the removed
  // 'onboarding' view, plus a first-run daemon flag.
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'readable-studio:workspace-tabs:v1',
      JSON.stringify({
        tabs: [
          {
            id: 'entry:onboarding:legacy',
            kind: 'entry',
            view: 'onboarding',
            createdAt: 1,
            lastActiveAt: 2,
          },
        ],
        activeTabId: 'entry:onboarding:legacy',
      }),
    );
  });

  await page.goto('/onboarding', { waitUntil: 'domcontentloaded' });
  await waitForLoadingToClear(page);
  await dismissPrivacyDialog(page);

  await expectNoOnboardingSurface(page);
  await expectHubRendered(page);
  // The stale tab must not come back as a "Welcome" tab either.
  await expect(page.getByRole('tab', { name: /Welcome/i })).toHaveCount(0);
});

test('[P0] every config field the onboarding flow wrote stays editable in Settings', async ({
  page,
}) => {
  await stubAgents(page);
  await setOnboardingCompleted(page, true);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const dialog = await openSettingsDialog(page);

  // 1. `mode` — execution mode (the onboarding runtime cards called onModeChange).
  const executionTabs = dialog.getByRole('tablist', { name: 'Execution mode' });
  await expect(executionTabs).toBeVisible();
  const localCliTab = executionTabs.getByRole('tab', { name: /Local CLI/i });
  const byokTab = executionTabs.getByRole('tab', { name: 'BYOK' });
  await expect(localCliTab).toBeVisible();
  await expect(byokTab).toBeVisible();

  // 2. `agentId` and 3. `agentModels` — the Local CLI panel.
  await localCliTab.click();
  await expect(dialog.getByTestId('settings-agent-select-claude')).toBeVisible();
  await dialog.getByTestId('settings-agent-select-claude').click();
  await expect(
    dialog.locator('.agent-card.active [role="combobox"]').first(),
    'per-agent model picker (config.agentModels) must be editable',
  ).toBeVisible();

  // 4. `apiProtocol`, 5. `apiKey`, 6. `baseUrl`, 7. `model`,
  // 8. `apiProviderBaseUrl` (provider quick-fill) — the BYOK panel.
  await byokTab.click();
  await expect(dialog.getByRole('tablist', { name: 'API protocol' })).toBeVisible();
  await expect(dialog.getByLabel('API key')).toBeVisible();
  await expect(dialog.getByLabel('Base URL')).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Model', exact: true })).toBeVisible();
  await expect(dialog.getByLabel(/Gateway preset|Quick fill provider/i)).toBeVisible();

  // 9. `apiVersion` — Azure-only field, reachable through the protocol tabs.
  // 10. `apiProtocolConfigs` — the per-protocol store written whenever any of
  // the fields above change; switching protocol tabs is its only UI surface.
  await dialog.getByRole('tablist', { name: 'API protocol' })
    .getByRole('tab', { name: /Azure/i })
    .click();
  await expect(dialog.getByLabel(/API version/i)).toBeVisible();
});
