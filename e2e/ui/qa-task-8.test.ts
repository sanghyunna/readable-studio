// QA for todo 8 — artifact-type shortcuts, the more-shortcuts overflow, the
// direct "Start from template" starter, subcategory tabs with counts, and the
// Design/Chat session mode toggle.
//
// Every assertion drives the REAL home surface and, where the control causes
// state, proves it through the outgoing `/api/projects` payload rather than a
// DOM attribute. Each artifact-type tab is exercised against a freshly seeded
// project name so one tab's payload can never be mistaken for another's.
import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { routeAgents } from '@/playwright/mock-factory';

const STORAGE_KEY = 'readable-studio:config';
const EVIDENCE = (name: string) => `D:/readable-studio/.omo/evidence/task-8/${name}`;

const CONFIG = {
  mode: 'daemon',
  apiKey: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  agentId: 'codex',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  agentModels: { codex: { model: 'default', reasoning: 'default' } },
  privacyDecisionAt: 1,
  telemetry: { metrics: false, content: false, artifactManifest: false },
};

// Complete installed-plugin record shape. A partial record is dropped by
// `isVisiblePlugin` and would never reach the rail or the facet catalog.
function scenarioPlugin(options: {
  id: string;
  title: string;
  mode?: 'prototype' | 'deck';
  tags?: string[];
}) {
  return {
    id: options.id,
    title: options.title,
    version: '1.0.0',
    trust: 'bundled',
    marketplaceTrust: 'trusted',
    sourceKind: 'bundled',
    source: `/tmp/${options.id}`,
    fsPath: `/tmp/${options.id}`,
    capabilitiesGranted: ['prompt:inject'],
    installedAt: 0,
    updatedAt: 0,
    manifest: {
      name: options.id,
      title: options.title,
      version: '1.0.0',
      description: `QA scenario plugin ${options.title}`,
      ...(options.tags ? { tags: options.tags } : {}),
      readable: {
        kind: 'scenario',
        taskKind: 'new-generation',
        ...(options.mode ? { mode: options.mode } : {}),
        useCase: { query: `Produce a ${options.title} artifact.` },
        inputs: [],
      },
    },
  };
}

// The three artifact-type tabs bind to these bundled scenario ids
// (`home-hero/chips.ts`). Sub-category tags give Prototype and Deck a
// second-level rail with non-zero counts.
const PLUGINS = [
  scenarioPlugin({
    id: 'example-web-prototype',
    title: 'Web Prototype',
    mode: 'prototype',
    tags: ['dashboard'],
  }),
  scenarioPlugin({
    id: 'qa-landing-prototype',
    title: 'QA Landing',
    mode: 'prototype',
    tags: ['landing-page'],
  }),
  scenarioPlugin({
    id: 'example-simple-deck',
    title: 'Simple Deck',
    mode: 'deck',
    tags: ['pitch-deck'],
  }),
  scenarioPlugin({ id: 'example-report', title: 'Report' }),
  scenarioPlugin({ id: 'readable-plugin-authoring', title: 'Plugin Authoring' }),
  scenarioPlugin({ id: 'readable-figma-migration', title: 'Figma Migration' }),
];

function applyResponse(pluginId: string, inputs: Record<string, unknown>) {
  return {
    query: `Apply ${pluginId}.`,
    contextItems: [],
    inputs: [],
    assets: [],
    mcpServers: [],
    trust: 'trusted',
    capabilitiesGranted: ['prompt:inject'],
    capabilitiesRequired: ['prompt:inject'],
    appliedPlugin: {
      snapshotId: `snapshot-${pluginId}`,
      pluginId,
      pluginVersion: '1.0.0',
      manifestSourceDigest: 'c'.repeat(64),
      inputs,
      resolvedContext: { items: [] },
      capabilitiesGranted: ['prompt:inject'],
      capabilitiesRequired: ['prompt:inject'],
      assetsStaged: [],
      taskKind: 'new-generation',
      appliedAt: 0,
      mcpServers: [],
      status: 'fresh',
    },
    projectMetadata: {},
  };
}

function createdProject(body: Record<string, unknown>, suffix: string) {
  return {
    project: {
      id: `qa8-project-${suffix}`,
      name: body.name,
      skillId: body.skillId ?? null,
      designSystemId: body.designSystemId ?? null,
      metadata: body.metadata ?? { kind: 'other' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    conversationId: `qa8-conversation-${suffix}`,
    ...(body.appliedPluginSnapshotId
      ? { appliedPluginSnapshotId: body.appliedPluginSnapshotId }
      : {}),
  };
}

// Captures the POST /api/projects body so assertions read the real payload the
// hub sent, not a handler's arguments.
function captureProjectPayload(page: Page, suffix: string) {
  const captured: { body: Record<string, unknown> | null } = { body: null };
  const install = page.route('**/api/projects', async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = route.request().postDataJSON() as Record<string, unknown>;
    captured.body = body;
    await route.fulfill({ status: 200, json: createdProject(body, suffix) });
  });
  return { captured, install };
}

async function gotoHome(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.readable-loading-shell')).toHaveCount(0, { timeout: 20_000 });
  const privacy = page.getByRole('dialog').filter({ hasText: 'Help us improve Readable Studio' });
  if (await privacy.isVisible().catch(() => false)) {
    await privacy.getByRole('button', { name: /I get it|not now|got it|don't share/i }).click();
  }
  await expect(page.getByTestId('home-hero-input')).toBeVisible();
  await expect(page.getByTestId('home-hero-type-tabs')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ key, value }) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem(key, JSON.stringify(value));
  }, { key: STORAGE_KEY, value: CONFIG });

  await routeAgents(page, [{
    id: 'codex',
    name: 'Codex CLI',
    bin: 'codex',
    available: true,
    version: '1',
    path: 'codex',
    models: [{ id: 'default', label: 'Default' }],
  }]);
  await page.route('**/api/app-config', async (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { config: CONFIG } })
    : route.continue());
  await page.route('**/api/projects', async (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { projects: [] } })
    : route.fallback());
  await page.route('**/api/plugins', (route) => route.fulfill({ json: { plugins: PLUGINS } }));
  await page.route('**/api/plugins/*/apply', async (route) => {
    const pluginId = new URL(route.request().url()).pathname.split('/')[3] ?? '';
    const request = route.request().postDataJSON() as { inputs?: Record<string, unknown> };
    await route.fulfill({ json: applyResponse(pluginId, request.inputs ?? {}) });
  });
  await page.route('**/api/skills', (route) => route.fulfill({ json: { skills: [] } }));
  await page.route('**/api/mcp/servers', (route) => route.fulfill({ json: { servers: [], templates: [] } }));
  // The app reads `json.designSystems`; a `systems` key silently yields none.
  await page.route('**/api/design-systems', (route) => route.fulfill({ json: { designSystems: [] } }));
  await page.route('**/api/prompt-templates', (route) => route.fulfill({ json: { promptTemplates: [] } }));
});

// (a) Each artifact-type tab is present on home AND stamps its own
// `projectKind` on the created project. Report shares the `prototype` kind by
// contract (`projectKind` is only prototype|deck|template|other) and is told
// apart by its `intent`, exactly as `home-hero/chips.ts` declares.
const TYPE_TABS = [
  {
    chip: 'prototype',
    suffix: 'prototype',
    prompt: 'QA prototype tab seed',
    pluginId: 'example-web-prototype',
    pluginTitle: 'Web Prototype',
    metadata: { kind: 'prototype' },
  },
  {
    chip: 'deck',
    suffix: 'deck',
    prompt: 'QA deck tab seed',
    pluginId: 'example-simple-deck',
    pluginTitle: 'Simple Deck',
    metadata: { kind: 'deck' },
  },
  {
    chip: 'report',
    suffix: 'report',
    prompt: 'QA report tab seed',
    pluginId: 'example-report',
    pluginTitle: 'Report',
    metadata: { kind: 'prototype', intent: 'report' },
  },
] as const;

for (const tab of TYPE_TABS) {
  test(`artifact type tab "${tab.chip}" is on home and sets its projectKind in the project payload`, async ({ page }) => {
    const { captured, install } = captureProjectPayload(page, tab.suffix);
    await install;

    await gotoHome(page);
    const tabs = page.getByTestId('home-hero-type-tabs');
    for (const id of ['prototype', 'deck', 'report']) {
      await expect(tabs.getByTestId(`home-hero-rail-${id}`)).toBeVisible();
    }

    if (tab.chip === 'prototype') {
      await page.getByTestId('home-hero-type-tabs').screenshot({ path: EVIDENCE('type-tabs.png') });
    }
    await page.getByTestId(`home-hero-rail-${tab.chip}`).click();
    // The picked tab becomes the active type chip; that is the machine-visible
    // signal that the chip's scenario is bound and ready to submit.
    await expect(page.getByTestId('home-hero-active-type-chip')).toHaveAttribute(
      'data-chip-id',
      tab.chip,
    );

    await page.getByTestId('home-hero-input').fill(tab.prompt);
    await expect(page.getByTestId('home-hero-submit')).toBeEnabled();
    await page.getByTestId('home-hero-submit').click();
    await expect.poll(() => captured.body).not.toBeNull();

    // `pendingPrompt` carries the freshly seeded text, so each tab's payload is
    // unambiguously its own; `name` comes from the bound scenario's title.
    expect(captured.body).toMatchObject({
      name: tab.pluginTitle,
      pluginId: tab.pluginId,
      pendingPrompt: tab.prompt,
      appliedPluginSnapshotId: `snapshot-${tab.pluginId}`,
      metadata: tab.metadata,
    });
  });
}

// (b) The overflow menu carries the three migrate-group shortcuts.
test('the more-shortcuts overflow exposes Create plugin, From Figma and From template', async ({ page }) => {
  await gotoHome(page);

  const trigger = page.getByTestId('home-hero-shortcuts-trigger');
  await expect(trigger).toBeVisible();
  await expect(page.getByTestId('home-hero-shortcuts-menu')).toHaveCount(0);

  await trigger.click();
  const menu = page.getByTestId('home-hero-shortcuts-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId('home-hero-rail-create-plugin')).toContainText('Create plugin');
  await expect(menu.getByTestId('home-hero-rail-figma')).toContainText('From Figma');
  await expect(menu.getByTestId('home-hero-rail-template')).toContainText('From template');
  await menu.screenshot({ path: EVIDENCE('more-shortcuts-menu.png') });

  // The template shortcut opens the New Project modal on its template tab.
  await menu.getByTestId('home-hero-rail-template').click();
  await expect(page.getByTestId('new-project-tab-template')).toHaveAttribute('aria-selected', 'true');
});

// (b2) Defect #71 — the direct starter button, a separate element from the
// overflow shortcut above.
test('a third "Start from template" starter sits beside the import starters and opens the template tab', async ({ page }) => {
  await gotoHome(page);

  const starters = page.locator('.hub__starters');
  const templateStarter = page.getByTestId('hub-start-from-template');
  await expect(templateStarter).toBeVisible();
  await expect(templateStarter).toContainText('Start from template');

  // It is a starter, not the composer's overflow item: it lives in the starter
  // row next to Import folder, and the overflow menu is closed.
  await expect(starters.getByRole('button')).toContainText(['Import folder', 'Start from template']);
  await expect(page.getByTestId('home-hero-shortcuts-menu')).toHaveCount(0);
  await starters.screenshot({ path: EVIDENCE('starters.png') });

  await templateStarter.click();
  await expect(page.getByTestId('new-project-tab-template')).toHaveAttribute('aria-selected', 'true');
});

// (c) Subcategory tabs with counts under Prototype and Deck.
test('subcategory tabs render with counts under Prototype and Deck', async ({ page }) => {
  await gotoHome(page);

  await page.getByTestId('home-hero-rail-prototype').click();
  const row = page.getByTestId('home-hero-subtype-row');
  await expect(row).toBeVisible();
  await expect(row.getByTestId('home-hero-subtype-business-dashboards')).toBeVisible();
  await expect(row.getByTestId('home-hero-subtype-count-business-dashboards')).toHaveText('1');
  await expect(row.getByTestId('home-hero-subtype-landing-marketing')).toBeVisible();
  await expect(row.getByTestId('home-hero-subtype-count-landing-marketing')).toHaveText('1');

  // Switching type replaces the rail with the deck taxonomy and its counts.
  await page.getByTestId('home-hero-active-type-chip').click();
  await expect(page.getByTestId('home-hero-rail-deck')).toBeVisible();
  await page.getByTestId('home-hero-rail-deck').click();
  await expect(row.getByTestId('home-hero-subtype-pitch-business')).toBeVisible();
  await expect(row.getByTestId('home-hero-subtype-count-pitch-business')).toHaveText('1');
  await expect(row.getByTestId('home-hero-subtype-business-dashboards')).toHaveCount(0);
  await row.screenshot({ path: EVIDENCE('subtype-tabs-deck.png') });
});

// (d) The Design/Chat toggle reaches the payload as `conversationMode`.
test('the session mode toggle sets conversationMode in the project payload', async ({ page }) => {
  const { captured, install } = captureProjectPayload(page, 'mode');
  await install;

  await gotoHome(page);
  const trigger = page.getByTestId('session-mode-trigger');
  await expect(trigger).toBeVisible();
  await trigger.click();
  await page.getByRole('menuitemradio', { name: /Ask mode/i }).click();

  await page.getByTestId('home-hero-input').fill('QA mode toggle seed');
  await page.getByTestId('home-hero-submit').click();
  await expect.poll(() => captured.body).not.toBeNull();

  expect(captured.body).toMatchObject({
    pendingPrompt: 'QA mode toggle seed',
    conversationMode: 'chat',
  });
});

// Failure probe: with NO plugins installed the type tabs must still work and
// the subcategory rail must simply not render, rather than throwing.
test('with plugins stubbed empty the subcategory tabs degrade instead of throwing', async ({ page }) => {
  await page.route('**/api/plugins', (route) => route.fulfill({ json: { plugins: [] } }));
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await gotoHome(page);
  await expect(page.getByTestId('home-hero-rail-prototype')).toBeVisible();
  await page.getByTestId('home-hero-rail-prototype').click();

  // No installed plugins => no facet counts => no second-level rail, and the
  // composer stays operable.
  await expect(page.getByTestId('home-hero-subtype-row')).toHaveCount(0);
  await page.getByTestId('home-hero-input').fill('QA empty plugin catalog');
  await expect(page.getByTestId('home-hero-submit')).toBeEnabled();
  expect(pageErrors).toEqual([]);
});
