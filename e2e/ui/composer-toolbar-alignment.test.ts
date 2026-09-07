// Composer footer toolbar alignment.
//
// The composer bottom row's execution cluster is agent icon, model name, then
// Send. These controls are authored in different components and the composer
// mounts under `.chat-composer-fixed-layer` (once a body-level portal, now
// laid out in the pane slot under the same class), so the
// `.app`-scoped "one control system" normalization in chat.css once failed to
// reach it. The resulting 28/30/32px controls looked visibly misaligned even
// though the row centered them.
//
// This spec is the regression boundary: the three execution controls must
// share one height and one vertical center so the cluster reads as a single
// row.

import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const STORAGE_KEY = 'readable-studio:config';

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => {
    window.localStorage.setItem(
      key,
      JSON.stringify({
        mode: 'daemon',
        apiKey: '',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-5',
        agentId: 'mock',
        skillId: null,
        designSystemId: null,
        onboardingCompleted: true,
        agentModels: {},
      }),
    );
  }, STORAGE_KEY);

  await page.route('**/api/app-config', async (route) => {
    await route.fulfill({
      json: {
        config: {
          onboardingCompleted: true,
          agentId: 'mock',
          skillId: null,
          designSystemId: null,
          agentModels: {},
          agentCliEnv: {},
        },
      },
    });
  });

  await page.route('**/api/agents', async (route) => {
    await route.fulfill({
      json: {
        agents: [
          {
            id: 'mock',
            name: 'Mock Agent',
            bin: 'mock-agent',
            available: true,
            version: 'test',
            models: [{ id: 'default', label: 'Default' }],
          },
        ],
      },
    });
  });
});

test('[P1] composer footer controls share one height and baseline', async ({ page }) => {
  await page.goto('/');
  await createProject(page, 'Composer toolbar alignment');
  await expect(page).toHaveURL(/\/projects\//);
  await expect(page.getByTestId('chat-composer')).toBeVisible();
  await expect(page.getByTestId('chat-send')).toBeVisible();

  const metrics = await page.evaluate(() => {
    const row = document.querySelector('.composer-row');
    if (!row) return { error: 'no .composer-row' as const };
    const selectors = [
      '[data-testid="inline-model-switcher-agent-trigger"]',
      '[data-testid="inline-model-switcher-model-trigger"]',
      '[data-testid="chat-send"]',
    ];
    for (const sel of selectors) {
      if (!row.querySelector(sel)) return { error: `missing intended footer control: ${sel}` as const };
    }
    const controls = Array.from(row.querySelectorAll<HTMLElement>(selectors.join(','))).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        sel: `[data-testid="${el.dataset.testid ?? ''}"]`,
        height: r.height,
        center: r.top + r.height / 2,
      };
    });
    return { controls };
  });

  if ('error' in metrics) throw new Error(metrics.error);
  const { controls } = metrics;

  // Pin the shipped execution cluster, rather than a bare minimum count that
  // can pass when obsolete controls happen to remain in the row.
  expect(controls.map((control) => control.sel)).toEqual([
    '[data-testid="inline-model-switcher-agent-trigger"]',
    '[data-testid="inline-model-switcher-model-trigger"]',
    '[data-testid="chat-send"]',
  ]);

  const heights = controls.map((c) => c.height);
  const centers = controls.map((c) => c.center);
  const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);

  // One control system: identical heights. Any 28/30/32px drift fails here.
  expect(spread(heights), `control heights: ${JSON.stringify(controls)}`).toBeLessThanOrEqual(1);
  // ...and a shared vertical center so nothing rides high or low in the row.
  expect(spread(centers), `control centers: ${JSON.stringify(controls)}`).toBeLessThanOrEqual(1);
});

async function createProject(page: Page, projectName: string): Promise<void> {
  const response = await page.request.post('/api/projects', {
    data: {
      id: randomUUID(),
      name: projectName,
      skillId: null,
      designSystemId: null,
      metadata: { kind: 'prototype', nameSource: 'user' },
    },
  });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as {
    project: { id: string };
    conversationId: string;
  };
  await page.goto(`/projects/${body.project.id}/conversations/${body.conversationId}`);
}
