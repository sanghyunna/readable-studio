import { expect, test } from '@playwright/test';
import { ensureRailOpen } from '@/playwright/rail';
import { routeAgents } from '@/playwright/mock-factory';
import type { Page } from '@playwright/test';
import { openSettingsDialog } from '../lib/playwright/amr.js';

const STORAGE_KEY = 'readable-studio:config';
const OPEN_SETTINGS_LABEL = /Open settings|打开设置|開啟設定/i;

test.describe.configure({ timeout: 30_000 });

function baseConfig(): Record<string, unknown> {
  return {
    mode: 'daemon',
    apiKey: '',
    apiProtocol: 'openai',
    apiVersion: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    apiProviderBaseUrl: 'https://api.openai.com/v1',
    agentId: 'codex',
    skillId: null,
    designSystemId: null,
    onboardingCompleted: true,
    mediaProviders: {},
    agentModels: {},
    agentCliEnv: {},
  };
}

async function seedSettingsBase(page: Page) {
  await page.addInitScript(({ key, value }) => {
    window.localStorage.setItem(key, JSON.stringify(value));
  }, { key: STORAGE_KEY, value: baseConfig() });

  await page.route('**/api/health', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"ok":true}',
    });
  });

  await routeAgents(page, [
    {
      id: 'codex',
      name: 'Codex CLI',
      bin: 'codex',
      available: true,
      version: '0.130.0',
      models: [{ id: 'default', label: 'Default' }],
    },
  ]);
}

async function waitForLoadingToClear(page: Page) {
  await expect(page.locator('.readable-loading-shell')).toHaveCount(0, { timeout: 15_000 });
}

async function gotoEntryHome(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForLoadingToClear(page);
  const privacyDialog = page.getByRole('dialog').filter({ hasText: 'Help us improve Readable Studio' });
  if (await privacyDialog.isVisible()) {
    await privacyDialog.getByRole('button', { name: /I get it|not now|got it|don't share/i }).click();
  }
  await expect(page.getByRole('button', { name: OPEN_SETTINGS_LABEL })).toBeVisible();
}

async function openSettings(page: Page) {
  await gotoEntryHome(page);
  return openSettingsDialog(page);
}

async function openMemorySettings(page: Page) {
  const dialog = await openSettings(page);
  await dialog.getByRole('button', { name: /^Memory\b/ }).click();
  await expect(dialog.getByRole('button', { name: 'New memory' })).toBeVisible();
  return dialog;
}

test.describe('Settings Memory and Automations flows', () => {
  test('[P1] renders the new Memory information architecture with source tabs, saved stats, and tree summaries', async ({ page }) => {
    await seedSettingsBase(page);

    await page.route('**/api/memory', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          enabled: true,
          chatExtractionEnabled: true,
          rootDir: '/tmp/memory',
          index: '# Memory\n',
          entries: [
            {
              id: 'feedback_ui_density',
              name: 'Readable Studio plugin authoring flow',
              description: 'Keep plugin setup terse and reproducible.',
              type: 'feedback',
              updatedAt: Date.now(),
            },
            {
              id: 'project_launch_brief',
              name: 'Weekly launch brief',
              description: 'Current release framing and stakeholders.',
              type: 'project',
              updatedAt: Date.now(),
            },
          ],
          extraction: null,
        }),
      });
    });

    await page.route('**/api/memory/tree', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          tree: [
            {
              id: 'folder-feedback',
              parentId: null,
              path: '/FEEDBACK',
              name: 'Feedback',
              kind: 'folder',
              scope: 'global',
              sourcePacketIds: [],
              proposalIds: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              childrenCount: 1,
            },
            {
              id: 'feedback_ui_density',
              parentId: 'folder-feedback',
              path: '/FEEDBACK/readable-studio-plugin-authoring-flow',
              name: 'Readable Studio plugin authoring flow',
              description: 'Keep plugin setup terse and reproducible.',
              kind: 'entry',
              type: 'feedback',
              scope: 'global',
              sourcePacketIds: [],
              proposalIds: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            {
              id: 'folder-project',
              parentId: null,
              path: '/PROJECT',
              name: 'Project',
              kind: 'folder',
              scope: 'project',
              sourcePacketIds: [],
              proposalIds: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              childrenCount: 1,
            },
            {
              id: 'project_launch_brief',
              parentId: 'folder-project',
              path: '/PROJECT/weekly-launch-brief',
              name: 'Weekly launch brief',
              description: 'Current release framing and stakeholders.',
              kind: 'entry',
              type: 'project',
              scope: 'project',
              sourcePacketIds: [],
              proposalIds: [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        }),
      });
    });

    await page.route('**/api/memory/extractions', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          extractions: [
            {
              id: 'extract-1',
              createdAt: new Date().toISOString(),
              status: 'applied',
              mode: 'chat',
              source: 'conversation',
              summary: 'Recovered launch preferences from a recent chat.',
              provider: { kind: 'openai', credentialSource: 'api' },
              stats: { created: 1, updated: 0, skipped: 0 },
            },
            {
              id: 'extract-2',
              createdAt: new Date().toISOString(),
              status: 'applied',
              mode: 'manual',
              source: 'manual',
              summary: 'Imported product context from project files.',
              provider: { kind: 'openai', credentialSource: 'api' },
              stats: { created: 1, updated: 0, skipped: 0 },
            },
          ],
        }),
      });
    });

    await page.route('**/api/memory/events', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: '',
      });
    });

    const dialog = await openMemorySettings(page);

    await expect(dialog.getByRole('tab', { name: /Add manually/i })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByRole('tab', { name: /Learn from chats/i })).toBeVisible();

    await expect(dialog.getByText('Saved memory')).toBeVisible();
    await expect(dialog.getByText('2 saved')).toBeVisible();
    await expect(dialog.getByText('2 extractions')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'All 4' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Feedback 1' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Project 1' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Clear' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Refresh' })).toBeVisible();

    const memoryTree = dialog.locator('.memory-collapsible-card');
    await expect(memoryTree.getByText('Memory tree')).toBeVisible();
    await expect(memoryTree.getByText('Feedback', { exact: true })).toBeVisible();
    await expect(memoryTree.getByText('/FEEDBACK', { exact: true })).toBeVisible();
    await expect(memoryTree.getByText('Project', { exact: true })).toBeVisible();
    await expect(memoryTree.getByText('/PROJECT', { exact: true })).toBeVisible();
    await expect(memoryTree.getByText('Weekly launch brief')).toBeVisible();
  });

  test('[P1] creates a memory entry and keeps it visible after reopening settings', async ({ page }) => {
    await seedSettingsBase(page);

    let enabled = true;
    let index = '# Memory\n';
    let entries: Array<{
      id: string;
      name: string;
      description: string;
      type: string;
      updatedAt: number;
      body?: string;
    }> = [];

    await page.route('**/api/memory', async (route) => {
      const method = route.request().method();
      if (method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            enabled,
            rootDir: '/tmp/memory',
            index,
            entries: entries.map(({ body, ...summary }) => summary),
            extraction: null,
          }),
        });
        return;
      }
      if (method === 'POST') {
        const payload = route.request().postDataJSON() as Record<string, string>;
        const entry = {
          id: 'user_ui_preferences',
          name: payload.name ?? '',
          description: payload.description ?? '',
          type: payload.type ?? 'user',
          body: payload.body ?? '',
          updatedAt: Date.now(),
        };
        entries = [entry];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ entry }),
        });
        return;
      }
      await route.fulfill({ status: 404, body: '{}' });
    });

    await page.route('**/api/memory/extractions', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ extractions: [] }),
      });
    });

    await page.route('**/api/memory/events', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: '',
      });
    });

    await page.route('**/api/memory/config', async (route) => {
      const payload = route.request().postDataJSON() as { enabled?: boolean };
      if (typeof payload.enabled === 'boolean') enabled = payload.enabled;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ enabled, extraction: null }),
      });
    });

    const dialog = await openMemorySettings(page);

    await dialog.getByRole('button', { name: 'New memory' }).click();
    await dialog.getByPlaceholder('e.g. UI preferences').fill('UI preferences');
    await dialog.getByPlaceholder('One sentence — what is this memory about?').fill(
      'Persistent rendering preferences',
    );
    await dialog
      .getByPlaceholder(/- Rule one[\s\S]*When to apply: optional scope/)
      .fill('- Prefer dark mode');
    await dialog.getByRole('button', { name: 'Create' }).click();

    await expect(dialog.getByText('UI preferences')).toBeVisible();
    await expect(dialog.locator('.memory-flash-pill')).toContainText('Memory created');

    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const reopened = await openMemorySettings(page);
    await expect(reopened.getByText('UI preferences')).toBeVisible();
    await expect(reopened.getByText('Persistent rendering preferences')).toBeVisible();
  });

  test('[P1] disables memory injection and keeps the disabled banner after reopening settings', async ({ page }) => {
    await seedSettingsBase(page);

    let enabled = true;

    await page.route('**/api/memory', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          enabled,
          rootDir: '/tmp/memory',
          index: '# Memory\n',
          entries: [],
          extraction: null,
        }),
      });
    });

    await page.route('**/api/memory/extractions', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ extractions: [] }),
      });
    });

    await page.route('**/api/memory/events', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: '',
      });
    });

    await page.route('**/api/memory/config', async (route) => {
      const payload = route.request().postDataJSON() as { enabled?: boolean };
      if (typeof payload.enabled === 'boolean') enabled = payload.enabled;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ enabled, extraction: null }),
      });
    });

    const dialog = await openMemorySettings(page);
    await dialog.getByLabel('Enable memory injection').uncheck();
    await expect(dialog.locator('.memory-disabled-banner')).toBeVisible();

    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    const reopened = await openMemorySettings(page);
    await expect(reopened.locator('.memory-disabled-banner')).toBeVisible();
  });

  test('[P1] toggles Learn from chats and keeps the setting after reopening Memory', async ({ page }) => {
    await seedSettingsBase(page);

    let enabled = true;
    let chatExtractionEnabled = true;

    await page.route('**/api/memory', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          enabled,
          chatExtractionEnabled,
          rootDir: '/tmp/memory',
          index: '# Memory\n',
          entries: [],
          extraction: null,
        }),
      });
    });

    await page.route('**/api/memory/tree', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tree: [] }),
      });
    });

    await page.route('**/api/memory/extractions', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ extractions: [] }),
      });
    });

    await page.route('**/api/memory/events', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: '',
      });
    });

    await page.route('**/api/memory/config', async (route) => {
      const payload = route.request().postDataJSON() as {
        enabled?: boolean;
        chatExtractionEnabled?: boolean;
      };
      if (typeof payload.enabled === 'boolean') enabled = payload.enabled;
      if (typeof payload.chatExtractionEnabled === 'boolean') {
        chatExtractionEnabled = payload.chatExtractionEnabled;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ enabled, chatExtractionEnabled, extraction: null }),
      });
    });

    const dialog = await openMemorySettings(page);

    await dialog.getByRole('tab', { name: /Learn from chats/i }).click();
    const toggle = dialog.getByRole('checkbox', {
      name: 'Learn from chat conversations',
    });

    await expect(toggle).toBeChecked();
    await dialog.locator('.memory-chat-learning-toggle').click();
    await expect(toggle).not.toBeChecked();
    await expect(dialog.getByText('Off')).toBeVisible();

    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    const reopened = await openMemorySettings(page);
    await reopened.getByRole('tab', { name: /Learn from chats/i }).click();
    await expect(
      reopened.getByRole('checkbox', { name: 'Learn from chat conversations' }),
    ).not.toBeChecked();
  });


  test('[P1] refreshes and clears extraction history from Saved memory', async ({ page }) => {
    await seedSettingsBase(page);

    await page.addInitScript(() => {
      window.confirm = () => true;
    });

    let extractions = [
      {
        id: 'ex-1',
        phase: 'success',
        kind: 'llm',
        startedAt: Date.now(),
        finishedAt: Date.now() + 1200,
        userMessagePreview: 'Remember I prefer dark mode',
        proposedCount: 1,
        writtenCount: 1,
      },
    ];
    let extractionReads = 0;

    await page.route('**/api/memory', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          enabled: true,
          chatExtractionEnabled: true,
          rootDir: '/tmp/memory',
          index: '# Memory\n',
          entries: [],
          extraction: null,
        }),
      });
    });

    await page.route('**/api/memory/tree', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tree: [] }),
      });
    });

    await page.route('**/api/memory/extractions', async (route) => {
      const method = route.request().method();
      if (method === 'GET') {
        extractionReads += 1;
        const payload =
          extractionReads <= 2
            ? extractions
            : extractions.map((record, index) => ({
                ...record,
                userMessagePreview: index === 0 ? 'Remember I prefer dense dashboards' : record.userMessagePreview,
              }));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ extractions: payload }),
        });
        return;
      }
      if (method === 'DELETE') {
        extractions = [];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ removed: 1 }),
        });
        return;
      }
      await route.fulfill({ status: 404, body: '{}' });
    });

    await page.route('**/api/memory/events', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: '',
      });
    });

    const dialog = await openMemorySettings(page);
    await expect(dialog.getByText('Remember I prefer dark mode')).toBeVisible();

    await dialog.getByRole('button', { name: 'Refresh' }).click();
    await expect(dialog.getByText('Remember I prefer dense dashboards')).toBeVisible();

    await dialog.getByRole('button', { name: 'Clear' }).click();
    await expect(dialog.getByText('Remember I prefer dense dashboards')).toHaveCount(0);
  });

  test('[P1] keeps the memory editor open when creating a memory entry fails', async ({ page }) => {
    await seedSettingsBase(page);

    await page.route('**/api/memory', async (route) => {
      const method = route.request().method();
      if (method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            enabled: true,
            rootDir: '/tmp/memory',
            index: '# Memory\n',
            entries: [],
            extraction: null,
          }),
        });
        return;
      }
      if (method === 'POST') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'provider unavailable' }),
        });
        return;
      }
      await route.fulfill({ status: 404, body: '{}' });
    });

    await page.route('**/api/memory/extractions', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ extractions: [] }),
      });
    });

    await page.route('**/api/memory/events', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: '',
      });
    });

    const dialog = await openMemorySettings(page);

    await dialog.getByRole('button', { name: 'New memory' }).click();
    await dialog.getByPlaceholder('e.g. UI preferences').fill('UI preferences');
    await dialog.getByPlaceholder('One sentence — what is this memory about?').fill(
      'Persistent rendering preferences',
    );
    await dialog
      .getByPlaceholder(/- Rule one[\s\S]*When to apply: optional scope/)
      .fill('- Prefer dark mode');
    await dialog.getByRole('button', { name: 'Create' }).click();

    await expect(dialog.getByPlaceholder('e.g. UI preferences')).toHaveValue('UI preferences');
    await expect(dialog.locator('.memory-flash-pill')).toHaveCount(0);
    await expect(dialog.getByText('No memory yet.')).toBeVisible();
  });

  test('[P1] creates an automation from the main Automations surface and runs it now', async ({ page }) => {
    await seedSettingsBase(page);

    const projects = [{ id: 'proj-1', name: 'Routine Test Project' }];
    let routines: Array<Record<string, unknown>> = [];

    await page.route('**/api/projects', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ projects }),
      });
    });
    await page.route('**/api/routines', async (route) => {
      const method = route.request().method();
      if (method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ routines }),
        });
        return;
      }
      if (method === 'POST') {
        const payload = route.request().postDataJSON() as Record<string, unknown>;
        const routine = {
          id: 'routine-1',
          name: payload.name,
          prompt: payload.prompt,
          schedule: payload.schedule,
          target: payload.target,
          enabled: true,
          nextRunAt: Date.now() + 3600_000,
          lastRun: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        routines = [routine];
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ routine }),
        });
        return;
      }
      await route.fulfill({ status: 404, body: '{}' });
    });

    await page.route('**/api/plugins', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ plugins: [] }),
      });
    });

    await page.route('**/api/mcp/servers', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ servers: [], templates: [] }),
      });
    });

    await page.route('**/api/routines/routine-1/run', async (route) => {
      const startedAt = Date.now();
      const lastRun = {
        runId: 'run-1',
        status: 'queued',
        trigger: 'manual',
        startedAt,
        projectId: 'proj-run',
        conversationId: 'conv-run',
        agentRunId: 'agent-run-1',
      };
      routines = [{ ...routines[0], lastRun }];
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          routine: routines[0],
          run: lastRun,
        }),
      });
    });

    await gotoEntryHome(page);
    await ensureRailOpen(page);
    await page.getByTestId('entry-nav-tasks').click();
    const view = page.getByTestId('tasks-view');
    await expect(view.getByRole('heading', { name: 'Automations', exact: true })).toBeVisible();

    await view.getByRole('button', { name: 'New automation' }).click();
    const modal = page.getByTestId('automation-modal');
    await modal.getByLabel('Automation title').fill('Weekly digest');
    await modal.getByTestId('automation-modal-prompt').fill('Summarize GitHub and design activity.');
    await modal.getByRole('button', { name: 'Create' }).click();

    await expect(view.getByText('Weekly digest')).toBeVisible();

    const row = view.locator('.automation-row', { hasText: 'Weekly digest' }).first();
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Run' }).click();
    await expect(row.getByText(/Last run/i)).toBeVisible();
    await expect(row.getByRole('button', { name: 'Open result' })).toBeVisible();
  });

  test('[P1] keeps the automation modal open when creating an automation fails', async ({ page }) => {
    await seedSettingsBase(page);

    const projects = [{ id: 'proj-1', name: 'Routine Test Project' }];

    await page.route('**/api/projects', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ projects }),
      });
    });

    await page.route('**/api/routines', async (route) => {
      const method = route.request().method();
      if (method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ routines: [] }),
        });
        return;
      }
      if (method === 'POST') {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'provider unavailable' }),
        });
        return;
      }
      await route.fulfill({ status: 404, body: '{}' });
    });

    await page.route('**/api/plugins', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ plugins: [] }),
      });
    });

    await page.route('**/api/mcp/servers', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ servers: [], templates: [] }),
      });
    });

    await gotoEntryHome(page);
    await ensureRailOpen(page);
    await page.getByTestId('entry-nav-tasks').click();
    const view = page.getByTestId('tasks-view');

    await view.getByRole('button', { name: 'New automation' }).click();
    const modal = page.getByTestId('automation-modal');
    await modal.getByLabel('Automation title').fill('Weekly digest');
    await modal.getByTestId('automation-modal-prompt').fill('Summarize GitHub and design activity.');
    await modal.getByRole('button', { name: 'Create' }).click();

    await expect(modal.getByLabel('Automation title')).toHaveValue('Weekly digest');
    await expect(modal.getByTestId('automation-modal-prompt')).toHaveValue('Summarize GitHub and design activity.');
    await expect(modal.getByText('provider unavailable')).toBeVisible();
    await expect(view.getByText('No automations yet')).toBeVisible();
  });
});
