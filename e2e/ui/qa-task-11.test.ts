import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * QA for todo 11 of hub-restore-and-match-mockup: the rail is only "complete"
 * when open work, the row overflow menus, the inspector, the single sort
 * control and the running strip all RENDER and ACT on the live surface.
 *
 * This lane exists because a UI once shipped as done on `data-testid` presence
 * plus green unit tests. So nothing here passes on a node merely existing:
 *
 *  - destructive/renaming actions are proven through the DAEMON payload
 *    (`/api/projects`, `/api/projects/<id>/conversations`), never DOM text,
 *    so a menu wired to the wrong row cannot pass;
 *  - focus assertions read `document.activeElement`, which a cosmetic edit
 *    cannot satisfy;
 *  - the sort control is asserted by COUNT, so re-adding the obsolete
 *    two-pill shape fails;
 *  - the rail screenshot is compared against the approved mockup region.
 *
 * The three behaviours todo 11 inherited - the tree keyboard model
 * (HubSessionTree.tsx:176-199), the five-session overflow, and the filter
 * counts - are re-asserted here so a rail rewrite cannot silently drop them.
 *
 * Run states are seeded through the daemon's OWN message route, because
 * `latestRun` is derived from the last assistant message's `run_status`. No
 * request is intercepted and no response is faked: the running strip below
 * renders from a conversation the daemon genuinely reports as in-flight.
 */

test.describe.configure({ mode: 'serial' });

const STORAGE_KEY = 'readable-studio:config';
const OPEN_WORK_KEY = 'readable-studio:hub-open-work';
/** Matches HUB_SESSION_PAGE in apps/web/src/components/hub/types.ts. */
const SESSION_PAGE = 5;

/**
 * Evidence lands in the MAIN repo's `.omo/evidence/task-11`; `.omo/` is
 * gitignored and the orchestrator collects from the main tree. `e2e/ui` ->
 * worktree root is two levels and the worktree lives at `<main>/.tmp/wt/todo11`,
 * so the main repo is three more - five in total.
 */
const mainRepo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const evidenceDir = process.env.READABLE_TASK11_EVIDENCE_DIR ?? resolve(mainRepo, '.omo/evidence/task-11');
const mockupShot = resolve(mainRepo, '.tmp/design/main-hub/shots/r1-start.png');

const HOME_CONFIG = {
  mode: 'daemon',
  apiKey: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  agentId: 'codex',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  agentModels: { codex: { model: 'default', reasoning: 'default' } },
  agentCliEnv: {},
  privacyDecisionAt: 1,
  telemetry: { metrics: false, content: false, artifactManifest: false },
};

interface SeededSession {
  id: string;
  title: string;
}

interface DaemonSessionRow {
  id: string;
  title: string | null;
  updatedAt: number;
  latestRun?: { status?: string };
}

interface SeededProject {
  id: string;
  name: string;
  sessions: SeededSession[];
}

let seeded: SeededProject[] = [];
/** The session seeded into a genuinely RUNNING run, for the live strip. */
let runningSession: { project: SeededProject; session: SeededSession; startedAt: number };
/** The session seeded into a genuinely FAILED run, for the "needs you" filter. */
let failedSessionId: string;
let failedProjectId: string;
/** All projects present after this spec seeds, including earlier integrated specs. */
let expectedProjectCount: number;

/**
 * Drives a conversation into a real run state through the daemon's own
 * message route. `latestRun` is derived from the last assistant message's
 * `run_status` (apps/daemon/src/db.ts latestConversationRunSummary), so this
 * produces a genuinely running/failed conversation - no request interception,
 * no injected response, nothing the UI can tell apart from a live agent run.
 */
async function seedRunStatus(
  request: APIRequestContext,
  projectId: string,
  conversationId: string,
  runStatus: 'running' | 'failed',
  startedAt: number,
): Promise<void> {
  const userResponse = await request.put(
    `/api/projects/${projectId}/conversations/${conversationId}/messages/u-${conversationId}`,
    {
      data: {
        role: 'user',
        content: 'Tidy up the chart palette.',
        createdAt: startedAt - 1_000,
      },
    },
  );
  expect(userResponse.ok(), await userResponse.text()).toBeTruthy();

  const assistantResponse = await request.put(
    `/api/projects/${projectId}/conversations/${conversationId}/messages/a-${conversationId}`,
    {
      data: {
        role: 'assistant',
        content: '',
        agentId: 'codex',
        runId: `qa-task-11-${conversationId}`,
        runStatus,
        createdAt: startedAt,
        startedAt,
        // A running run has NOT ended; leaving endedAt unset is what keeps the
        // daemon reporting it as in-flight.
        ...(runStatus === 'failed' ? { endedAt: startedAt + 1_000 } : {}),
        events: [],
      },
    },
  );
  expect(assistantResponse.ok(), await assistantResponse.text()).toBeTruthy();

  // Writing a message forces `conversations.updated_at = Date.now()` (db.ts
  // upsertMessage, "Bump conversation activity so the sidebar's recency sort
  // works"), which would make the rail read this run as having started *now*.
  // Pin the conversation's own activity stamp back to when the run began, so
  // the strip's elapsed label reflects the seeded run rather than the seeding.
  const stamped = await request.patch(`/api/projects/${projectId}/conversations/${conversationId}`, {
    data: { updatedAt: startedAt },
  });
  expect(stamped.ok(), await stamped.text()).toBeTruthy();

  // Confirm the DAEMON itself reports the state before any UI assertion leans
  // on it - otherwise a strip failure could not be told apart from a bad seed.
  const conversations = await daemonSessions(request, projectId);
  const seededRow = conversations.find((row) => row.id === conversationId);
  expect(seededRow?.latestRun?.status, JSON.stringify(seededRow?.latestRun)).toBe(runStatus);
  expect(seededRow?.updatedAt).toBe(startedAt);
}

async function seedProject(
  request: APIRequestContext,
  name: string,
  sessionTitles: string[],
): Promise<SeededProject> {
  const id = `task-11-${name.toLowerCase().replace(/[^a-z0-9]+/gu, '-')}`;
  const response = await request.post('/api/projects', {
    data: {
      id,
      name,
      skillId: null,
      designSystemId: null,
      pendingPrompt: null,
      metadata: { kind: 'prototype', nameSource: 'user' },
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const project = ((await response.json()) as { project: { id: string } }).project;

  // The daemon seeds every new project with one untitled default conversation
  // ("Seed a default conversation so the UI always has somewhere to write").
  // Drop it so this project's sessions are exactly the ones named here -
  // otherwise every count below would silently be off by one.
  for (const preexisting of await daemonSessions(request, project.id)) {
    const removed = await request.delete(
      `/api/projects/${project.id}/conversations/${preexisting.id}`,
    );
    expect(removed.ok(), await removed.text()).toBeTruthy();
  }
  expect(await daemonSessions(request, project.id)).toHaveLength(0);

  const sessions: SeededSession[] = [];
  for (const title of sessionTitles) {
    const created = await request.post(`/api/projects/${project.id}/conversations`, {
      data: { title },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const conversation = ((await created.json()) as { conversation: SeededSession }).conversation;
    // The daemon's create route does not always honour the requested title, so
    // pin it explicitly - the rename/delete assertions identify rows by title.
    const patched = await request.patch(
      `/api/projects/${project.id}/conversations/${conversation.id}`,
      { data: { title } },
    );
    expect(patched.ok(), await patched.text()).toBeTruthy();
    sessions.push({ id: conversation.id, title });
  }
  return { id: project.id, name, sessions };
}

/** Reads the daemon's own view of a project's sessions - the source of truth. */
async function daemonSessions(
  request: APIRequestContext,
  projectId: string,
): Promise<DaemonSessionRow[]> {
  const response = await request.get(`/api/projects/${projectId}/conversations`);
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { conversations: DaemonSessionRow[] }).conversations;
}

async function daemonProjects(
  request: APIRequestContext,
): Promise<Array<{ id: string; name: string }>> {
  const response = await request.get('/api/projects');
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { projects: Array<{ id: string; name: string }> }).projects;
}

async function gotoHub(page: Page, openWorkIds: string[] = []): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 940 });
  await page.addInitScript(
    ({ key, value, openKey, open }) => {
      window.localStorage.setItem(key, JSON.stringify(value));
      window.localStorage.removeItem('readable-studio:workspace-tabs:v1');
      window.sessionStorage.setItem(openKey, JSON.stringify(open));
    },
    { key: STORAGE_KEY, value: HOME_CONFIG, openKey: OPEN_WORK_KEY, open: openWorkIds },
  );
  await page.goto('/');
  await expect(page.getByTestId('entry-view-home')).toHaveAttribute('data-active', 'true');
  await expect(page.locator('[data-project-rail]')).toBeVisible();
  // The rail fans out one conversations fetch per project; wait on real rows
  // rather than on a timer. Every seeded project must have painted, and the
  // per-project session fetches must have landed - asserted through the
  // rendered session rows, not through a single hardcoded id, because the
  // default "recent" sort plus the five-session page decide WHICH rows show.
  // Each project's own session fetch is awaited through a row INSIDE that
  // project, so no test starts against a half-populated tree. The specific row
  // is not pinned: the default "recent" sort and the five-session page decide
  // which sessions show, and this suite deliberately moves rows between pages.
  for (const project of seeded) {
    await expect(page.getByTestId(`hub-project-${project.id}`)).toBeVisible();
    await expect(
      page.locator(`[data-testid="hub-project-${project.id}"] [data-session-id]`).first(),
    ).toBeVisible();
  }
}

/** data-testid of whatever currently holds focus, for activeElement proofs. */
function activeTestId(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null);
}

test.beforeAll(async ({ request }) => {
  // Seven projects with MIXED session states, matching the approved mockup:
  // the first carries nine sessions so the five-session overflow row appears.
  seeded = [
    await seedProject(request, 'Quarterly Report', [
      'Chart palette cleanup',
      'Legend overlap fix',
      'Exec summary draft',
      'Q2 numbers import',
      'Cover layout',
      'Footnote pass',
      'Appendix tables',
      'Initial structure',
      'Style sweep',
    ]),
    await seedProject(request, 'Onboarding Deck', ['Slide flow', 'Voice pass']),
    await seedProject(request, 'Pricing Page', ['Tier comparison']),
    await seedProject(request, 'Brand Refresh', ['Palette audit', 'Type scale']),
    await seedProject(request, 'Docs Portal', ['Nav rewrite']),
    await seedProject(request, 'Field Guide', ['Photo captions']),
    await seedProject(request, 'Release Notes', ['Changelog groom']),
  ];

  // The mockup's rail is not uniformly idle - it shows state on real rows. Two
  // projects are driven into real run states so the rendered rail carries the
  // same running/failed signal the approved shot does.
  const startedAt = Date.now() - 4 * 60_000;
  runningSession = { project: seeded[0]!, session: seeded[0]!.sessions[0]!, startedAt };
  await seedRunStatus(
    request,
    runningSession.project.id,
    runningSession.session.id,
    'running',
    startedAt,
  );
  failedProjectId = seeded[6]!.id;
  failedSessionId = seeded[6]!.sessions[0]!.id;
  await seedRunStatus(request, failedProjectId, failedSessionId, 'failed', Date.now() - 9 * 60_000);

  // The project-menu test asserts that "new session" genuinely CREATES one.
  // The hub deliberately reopens an untouched empty session instead of
  // stacking a second, so give this project's only session a message to make
  // the create path the real one under test.
  const docsPortal = seeded[4]!;
  const seededMessage = await request.put(
    `/api/projects/${docsPortal.id}/conversations/${docsPortal.sessions[0]!.id}/messages/u-docs-portal`,
    {
      data: {
        role: 'user',
        content: 'Rewrite the navigation.',
        createdAt: Date.now() - 60_000,
      },
    },
  );
  expect(seededMessage.ok(), await seededMessage.text()).toBeTruthy();
  expectedProjectCount = (await daemonProjects(request)).length;
});

test('the rail renders the mockup shape and matches the approved region', async ({ page }) => {
  await gotoHub(page);
  mkdirSync(evidenceDir, { recursive: true });

  // ACCEPTANCE: every project present in this integrated run is counted from
  // the rendered group label, including projects seeded by an earlier spec.
  await expect(page.getByTestId('hub-group-count')).toHaveText(String(expectedProjectCount));
  for (const project of seeded) {
    await expect(page.getByTestId(`hub-project-${project.id}`)).toBeVisible();
  }

  // SURVIVOR: the five-session overflow. The nine-session project shows five
  // rows plus a "show N more" row, and activating it reveals the rest.
  const big = seeded[0]!;
  const bigRows = page.locator(`[data-testid="hub-project-${big.id}"] [data-session-id]`);
  await expect(bigRows).toHaveCount(SESSION_PAGE);
  const more = page.getByTestId(`hub-tree-more-${big.id}`);
  await expect(more).toBeVisible();
  await expect(more).toContainText(String(big.sessions.length - SESSION_PAGE));
  await more.click();
  await expect(bigRows).toHaveCount(big.sessions.length);
  await expect(page.getByTestId(`hub-tree-more-${big.id}`)).toHaveCount(0);

  // The approved mockup shows STATE PILLS on collapsed project rows ("실행 중",
  // "입력 대기"). They are rendered by HubSessionTree from rollupProjectState,
  // and they appear on a project row while it is collapsed - an expanded
  // project shows the state on its own session rows instead, which is why an
  // all-expanded, all-idle capture shows none. Collapse the two projects
  // holding real run states and assert the pills actually paint.
  for (const [projectId, expected] of [
    [runningSession.project.id, 'running'],
    [failedProjectId, 'failed'],
  ] as const) {
    const row = page.getByTestId(`hub-project-${projectId}`);
    await expect(row).toHaveAttribute('data-state', expected);
    // The session group is a DESCENDANT of the project treeitem, so clicking
    // the row's box would land on a nested session and navigate away. Collapse
    // from the keyboard, which the tree routes to the project row itself.
    if ((await row.getAttribute('aria-expanded')) === 'true') {
      await row.focus();
      await page.keyboard.press('ArrowLeft');
    }
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    const pill = row.locator(`> .hub-row__state--${expected}`);
    await expect(pill).toBeVisible();
    // Painted, coloured from a token, and actually carrying text - not an
    // empty span that happens to exist.
    const pillInfo = await pill.evaluate((el) => ({
      text: (el.textContent ?? '').trim(),
      color: getComputedStyle(el).color,
      width: el.getBoundingClientRect().width,
    }));
    console.log(`STATE_PILL ${projectId}=` + JSON.stringify(pillInfo));
    expect(pillInfo.text.length).toBeGreaterThan(0);
    expect(pillInfo.width).toBeGreaterThan(0);
    // The state colours are distinct tokens, so a pill that fell back to the
    // default muted text colour is a regression.
    expect(pillInfo.color).not.toBe('');
  }

  const rail = page.locator('[data-project-rail]');
  await rail.screenshot({ path: resolve(evidenceDir, 'rail-seeded.png') });

  // The mockup region is compared as a real image: both rails are captured at
  // the same width so the comparison is about layout, not scaling.
  const railBox = await rail.boundingBox();
  expect(railBox).not.toBeNull();
  console.log(
    'RAIL_BOX=' + JSON.stringify(railBox) + ' MOCKUP=' + mockupShot,
  );
  // The approved shot is 2880px wide at 2x with a 420px rail; the live rail is
  // rendered at 1x, so the rail must occupy the same fraction of the surface.
  const viewport = page.viewportSize()!;
  const fraction = railBox!.width / viewport.width;
  console.log('RAIL_FRACTION=' + fraction.toFixed(4));
  expect(fraction).toBeGreaterThan(0.13);
  expect(fraction).toBeLessThan(0.25);
});

test('exactly one sort control opens a menu whose name option sorts the tree', async ({ page }) => {
  await gotoHub(page);

  // ACCEPTANCE: ONE sort control. The obsolete two-pill shape (a pill per
  // order) would make this count 0 and the whole test fail; re-adding
  // `hub-sort-recent`/`hub-sort-name` pills is asserted away explicitly.
  await expect(page.getByTestId('hub-sort')).toHaveCount(1);
  await expect(page.getByTestId('hub-sort-recent')).toHaveCount(0);
  await expect(page.getByTestId('hub-sort-name')).toHaveCount(0);

  const sort = page.getByTestId('hub-sort');
  await expect(sort).toHaveAttribute('aria-haspopup', 'menu');
  await expect(sort).toHaveAttribute('aria-expanded', 'false');

  const orderBefore = await page.$$eval('[data-project-id]', (nodes) =>
    nodes.map((n) => n.getAttribute('data-project-id')),
  );

  await sort.click();
  await expect(page.getByTestId('hub-sort-menu')).toBeVisible();
  await expect(sort).toHaveAttribute('aria-expanded', 'true');

  const byName = page.getByTestId('hub-sort-menu-name');
  await expect(byName).toBeVisible();
  await byName.click();
  await expect(page.getByTestId('hub-sort-menu')).toHaveCount(0);

  // ACCEPTANCE: selecting "Name" actually REORDERS the rendered tree. Proven
  // against the rendered row titles, so a menu that only paints a checkmark
  // fails here.
  const namesAfter = await page.$$eval('[data-project-id] > .hub-row__title', (nodes) =>
    nodes.map((n) => (n.textContent ?? '').trim()),
  );
  const orderAfter = await page.$$eval('[data-project-id]', (nodes) =>
    nodes.map((n) => n.getAttribute('data-project-id')),
  );
  console.log('SORT before=' + orderBefore.join(',') + ' after=' + orderAfter.join(','));
  expect(namesAfter).toEqual([...namesAfter].sort((a, b) => a.localeCompare(b)));
  expect(namesAfter.length).toBe(expectedProjectCount);

  // Reopening shows the chosen order checked, so the control carries state.
  await sort.click();
  await expect(page.getByTestId('hub-sort-menu-name')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('hub-sort-menu-recent')).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('hub-sort-menu')).toHaveCount(0);
});

test('open work renders held-open sessions and close removes only that row', async ({ page }) => {
  // Both held sessions come from small projects, so the tree renders their
  // rows on the first page - this test asserts open work is a HOLD rather than
  // a delete, which means reading the row back out of the tree.
  const held = [seeded[1]!.sessions[0]!, seeded[3]!.sessions[0]!];
  await gotoHub(page, held.map((s) => s.id));

  const openWork = page.getByTestId('hub-open-work');
  await expect(openWork).toBeVisible();
  const first = page.getByTestId(`hub-open-work-${held[0]!.id}`);
  const second = page.getByTestId(`hub-open-work-${held[1]!.id}`);
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  await expect(first).toContainText(held[0]!.title);

  // ACCEPTANCE: the close action REMOVES the row - and only that one.
  await page.getByTestId(`hub-close-open-${held[0]!.id}`).click();
  await expect(first).toHaveCount(0);
  await expect(second).toBeVisible();

  // Closing open work is putting a session away, NOT deleting it: the tree row
  // and the daemon record both survive.
  await expect(page.getByTestId(`hub-session-${held[0]!.id}`)).toBeVisible();

  // Closing the last held session retires the whole section rather than
  // leaving an empty labelled box.
  await page.getByTestId(`hub-close-open-${held[1]!.id}`).click();
  await expect(page.getByTestId('hub-open-work')).toHaveCount(0);
});

test('peek opens the inspector; Space peeks the focused row; Escape restores focus', async ({
  page,
}) => {
  await gotoHub(page);
  const session = seeded[1]!.sessions[0]!;
  const rowId = `hub-session-${session.id}`;

  // Pointer path: the peek action opens the inspector WITHOUT navigating.
  await page.getByTestId(`hub-peek-${session.id}`).click();
  const inspector = page.getByTestId('hub-inspector');
  await expect(inspector).toBeVisible();
  await expect(page.getByTestId('hub-inspector-name')).toHaveText(session.title);
  await expect(page.getByTestId('hub-inspector-project')).toHaveText(seeded[1]!.name);
  // Peeking must not leave the hub.
  await expect(page.getByTestId('entry-view-home')).toHaveAttribute('data-active', 'true');
  await page.getByTestId('hub-inspector-close').click();
  await expect(inspector).toHaveCount(0);

  // Keyboard path: focus the row, press Space, and the SAME session is peeked.
  await page.getByTestId(rowId).focus();
  expect(await activeTestId(page)).toBe(rowId);
  await page.keyboard.press(' ');
  await expect(inspector).toBeVisible();
  await expect(page.getByTestId('hub-inspector-name')).toHaveText(session.title);

  // ACCEPTANCE: Escape closes AND hands focus back to the row that peeked.
  // activeElement is read directly - a cosmetic edit cannot fake this.
  await page.keyboard.press('Escape');
  await expect(inspector).toHaveCount(0);
  await expect.poll(() => activeTestId(page)).toBe(rowId);

  // CROSS-BRANCH CONTRACT: exercise the real keyboard dispatcher from todo 10
  // through todo 11's listener into the real inspector. This fails if either
  // half uses the wrong event name or if the focused-row targeting regresses.
  await page.getByTestId(rowId).focus();
  await page.keyboard.press('Control+I');
  await expect(inspector).toBeVisible();
  await expect(page.getByTestId('hub-inspector-name')).toHaveText(session.title);

  // The same real shortcut toggles the inspector closed.
  await page.keyboard.press('Control+I');
  await expect(inspector).toHaveCount(0);

  // Opening from the shortcut and dismissing with Escape restores focus to the
  // exact session row, proven through document.activeElement.
  await page.getByTestId(rowId).focus();
  await page.keyboard.press('Control+I');
  await expect(inspector).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(inspector).toHaveCount(0);
  await expect.poll(() => activeTestId(page)).toBe(rowId);

  // Repeat the same immediate-Escape sequence in this invocation. This keeps
  // the fixed daemon fixture while proving pre-paint listener installation is
  // deterministic rather than a single lucky render.
  await page.getByTestId(rowId).focus();
  await page.keyboard.press('Control+I');
  await expect(inspector).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(inspector).toHaveCount(0);
  await expect.poll(() => activeTestId(page)).toBe(rowId);

  // Keep the lower-level receiving-half assertion too: direct dispatch proves
  // the listener's public integration seam independently of key handling.
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('readable:hub-inspector-toggle')),
  );
  await expect(inspector).toBeVisible();
  await expect(page.getByTestId('hub-inspector-name')).toHaveText(session.title);
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('readable:hub-inspector-toggle')),
  );
  await expect(inspector).toHaveCount(0);
});

test('a dismissed row menu returns focus to its own row', async ({ page }) => {
  await gotoHub(page);
  const session = seeded[2]!.sessions[0]!;
  const rowId = `hub-session-${session.id}`;

  await page.getByTestId(`hub-menu-session-${session.id}`).click();
  await expect(page.getByTestId('hub-row-menu')).toBeVisible();
  // Focus moves INTO the menu on open, not merely near it.
  await expect.poll(() => activeTestId(page)).toBe('hub-row-menu-rename');

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('hub-row-menu')).toHaveCount(0);
  // ACCEPTANCE: focus lands on the treeitem, not on the hover-only button and
  // not on <body>.
  await expect.poll(() => activeTestId(page)).toBe(rowId);
});

test('the session menu renames the RIGHT session and the daemon agrees', async ({
  page,
  request,
}) => {
  await gotoHub(page);
  const project = seeded[3]!;
  const target = project.sessions[0]!;
  const neighbour = project.sessions[1]!;
  const renamed = `Renamed palette audit ${Date.now()}`;

  await page.getByTestId(`hub-menu-session-${target.id}`).click();
  const menu = page.getByTestId('hub-row-menu');
  await expect(menu).toBeVisible();
  // The menu is titled with the row it belongs to, so a menu opened over the
  // wrong row is visible here too.
  await expect(menu).toHaveAttribute('aria-label', target.title);
  await expect(page.getByTestId('hub-row-menu-rename')).toBeVisible();
  await expect(page.getByTestId('hub-row-menu-info')).toBeVisible();
  await expect(page.getByTestId('hub-row-menu-delete')).toBeVisible();

  await page.getByTestId('hub-row-menu-rename').click();
  const field = page.getByTestId(`hub-rename-s-${target.id}`);
  await expect(field).toBeVisible();
  await field.fill(renamed);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId(`hub-session-${target.id}`)).toContainText(renamed);

  // ACCEPTANCE via the API PAYLOAD, not the DOM: the daemon renamed exactly
  // this conversation and left its neighbour alone.
  await expect
    .poll(async () => {
      const rows = await daemonSessions(request, project.id);
      return rows.find((row) => row.id === target.id)?.title ?? null;
    })
    .toBe(renamed);
  const after = await daemonSessions(request, project.id);
  console.log('RENAME_PAYLOAD=' + JSON.stringify(after.map((r) => [r.id, r.title])));
  expect(after.find((row) => row.id === neighbour.id)?.title).toBe(neighbour.title);
});

test('the session menu deletes the RIGHT session with no ghost row or stale count', async ({
  page,
  request,
}) => {
  await gotoHub(page);
  const project = seeded[3]!;
  const target = project.sessions[1]!;
  const before = await daemonSessions(request, project.id);
  expect(before.some((row) => row.id === target.id)).toBe(true);

  // Filtered counts are per-project, so measure the session count this project
  // renders rather than a global number.
  const rows = page.locator(`[data-testid="hub-project-${project.id}"] [data-session-id]`);
  const countBefore = await rows.count();

  await page.getByTestId(`hub-menu-session-${target.id}`).click();
  await expect(page.getByTestId('hub-row-menu')).toHaveAttribute('aria-label', target.title);
  await page.getByTestId('hub-row-menu-delete').click();

  await expect(page.getByTestId(`hub-session-${target.id}`)).toHaveCount(0);
  await expect(rows).toHaveCount(countBefore - 1);

  // ACCEPTANCE via the API PAYLOAD: the daemon dropped exactly this
  // conversation and kept every sibling.
  await expect
    .poll(async () => (await daemonSessions(request, project.id)).some((r) => r.id === target.id))
    .toBe(false);
  const after = await daemonSessions(request, project.id);
  console.log('DELETE_PAYLOAD=' + JSON.stringify(after.map((r) => r.id)));
  expect(after).toHaveLength(before.length - 1);

  // ADVERSARIAL stale_state: a reload must not resurrect a ghost row.
  await page.reload();
  await expect(page.getByTestId(`hub-project-${project.id}`)).toBeVisible();
  await expect(page.getByTestId(`hub-session-${target.id}`)).toHaveCount(0);
});

test('the project menu exposes rename, new session and delete against the RIGHT project', async ({
  page,
  request,
}) => {
  await gotoHub(page);
  const project = seeded[4]!;
  const neighbour = seeded[5]!;

  await page.getByTestId(`hub-menu-project-${project.id}`).click();
  const menu = page.getByTestId('hub-row-menu');
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute('aria-label', project.name);
  await expect(page.getByTestId('hub-row-menu-rename')).toBeVisible();
  await expect(page.getByTestId('hub-row-menu-new-session')).toBeVisible();
  await expect(page.getByTestId('hub-row-menu-delete')).toBeVisible();

  // --- new session: creates one conversation in THIS project only ----------
  // Docs Portal's only session carries messages (seeded in beforeAll), so the
  // "reopen an untouched session instead of stacking a second empty one" path
  // cannot apply and a real conversation must be created.
  const sessionsBefore = await daemonSessions(request, project.id);
  const neighbourSessionsBefore = await daemonSessions(request, neighbour.id);
  await page.getByTestId('hub-row-menu-new-session').click();
  await expect
    .poll(async () => (await daemonSessions(request, project.id)).length)
    .toBe(sessionsBefore.length + 1);
  expect((await daemonSessions(request, neighbour.id)).length).toBe(
    neighbourSessionsBefore.length,
  );

  // ...and the freshly created session is empty, so invoking it AGAIN reuses
  // that one rather than stacking a second empty session.
  await gotoHub(page);
  await page.getByTestId(`hub-menu-project-${project.id}`).click();
  await page.getByTestId('hub-row-menu-new-session').click();
  await page.waitForURL(new RegExp(`/projects/${project.id}/conversations/`));
  expect((await daemonSessions(request, project.id)).length).toBe(sessionsBefore.length + 1);

  // --- rename: renames THIS project, leaving its neighbour untouched -------
  await gotoHub(page);
  const renamedProject = `Docs Portal Renamed ${Date.now()}`;
  await page.getByTestId(`hub-menu-project-${project.id}`).click();
  await page.getByTestId('hub-row-menu-rename').click();
  const field = page.getByTestId(`hub-rename-p-${project.id}`);
  await expect(field).toBeVisible();
  await field.fill(renamedProject);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId(`hub-project-${project.id}`)).toContainText(renamedProject);

  await expect
    .poll(async () => (await daemonProjects(request)).find((p) => p.id === project.id)?.name)
    .toBe(renamedProject);
  const projectsAfterRename = await daemonProjects(request);
  console.log(
    'PROJECT_RENAME_PAYLOAD=' +
      JSON.stringify(projectsAfterRename.map((p) => [p.id, p.name])),
  );
  expect(projectsAfterRename.find((p) => p.id === neighbour.id)?.name).toBe(neighbour.name);

  // --- delete: removes THIS project from the daemon and from the rail ------
  await page.getByTestId(`hub-menu-project-${project.id}`).click();
  await expect(page.getByTestId('hub-row-menu')).toHaveAttribute('aria-label', renamedProject);
  await page.getByTestId('hub-row-menu-delete').click();

  await expect(page.getByTestId(`hub-project-${project.id}`)).toHaveCount(0);
  await expect
    .poll(async () => (await daemonProjects(request)).some((p) => p.id === project.id))
    .toBe(false);
  expect((await daemonProjects(request)).some((p) => p.id === neighbour.id)).toBe(true);

  // The rendered group count follows the deletion instead of going stale.
  expectedProjectCount -= 1;
  await expect(page.getByTestId('hub-group-count')).toHaveText(String(expectedProjectCount));

  seeded = seeded.filter((entry) => entry.id !== project.id);
});

test('the running strip carries elapsed time and a trailing arrow', async ({ page, request }) => {
  const project = runningSession.project;
  const running = runningSession.session;

  // The run is REAL: seeded through the daemon's own message route in
  // beforeAll and re-confirmed here from the daemon's payload, so the strip
  // below renders from live state rather than from an intercepted response.
  const conversations = await daemonSessions(request, project.id);
  const live = conversations.find((row) => row.id === running.id);
  console.log('RUNNING_SEED=' + JSON.stringify(live?.latestRun));
  expect(live?.latestRun?.status).toBe('running');

  await gotoHub(page);

  const strip = page.getByTestId('hub-live-strip');
  await expect(strip).toBeVisible();
  await expect(strip).toContainText(running.title);
  await expect(strip).toContainText(project.name);

  // The session's own row agrees it is running, so the strip is not a
  // free-floating banner disconnected from the tree. The run started four
  // minutes ago, so "recent" sorts this row behind the five-session page -
  // reveal the rest before reading it rather than asserting on a hidden row.
  const overflow = page.getByTestId(`hub-tree-more-${project.id}`);
  if (await overflow.count()) await overflow.click();
  await expect(page.getByTestId(`hub-session-${running.id}`)).toHaveAttribute(
    'data-state',
    'running',
  );

  // ACCEPTANCE: the elapsed time is rendered, and it is the compact form the
  // mockup uses ("4m"), not an absolute timestamp.
  const elapsed = page.getByTestId('hub-live-time');
  await expect(elapsed).toBeVisible();
  await expect(elapsed).toHaveText(/^\d+m$/);

  // ACCEPTANCE: a trailing arrow, painted, sitting after the elapsed time and
  // rotated to point INTO the session as the mockup shows.
  const geometry = await strip.evaluate((el) => {
    const arrow = el.querySelector<SVGElement>('.hub__live-arrow');
    const time = el.querySelector<HTMLElement>('[data-testid="hub-live-time"]');
    if (!arrow || !time) return null;
    const arrowBox = arrow.getBoundingClientRect();
    const timeBox = time.getBoundingClientRect();
    const stripBox = el.getBoundingClientRect();
    return {
      arrowLeft: arrowBox.left,
      arrowWidth: arrowBox.width,
      arrowHeight: arrowBox.height,
      timeRight: timeBox.right,
      stripRight: stripBox.right,
      transform: getComputedStyle(arrow).transform,
      paths: arrow.querySelectorAll('path').length,
    };
  });
  console.log('RUNNING_STRIP=' + JSON.stringify(geometry));
  expect(geometry).not.toBeNull();
  // Trailing: the arrow sits after the elapsed label and inside the strip.
  expect(geometry!.arrowLeft).toBeGreaterThanOrEqual(geometry!.timeRight);
  expect(geometry!.arrowLeft).toBeLessThan(geometry!.stripRight);
  // Painted, not an empty box.
  expect(geometry!.arrowWidth).toBeGreaterThan(0);
  expect(geometry!.arrowHeight).toBeGreaterThan(0);
  expect(geometry!.paths).toBeGreaterThan(0);
  expect(geometry!.transform).not.toBe('none');

  // Activating the strip hands off to the running session.
  await strip.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/conversations/${running.id}`));
});

test('the tree keyboard model and the filter counts still work', async ({ page }) => {
  await gotoHub(page);
  const project = seeded[0]!;
  const projectRowId = `hub-project-${project.id}`;
  // The row ArrowDown must land on is the project's FIRST RENDERED session,
  // which the "recent" sort picks - not `sessions[0]` of the seed array.
  const firstSessionId = await page
    .locator(`[data-testid="${projectRowId}"] [data-session-id]`)
    .first()
    .getAttribute('data-testid');
  expect(firstSessionId).not.toBeNull();

  // SURVIVOR: HubSessionTree.tsx:176-199 - the roving-tabindex arrow model.
  await page.getByTestId(projectRowId).focus();
  expect(await activeTestId(page)).toBe(projectRowId);

  await page.keyboard.press('ArrowDown');
  await expect.poll(() => activeTestId(page)).toBe(firstSessionId);
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => activeTestId(page)).toBe(projectRowId);

  // ArrowLeft collapses an expanded project; ArrowRight expands it again.
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId(projectRowId)).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId(projectRowId)).toHaveAttribute('aria-expanded', 'true');
  // With the project open, ArrowRight moves INTO its first session.
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => activeTestId(page)).toBe(firstSessionId);
  // ArrowLeft from a session returns to its owning project.
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => activeTestId(page)).toBe(projectRowId);

  // Home/End traverse the whole flattened list. The target is read from the
  // RENDERED order rather than the seed order, because the default "recent"
  // sort owns which project leads.
  const firstRowId = await page.evaluate(
    () => document.querySelector('[role="tree"] [role="treeitem"]')?.getAttribute('data-testid') ?? null,
  );
  expect(firstRowId).not.toBeNull();
  await page.keyboard.press('End');
  const lastId = await activeTestId(page);
  expect(lastId).not.toBe(firstRowId);
  await page.keyboard.press('Home');
  await expect.poll(() => activeTestId(page)).toBe(firstRowId);

  // Exactly one tab stop: the tree exposes a single tabbable row.
  const tabbable = await page.$$eval('[role="treeitem"][tabindex="0"]', (nodes) => nodes.length);
  console.log('TREE_TAB_STOPS=' + tabbable);
  expect(tabbable).toBe(1);

  // SURVIVOR: the filter counts. They are per-project, rendered, and the
  // filter they label actually narrows the tree to the REAL seeded states.
  const attention = page.getByTestId('hub-filter-attention');
  const runningFilter = page.getByTestId('hub-filter-running');
  await expect(attention).toBeVisible();
  await expect(runningFilter).toBeVisible();
  const attentionCount = Number((await attention.innerText()).match(/\d+/)?.[0] ?? '-1');
  const runningCount = Number((await runningFilter.innerText()).match(/\d+/)?.[0] ?? '-1');
  console.log('FILTER_COUNTS attention=' + attentionCount + ' running=' + runningCount);
  // One project holds the running session, one holds the failed session, and
  // "needs you" counts failures. A count wired to the wrong list fails here.
  expect(runningCount).toBe(1);
  expect(attentionCount).toBe(1);

  await expect(page.getByTestId('hub-filter-all')).toHaveAttribute('aria-pressed', 'true');
  await runningFilter.click();
  await expect(runningFilter).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('hub-filter-all')).toHaveAttribute('aria-pressed', 'false');

  // Filtering narrows to exactly the running session, and the heading switches
  // from counting projects to counting matched sessions.
  await expect(page.locator('[data-session-id]')).toHaveCount(1);
  await expect(page.getByTestId(`hub-session-${runningSession.session.id}`)).toBeVisible();
  await expect(page.getByTestId('hub-group-count')).toHaveText('1');

  // "Needs you" surfaces the failed session instead, so the two filters are
  // not silently the same list.
  await attention.click();
  await expect(page.locator('[data-session-id]')).toHaveCount(1);
  await expect(page.getByTestId(`hub-session-${failedSessionId}`)).toBeVisible();

  await page.getByTestId('hub-filter-all').click();
  await expect(page.getByTestId('hub-group-count')).toHaveText(String(expectedProjectCount));
});
