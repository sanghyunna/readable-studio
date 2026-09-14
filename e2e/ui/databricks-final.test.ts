// Live, opt-in integration gate: requires a fresh isolated tools-dev runtime and
// an authenticated local Databricks CLI profile. No mocks or inference calls.
import { expect, test, type Locator, type Page } from '@playwright/test';
import type {
  AgentInfo,
  DatabricksModelResponse,
  DatabricksModelsResponse,
  DatabricksProfilesResponse,
  DatabricksScanResponse,
  DatabricksStatusResponse,
} from '@readable-studio/contracts';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { addStorageInitScript } from '@/playwright/storage-init';
import { enterHomeFirstTurnPrompt } from '@/playwright/home-first-turn';
import { ensureRailOpen } from '@/playwright/rail';
import { T } from '@/timeouts';

const evidence = fileURLToPath(new URL('../../.omo/evidence/databricks-impl/final-ui5/', import.meta.url));
test.use({ trace: 'on' });
const addModelsId = 'inline-model-switcher-model-action-add-databricks-models';
const actionId = 'databricks:add-models';
const captures: { state: number; title: string; image: string; dom: string; values: unknown }[] = [];
const network: { method: string; path: string; status?: number; body?: unknown }[] = [];
const errors: string[] = [];
let activeState = 1;

async function capture(page: Page, state: number, title: string, suffix: string, values: unknown) {
  const stem = `final-${String(state).padStart(2, '0')}-${suffix}`;
  const dom = `${stem}.dom.json`;
  await page.screenshot({ path: join(evidence, `${stem}.png`), animations: 'disabled' });
  await writeFile(join(evidence, dom), JSON.stringify({
    url: page.url(), values,
    accessibility: await page.locator('body').ariaSnapshot(),
    popovers: await page.locator('[data-testid$="-popover"]').evaluateAll(nodes => nodes.map(n => n.outerHTML)),
    dialogs: await page.getByRole('dialog').evaluateAll(nodes => nodes.map(n => n.outerHTML)),
  }, null, 2));
  captures.push({ state, title, image: `${stem}.png`, dom, values });
}

async function openPicker(page: Page, scope: Locator, kind: 'agent' | 'model') {
  await scope.getByTestId(`inline-model-switcher-${kind}-trigger`).click();
  const picker = page.getByTestId(`inline-model-switcher-${kind}-popover`);
  await expect(picker).toBeVisible();
  return picker;
}

async function closePicker(page: Page, picker: Locator) {
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
}

async function measureModels(picker: Locator) {
  return picker.evaluate(node => {
    const buttons = [...node.querySelectorAll('button')];
    const action = node.querySelector('[data-model-action]');
    return {
      buttons: buttons.map(button => ({
        id: button.dataset.testid, role: button.getAttribute('role'),
        selected: button.getAttribute('aria-selected'), text: button.textContent?.trim(),
      })),
      actionCount: node.querySelectorAll('[data-model-action]').length,
      actionId: action?.getAttribute('data-model-action'),
      actionRole: action?.getAttribute('role'),
      actionSelected: action?.getAttribute('aria-selected'),
      actionValue: action?.getAttribute('value'),
      actionLast: buttons.at(-1) === action,
      settingsCount: node.querySelectorAll('[data-testid="inline-model-switcher-open-settings"]').length,
      optionCount: node.querySelectorAll('[role="option"]').length,
      selectedCount: node.querySelectorAll('[role="option"][aria-selected="true"]').length,
    };
  });
}

async function assertModelRows(picker: Locator, count: number, selected: number) {
  await expect(picker.getByRole('option')).toHaveCount(count);
  await expect(picker.locator('button')).toHaveCount(count + 1);
  const values = await measureModels(picker);
  expect(values).toMatchObject({
    actionCount: 1, actionId, actionRole: null, actionSelected: null,
    actionValue: null, actionLast: true, settingsCount: 0,
    optionCount: count, selectedCount: selected,
  });
  return values;
}

async function agentRows(picker: Locator) {
  await expect(picker.getByTestId('inline-model-switcher-agent-databricks')).toHaveAttribute('role', 'radio');
  await expect(picker.getByTestId('inline-model-switcher-agent-pi')).toHaveAttribute('role', 'radio');
  return picker.getByRole('radio').evaluateAll(nodes => nodes.map(node => ({
    id: node.getAttribute('data-testid'), checked: node.getAttribute('aria-checked'), text: node.textContent?.trim(),
  })));
}

test('Databricks complete live GUI contract: Hub, discovery, registration, workspace', async ({ page, request }, testInfo) => {
  test.setTimeout(T.xlong * 8);
  expect(process.env.READABLE_E2E_NAMESPACE, 'This live gate must own dbx-ui5').toBe('dbx-ui5');
  expect(testInfo.project.use.baseURL).toBe('http://127.0.0.1:17952');
  await mkdir(evidence, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  page.on('request', req => {
    if (new URL(req.url()).pathname.startsWith('/api/')) {
      network.push({ method: req.method(), path: new URL(req.url()).pathname });
    }
  });
  page.on('pageerror', error => errors.push(error.message));
  const runPosts = () => network.filter(item => item.method === 'POST' && /\/api\/(?:runs|projects(?:\/[^/]+\/runs)?)$/.test(item.path));
  const hub = page.getByTestId('home-hero-agent-model');
  let scan: DatabricksScanResponse;
  let registered: DatabricksModelResponse;
  let piBefore: AgentInfo;

  try {
    await test.step('1. Real daemon exposes distinct agents; native Databricks selection', async () => {
      const response = await request.get('/api/agents');
      expect(response.ok(), await response.text()).toBe(true);
      const agents = (await response.json() as { agents: AgentInfo[] }).agents;
      const databricks = agents.find(agent => agent.id === 'databricks');
      const pi = agents.find(agent => agent.id === 'pi');
      expect(databricks).toMatchObject({ available: true, models: [], modelManagement: 'databricks' });
      expect(pi).toMatchObject({ available: true });
      piBefore = pi!;
      const registry = await request.get('/api/databricks/models');
      expect(registry.ok()).toBe(true);
      expect((await registry.json() as DatabricksModelsResponse).models).toEqual([]);
      // Locale only. Agent, model, onboarding and daemon app-config stay untouched.
      await addStorageInitScript(page, () => {
        localStorage.setItem('readable-studio:locale', 'en');
        localStorage.setItem('readable-studio:locale-source', 'manual');
      }, undefined);
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await expect(hub).toBeVisible({ timeout: T.xlong });
      const picker = await openPicker(page, hub, 'agent');
      await agentRows(picker);
      await picker.getByTestId('inline-model-switcher-agent-databricks').click();
      await expect(picker.getByTestId('inline-model-switcher-agent-databricks')).toHaveAttribute('aria-checked', 'true');
      await expect(picker.getByTestId('inline-model-switcher-agent-pi')).toHaveAttribute('aria-checked', 'false');
      await expect(hub.getByTestId('inline-model-switcher-agent-trigger')).toHaveAccessibleName(/Databricks/);
      await capture(page, 1, 'Hub: Databricks selected separately from Pi', 'agents', { databricks, pi, rows: await agentRows(picker) });
      await closePicker(page, picker);
    });

    activeState = 2;
    await test.step('2. Exact empty action row and blocked send retaining draft', async () => {
      let picker = await openPicker(page, hub, 'model');
      const empty = await assertModelRows(picker, 0, 0);
      await capture(page, 2, 'Empty picker: only Add Models', 'empty', empty);
      await closePicker(page, picker);
      const draft = 'Databricks empty catalogue must retain this unsent draft';
      await enterHomeFirstTurnPrompt(page, draft);
      for (const inputMethod of ['click', 'Enter'] as const) {
        // Observe the actual validation event, not a toast left over from click.
        await page.evaluate(timeout => {
          const state = window as typeof window & { dbxWarning?: Promise<boolean> };
          state.dbxWarning = new Promise(resolve => {
            const onWarning = () => { clearTimeout(timer); resolve(true); };
            const timer = setTimeout(() => {
              window.removeEventListener('readable:model-selection-required', onWarning);
              resolve(false);
            }, timeout);
            window.addEventListener('readable:model-selection-required', onWarning, { once: true });
          });
        }, T.medium);
        if (inputMethod === 'click') await page.getByTestId('home-hero-submit').click();
        else await page.getByTestId('home-hero-input').press('Enter');
        expect(await page.evaluate(() => (window as typeof window & { dbxWarning: Promise<boolean> }).dbxWarning), `${inputMethod} triggers missing-model validation`).toBe(true);
        await expect(page.getByTestId('inline-model-switcher-model-toast')).toBeVisible();
        await expect(page.getByTestId('home-hero-input')).toHaveText(draft);
        await expect(page.getByTestId('chat-composer')).toHaveCount(0);
        expect(runPosts()).toEqual([]);
        await capture(page, 2, `${inputMethod} blocked: draft retained, no project/run POST`, `blocked-${inputMethod.toLowerCase()}`, {
          inputMethod, validationEvent: true,
          draft: await page.getByTestId('home-hero-input').textContent(),
          warning: await page.getByTestId('inline-model-switcher-model-toast').textContent(),
          runOrProjectPosts: runPosts(),
        });
      }
      // The retained draft is cleared by native keyboard input before any model is selected.
      await page.getByTestId('home-hero-input').click();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Backspace');
      await expect(page.getByTestId('home-hero-input')).toHaveText('');
      picker = await openPicker(page, hub, 'model');
      await assertModelRows(picker, 0, 0);
    });

    activeState = 3;
    await test.step('3. Portaled, centered dialog; authenticated profile; real dynamic scan', async () => {
      const statusPending = page.waitForResponse(r => new URL(r.url()).pathname === '/api/databricks/status', { timeout: T.xlong });
      const discoveryPending = page.waitForResponse(r => new URL(r.url()).pathname === '/api/databricks/probe' && r.request().method() === 'POST', { timeout: T.xlong });
      const responsesPending = Promise.all([statusPending, discoveryPending]);
      await page.getByTestId(addModelsId).click();
      const [statusResponse, discoveryResponse] = await responsesPending;
      const status = await statusResponse.json() as DatabricksStatusResponse;
      network.push({ method: 'GET', path: '/api/databricks/status', status: statusResponse.status(), body: status });
      expect(statusResponse.ok()).toBe(true);
      expect(status).toMatchObject({ cli: 'ready', auth: 'unchecked', profiles: [] });
      const discovery = await discoveryResponse.json() as DatabricksProfilesResponse;
      network.push({ method: 'POST', path: '/api/databricks/probe', status: discoveryResponse.status(), body: discovery });
      expect(discoveryResponse.ok(), JSON.stringify(discovery)).toBe(true);
      const initialProfileRequests = network.filter(item => item.status === undefined && ['/api/databricks/status', '/api/databricks/probe'].includes(item.path));
      expect(initialProfileRequests).toEqual([
        { method: 'GET', path: '/api/databricks/status' },
        { method: 'POST', path: '/api/databricks/probe' },
      ]);
      const modal = page.getByTestId('databricks-add-models-modal');
      await expect(modal).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(1);
      const profile = discovery.profiles.find(item => item.auth === 'authenticated') ?? discovery.profiles[0];
      let authenticatedProbe: DatabricksProfilesResponse | null = null;
      expect(profile, 'At least one real CLI profile must be discovered').toBeDefined();
      const profileCard = modal.getByTestId(`databricks-profile-${profile!.id}`);
      await expect(profileCard).toBeVisible();
      if (profile!.auth === 'unchecked') {
        const probePending = page.waitForResponse(r => new URL(r.url()).pathname === '/api/databricks/probe', { timeout: T.xlong });
        await profileCard.click();
        const probeResponse = await probePending;
        const probeBody = await probeResponse.json() as DatabricksProfilesResponse;
        authenticatedProbe = probeBody;
        network.push({ method: 'POST', path: '/api/databricks/probe', status: probeResponse.status(), body: probeBody });
        expect(probeResponse.ok()).toBe(true);
        expect(probeBody.profiles.find(item => item.id === profile!.id)?.auth).toBe('authenticated');
      } else {
        expect(profile!.auth).toBe('authenticated');
        await profileCard.click();
      }
      await expect(profileCard).toHaveAttribute('aria-checked', 'true');
      await expect(modal.getByTestId('databricks-scan-start')).toBeEnabled();
      // Native pointer action settles entry animations before geometric measurement.
      const geometry = await modal.evaluate(node => {
        const rect = node.getBoundingClientRect();
        const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        const hit = document.elementFromPoint(center.x, center.y);
        return {
          dialogCount: document.querySelectorAll('[role="dialog"]').length,
          withinViewport: rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
          bodyPortal: node.parentElement?.parentElement === document.body,
          insideComposer: !!node.closest('[data-testid="home-hero-agent-model"]'),
          centerHitInDialog: !!hit && node.contains(hit),
          centerOffset: { x: Math.abs(center.x - innerWidth / 2), y: Math.abs(center.y - innerHeight / 2) },
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          hit: hit?.outerHTML,
        };
      });
      expect(geometry).toMatchObject({ dialogCount: 1, withinViewport: true, bodyPortal: true, insideComposer: false, centerHitInDialog: true });
      expect(geometry.centerOffset.x).toBeLessThanOrEqual(2);
      expect(geometry.centerOffset.y).toBeLessThanOrEqual(2);
      await capture(page, 3, 'Body portal and selectable authenticated profile', 'modal', {
        geometry, status, discovery, initialProfileRequests, authenticatedProbe,
        selectedProfile: profile!.id, profileDOM: await profileCard.innerText(),
      });

      // Subscribe to the exact completed UI state before triggering the scan.
      // A bounded timeout is a failure bound, not a sleep or polling delay.
      await page.evaluate(timeout => {
        const state = window as typeof window & { dbxScanSettled?: Promise<boolean> };
        state.dbxScanSettled = new Promise(resolve => {
          const observer = new MutationObserver(inspect);
          const timer = setTimeout(() => { observer.disconnect(); resolve(false); }, timeout);
          function inspect() {
            const progress = document.querySelector('[data-testid="databricks-scan-progress"]');
            const cancel = document.querySelector('[data-testid="databricks-scan-cancel"]');
            const start = document.querySelector<HTMLButtonElement>('[data-testid="databricks-scan-start"]');
            if (progress && !cancel && start && !start.disabled) {
              clearTimeout(timer); observer.disconnect(); resolve(true);
            }
          }
          observer.observe(document.body, { subtree: true, childList: true, attributes: true });
        });
      }, T.xlong * 3);
      const scanPending = page.waitForResponse(r => new URL(r.url()).pathname === '/api/databricks/scans' && r.request().method() === 'POST', { timeout: T.xlong });
      await modal.getByTestId('databricks-scan-start').click();
      const startedResponse = await scanPending;
      const started = await startedResponse.json() as DatabricksScanResponse;
      expect(startedResponse.ok(), JSON.stringify(started)).toBe(true);
      expect(await page.evaluate(() => (window as typeof window & { dbxScanSettled: Promise<boolean> }).dbxScanSettled), 'Live scan settled').toBe(true);
      const snapshotResponse = await request.get(`/api/databricks/scans/${started.scanId}`);
      scan = await snapshotResponse.json() as DatabricksScanResponse;
      network.push({ method: 'GET', path: `/api/databricks/scans/${started.scanId}`, status: snapshotResponse.status(), body: scan });
      expect(snapshotResponse.ok()).toBe(true);
      expect(['complete', 'partial']).toContain(scan.state);
      expect(scan.counters.candidates).toBeGreaterThan(0);
      expect(scan.cursor, 'All discovered endpoints fit this snapshot').toBeNull();
      await expect(modal.getByTestId('databricks-endpoint-list').locator(':scope > li')).toHaveCount(scan.endpoints.length);
      await expect(modal.getByTestId('databricks-scan-error')).toHaveCount(0);
      await capture(page, 3, 'Real workspace scan (historical 24 is not a fixture)', 'scan', {
        scan, rowCount: await modal.getByTestId('databricks-endpoint-list').locator(':scope > li').count(),
        progress: await modal.getByTestId('databricks-scan-progress').textContent(),
      });
    });

    activeState = 4;
    await test.step('4. Register exactly one compatible discovered model through GUI', async () => {
      const compatible = scan.endpoints.filter(endpoint => endpoint.availability === 'compatible');
      const chosen = compatible.find(endpoint => /luna|claude/i.test(endpoint.label)) ?? compatible[0];
      expect(chosen, 'The real scan must discover a compatible model').toBeDefined();
      const modal = page.getByTestId('databricks-add-models-modal');
      const toggle = modal.getByTestId(`databricks-endpoint-toggle-${chosen!.id}`);
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      const registrationPending = page.waitForResponse(r => new URL(r.url()).pathname === `/api/databricks/models/${chosen!.id}` && r.request().method() === 'PUT', { timeout: T.xlong });
      await toggle.click();
      const response = await registrationPending;
      registered = await response.json() as DatabricksModelResponse;
      network.push({ method: 'PUT', path: `/api/databricks/models/${chosen!.id}`, status: response.status(), body: registered });
      expect(response.ok(), JSON.stringify(registered)).toBe(true);
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      const registryResponse = await request.get('/api/databricks/models');
      expect(registryResponse.ok()).toBe(true);
      const registry = await registryResponse.json() as DatabricksModelsResponse;
      expect(registry.models).toHaveLength(1);
      expect(registry.models[0]?.id).toBe(chosen!.id);
      expect(registered.endpoint.availability).toBe('compatible');
      await capture(page, 4, 'One locally registered compatible model', 'registered', { chosen, registered, registry, checked: await toggle.getAttribute('aria-checked') });
      await modal.getByTestId('databricks-add-models-done').click();
      await expect(modal).toHaveCount(0);
    });

    activeState = 5;
    await test.step('5. Model above final Add Models; no automatic selection; explicit selection clears warning', async () => {
      let picker = await openPicker(page, hub, 'model');
      const values = await assertModelRows(picker, 1, 0);
      const optionId = `inline-model-switcher-model-option-${registered.appModelId}`;
      await expect(picker.getByTestId(optionId)).toHaveAttribute('role', 'option');
      await expect(hub.getByTestId('inline-model-switcher-model-warning-mark')).toBeVisible();
      await capture(page, 5, 'Registered model remains unselected above Add Models', 'unselected', values);
      await picker.getByTestId(optionId).click();
      await expect(picker).toHaveCount(0);
      await expect(hub.getByTestId('inline-model-switcher-model-warning-mark')).toHaveCount(0);
      await expect(page.getByTestId('inline-model-switcher-model-toast')).toHaveCount(0);
      picker = await openPicker(page, hub, 'model');
      const selected = await assertModelRows(picker, 1, 1);
      expect(runPosts()).toEqual([]);
      await capture(page, 5, 'Explicit model selection clears warning', 'selected', { selected, warningCount: 0, runOrProjectPosts: runPosts() });
      await closePicker(page, picker);
    });

    activeState = 6;
    await test.step('6. Native blank project creation opens workspace with both agents and model', async () => {
      await ensureRailOpen(page);
      await page.getByTestId('hub-new-project').click();
      const modal = page.getByTestId('new-project-modal');
      await expect(modal).toBeVisible();
      await modal.getByTestId('new-project-tab-other').click();
      await modal.getByTestId('new-project-name').fill('Databricks GUI final - no inference');
      await modal.getByTestId('newproj-mode-chat').click();
      const projectPending = page.waitForResponse(r => new URL(r.url()).pathname === '/api/projects' && r.request().method() === 'POST', { timeout: T.long });
      await modal.getByTestId('create-project').click();
      const projectResponse = await projectPending;
      expect(projectResponse.ok(), await projectResponse.text()).toBe(true);
      await expect(page).toHaveURL(/\/projects\//, { timeout: T.xlong });
      const workspace = page.getByTestId('chat-composer');
      await expect(workspace).toBeVisible({ timeout: T.xlong });
      await expect(hub).toHaveCount(0);
      let picker = await openPicker(page, workspace, 'agent');
      const rows = await agentRows(picker);
      await expect(picker.getByTestId('inline-model-switcher-agent-databricks')).toHaveAttribute('aria-checked', 'true');
      await capture(page, 6, 'Workspace keeps Databricks and Pi separate', 'agents', { rows, url: page.url() });
      await closePicker(page, picker);
      picker = await openPicker(page, workspace, 'model');
      const values = await assertModelRows(picker, 1, 1);
      await expect(picker.getByTestId(`inline-model-switcher-model-option-${registered.appModelId}`)).toHaveAttribute('role', 'option');
      const posts = network.filter(item => item.method === 'POST').map(item => item.path);
      expect(posts.filter(path => /\/runs(?:\/|$)|\/verify(?:\/|$)/.test(path))).toEqual([]);
      expect(posts.filter(path => path === '/api/projects')).toHaveLength(1);
      expect(network.filter(item => item.status === undefined && item.method === 'PUT' && item.path.startsWith('/api/databricks/models/'))).toHaveLength(1);
      await capture(page, 6, 'Workspace contains the registered Databricks model', 'model', { values, posts, noPaidPrompt: true });
      await closePicker(page, picker);
      picker = await openPicker(page, workspace, 'agent');
      await picker.getByTestId('inline-model-switcher-agent-pi').click();
      await expect(picker.getByTestId('inline-model-switcher-agent-pi')).toHaveAttribute('aria-checked', 'true');
      await expect(picker.getByTestId('inline-model-switcher-agent-databricks')).toHaveAttribute('aria-checked', 'false');
      await capture(page, 6, 'Direct Pi remains separately selectable in workspace', 'pi-agent', { rows: await agentRows(picker) });
      await closePicker(page, picker);
      picker = await openPicker(page, workspace, 'model');
      await expect(picker.getByTestId(addModelsId)).toHaveCount(0);
      const agentsResponse = await request.get('/api/agents');
      expect(agentsResponse.ok()).toBe(true);
      const piAfter = ((await agentsResponse.json() as { agents: AgentInfo[] }).agents).find(agent => agent.id === 'pi');
      expect(piAfter).toEqual(piBefore);
      await capture(page, 6, 'Direct Pi catalogue unchanged by Databricks registration', 'pi-models', {
        piBefore, piAfter, catalogueUnchanged: true, addModelsCount: await picker.getByTestId(addModelsId).count(),
        options: await picker.getByRole('option').evaluateAll(nodes => nodes.map(node => node.outerHTML)),
      });
      await closePicker(page, picker);
      picker = await openPicker(page, workspace, 'agent');
      await picker.getByTestId('inline-model-switcher-agent-databricks').click();
      await expect(picker.getByTestId('inline-model-switcher-agent-databricks')).toHaveAttribute('aria-checked', 'true');
      await closePicker(page, picker);
      picker = await openPicker(page, workspace, 'model');
      const restored = await assertModelRows(picker, 1, 1);
      await expect(picker.getByTestId(`inline-model-switcher-model-option-${registered.appModelId}`)).toHaveAttribute('aria-selected', 'true');
      expect(network.filter(item => item.method === 'POST' && /\/runs(?:\/|$)|\/verify(?:\/|$)/.test(item.path))).toEqual([]);
      await capture(page, 6, 'Databricks restored with the same explicitly selected model', 'restored', restored);
    });
  } catch (error) {
    errors.push(String(error));
    await capture(page, activeState, `FAIL at state ${activeState}`, 'failure', { error: String(error), network, errors });
    throw error;
  } finally {
    await writeFile(join(evidence, 'final-network.json'), JSON.stringify({ network, errors }, null, 2));
  }
});

test.afterEach(async ({}, testInfo) => {
  const passed = testInfo.status === 'passed';
  const sections = [1, 2, 3, 4, 5, 6].map(state => {
    const items = captures.filter(item => item.state === state);
    return `## ${state}. ${items.length ? items[0]!.title : 'NOT REACHED'}\n\n${items.map(item =>
      `### ${item.title}\n\n![${item.title}](${item.image})\n\n[Full DOM evidence](${item.dom})\n\n\`\`\`json\n${JSON.stringify(item.values, null, 2)}\n\`\`\`\n`).join('\n')}`;
  });
  await writeFile(join(evidence, 'gate-ui5.md'), `# Databricks final real-Chromium gate\n\nVerdict: **${passed ? 'PASS' : 'FAIL'}**. Playwright: **${passed ? '1 passed, 0 failed' : '0 passed, 1 failed'}**, workers=1, retries=0.\n\nRuntime: namespace dbx-ui5; tools root .tmp/tools-dev-dbx-ui5; daemon 17852; web 17952. Fresh isolated data directory: .tmp/tools-dev-dbx-ui5/data.\n\nAssumptions: this task is the designated browser verification node; authenticated machine CLI profiles are read-only discovery inputs. Candidate count is dynamic, never mocked or pinned. Only locale is seeded; no app-config, agent, model or response overrides. All selections, registration and workspace creation use native pointer/keyboard input. One blank local project is created only at state 6; no inference or cloud writes.\n\nCommand:\n\n\`\`\`bash\nREADABLE_E2E_REUSE_SERVER=1 READABLE_E2E_NAMESPACE=dbx-ui5 READABLE_PORT=17852 READABLE_WEB_PORT=17952 pnpm --dir e2e exec playwright test -c playwright.config.ts ui/databricks-final.test.ts --workers=1 --retries=0 --reporter=line\n\`\`\`\n\n[Network observations](final-network.json).\n\n${sections.join('\n')}\n## Errors\n\n\`\`\`json\n${JSON.stringify({ errors, runnerErrors: testInfo.errors }, null, 2)}\n\`\`\`\n\n## Lifecycle and validation\n\nNamespace teardown and validator results are recorded below after execution.\n`);
});
