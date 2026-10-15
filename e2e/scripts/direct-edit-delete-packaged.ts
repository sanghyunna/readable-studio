import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { HiddenLaunchError, launchHiddenDesktop, type HiddenDesktop } from '../lib/packaged-hidden-desktop.ts';
import {
  assertNativeDelete, captureDeleteWrites, deleteFrame, deletePreview,
  enterDeleteEditMode, focusDeleteOwner, runDeleteJourney, selectDeleteTarget,
} from '../lib/playwright/direct-edit-delete.ts';
import { T } from '../lib/timeouts.ts';
import { captureProcesses, daemonUrlFromProcesses, runCli } from './portable-qa-runtime.ts';
import { runCommand, validateEvidenceRoot, workspaceRoot } from './portable-qa-support.ts';

export type PackagedDeleteOptions = { zipPath: string; namespace: string; evidenceRoot: string; journeys?: string[] };

const journeyNames = ['host-save', 'host-discard', 'iframe-save', 'iframe-discard',
  'iframe-save-no-pending-color', 'deck-slide-preservation', 'native-input-textarea-inline-ime',
  'protected-last-body-child', 'narrow-viewport'];

/** The portable ZIP nests the real app under app\; older layouts keep it at the root. */
export async function resolvePackagedAppRoot(extractRoot: string): Promise<string> {
  const marker = ['resources', 'readable-studio', 'bin', 'node.exe'];
  for (const root of [join(extractRoot, 'app'), extractRoot]) {
    if (await stat(join(root, ...marker)).then((entry) => entry.isFile(), () => false)) return root;
  }
  throw new Error(`No bundled node.exe found under ${extractRoot} (checked app\\ and root)`);
}

export async function parsePackagedDeleteOptions(argv: readonly string[]): Promise<PackagedDeleteOptions> {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key || !['--zip', '--namespace', '--evidence', '--journeys'].includes(key)) throw new Error(`Unknown argument: ${key}`);
    if (!value || value.startsWith('--') || args.has(key)) throw new Error(`Invalid value for ${key}`);
    args.set(key, value);
  }
  const zip = args.get('--zip');
  const namespace = args.get('--namespace');
  const evidence = args.get('--evidence');
  if (!zip || !namespace || !evidence) throw new Error('--zip, --namespace and --evidence are required');
  const zipPath = resolve(zip);
  if (!(await stat(zipPath)).isFile()) throw new Error('ZIP input must be a file');
  if (!zipPath.toLowerCase().endsWith('.zip')) throw new Error('ZIP input must have a .zip extension');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,70}$/.test(namespace)) throw new Error('Invalid namespace');
  const evidenceRoot = resolve(evidence);
  validateEvidenceRoot(evidenceRoot);
  const journeys = args.get('--journeys')?.split(',').map(name => name.trim());
  if (journeys?.some(name => !journeyNames.includes(name))) throw new Error('Unknown journey in --journeys');
  return { zipPath, namespace, evidenceRoot, ...(journeys ? { journeys } : {}) };
}

async function freeDebugPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  return address.port;
}

export const packagedFileRoute = (projectId: string, fileName: string) =>
  `/projects/${projectId}/files/${encodeURIComponent(fileName)}`;

/** Open one artifact by its own file route, independent of whatever the previous journey left on screen. */
async function openArtifact(page: Page, projectId: string, fileName: string) {
  // A journey must leave edit mode; guard so a stray session never blocks navigation.
  const discard = page.getByRole('button', { name: 'Discard changes', exact: true });
  if (await discard.isVisible().catch(() => false)) {
    await discard.click();
    await expect(page.locator('.manual-edit-left-inspector')).toHaveCount(0, { timeout: T.medium });
  }
  // Leave the project first so the project view reloads its file list (the new file was just seeded).
  await page.evaluate(() => {
    history.pushState(null, '', '/');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await page.evaluate(path => {
    history.pushState(null, '', path);
    dispatchEvent(new PopStateEvent('popstate'));
  }, packagedFileRoute(projectId, fileName));
  const escapedName = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const namePattern = new RegExp(escapedName);
  await expect(page.getByRole('tab', { name: namePattern }).first()).toBeVisible({ timeout: T.long });
  await page.getByRole('tab', { name: namePattern }).first().click();
  await expect(deletePreview(page)).toBeVisible({ timeout: T.long });
}

const imageSource = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path fill="#fa0" d="M0 0h24v24H0z"/></svg>';
const htmlSource = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="assets/css/proof.css"></head>
<body style="margin:0;font-family:Arial"><h1>Delete verifier</h1>
<div class="linked-proof" style="height:80px">Linked stylesheet</div><img class="linked-image" src="assets/images/pattern.svg">
<input aria-label="Native input" value="Native"><textarea aria-label="Native textarea">Native</textarea>
<div style="height:1400px"></div><a class="delete-object" href="#proof" style="display:block;padding:24px">Delete this link</a>
<p class="survivor">Keep this sibling</p><div style="height:1400px"></div></body></html>`;

export async function runPackagedDelete(options: PackagedDeleteOptions) {
  await mkdir(options.evidenceRoot, { recursive: true });
  const scratchBase = join(workspaceRoot, '.tmp/direct-edit-delete/r1/w');
  await mkdir(scratchBase, { recursive: true });
  const scratch = await mkdtemp(join(scratchBase, 'packaged-'));
  const executablePath = join(scratch, 'Readable Studio.exe');
  const results: Array<{ name: string; passed: boolean; error: string | null; writes: string[];
    scrollBefore: { x: number; y: number } | null; scrollAfter: { x: number; y: number } | null;
    slide: string | null; screenshots: string[]; details?: unknown }> = [];
  const commands: unknown[] = [];
  let runtime: HiddenDesktop | undefined;
  let failure: unknown;
  let cleanup: unknown;
  let lifecycle: unknown;
  let sourceManifest: unknown;
  try {
    const zipSha256 = createHash('sha256').update(await readFile(options.zipPath)).digest('hex');
    const extraction = await runCommand(join(workspaceRoot, 'tools/pack/resources/win/7zip/7z.exe'),
      ['x', options.zipPath, `-o${scratch}`, '-y']);
    commands.push(extraction);
    assert.equal(extraction.exitCode, 0, extraction.stderr);
    assert.ok((await stat(executablePath)).isFile());
    sourceManifest = { zipPath: options.zipPath, zipSha256, executablePath,
      executableSha256: createHash('sha256').update(await readFile(executablePath)).digest('hex') };
    runtime = await launchHiddenDesktop({ executablePath, namespace: options.namespace, debugPort: await freeDebugPort() });
    const { page } = runtime;
    assert.match(page.url(), /^readable-studio:\/\/app\//);
    assert.equal(runtime.inputDesktopBefore, runtime.inputDesktopAfter);
    assert.notEqual(runtime.desktopName, runtime.inputDesktopBefore);
    const processes = await captureProcesses(runtime.rootPid);
    const windowsBefore = await runtime.inspectWindows();
    assert.ok(windowsBefore.privateWindowPids.length > 0);
    assert.deepEqual(windowsBefore.activeOwnedWindowPids, []);
    const daemonUrl = daemonUrlFromProcesses(processes);
    const dataRoot = join(scratch, 'ReadableStudioData/namespaces', options.namespace, 'data');
    lifecycle = { rootPid: runtime.rootPid, hostPid: runtime.hostPid, desktop: runtime.desktopName,
      inputBefore: runtime.inputDesktopBefore, inputAfter: runtime.inputDesktopAfter,
      cdpEndpoint: runtime.cdpEndpoint, pageUrl: page.url(), dataRoot, processes, windowsBefore };
    // Initialize the isolated profile through the same config endpoint as UI.
    const configured = await page.request.put(`${daemonUrl}/api/app-config`, { data: {
      onboardingCompleted: true, privacyDecisionAt: 1,
      telemetry: { metrics: false, content: false, artifactManifest: false },
    } });
    assert.ok(configured.ok(), `Config setup returned ${configured.status()}`);
    await page.evaluate(() => {
      localStorage.setItem('readable-studio:welcome-modal-shown', '1');
      localStorage.setItem('readable-studio:locale', 'en');
      localStorage.setItem('readable-studio:locale-source', 'manual');
      localStorage.setItem('readable-studio:config', JSON.stringify({ onboardingCompleted: true,
        privacyDecisionAt: 1, telemetry: { metrics: false, content: false, artifactManifest: false } }));
    });
    await page.reload();
    await page.locator('html[data-readable-app-mounted="1"]').waitFor({ state: 'attached', timeout: T.xlong });
    await page.locator('.readable-loading-shell').waitFor({ state: 'hidden', timeout: T.xlong });
    const created = await runCli(await resolvePackagedAppRoot(scratch), ['project', 'create', '--name', 'Hidden Delete QA', '--json'], daemonUrl);
    commands.push(created);
    const projectId: string = JSON.parse(created.stdout).project.id;
    assert.ok(projectId);
    const seed = async (name: string, content: string, kind?: 'html' | 'deck') => {
      const response = await page.request.post(`${daemonUrl}/api/projects/${projectId}/files`, {
        data: { name, content, ...(kind ? { artifactManifest: { schema: 'readable-studio.artifact-manifest.v1',
          kind, title: name, entry: name, renderer: kind === 'deck' ? 'deck-html' : 'html', exports: ['html'] } } : {}) },
      });
      assert.ok(response.ok(), `${name}: seed returned ${response.status()}: ${await response.text()}`);
    };
    await seed('assets/images/pattern.svg', imageSource);
    await seed('assets/css/proof.css', '.linked-proof{background-color:rgb(12,34,56);background-image:url("../images/pattern.svg")}');
    const journey = async (name: string, fileName: string, source: string, kind: 'html' | 'deck',
      action: (shot: (state: string) => Promise<void>, evidence: typeof results[number]) => Promise<unknown>,
      slide: string | null = null, baseName = name) => {
      if (options.journeys && !options.journeys.includes(baseName)) return;
      const result: typeof results[number] = { name, passed: false, error: null, writes: [],
        scrollBefore: null, scrollAfter: null, slide, screenshots: [] };
      let capture: ReturnType<typeof captureDeleteWrites> | undefined;
      const shot = async (state: string) => {
        const path = join(options.evidenceRoot, `${name}-${state}.png`);
        await page.screenshot({ path, fullPage: true });
        result.screenshots.push(path);
      };
      try {
        await seed(fileName, source, kind);
        capture = captureDeleteWrites(page, projectId);
        await openArtifact(page, projectId, fileName);
        await shot('entry');
        result.details = await action(shot, result);
        result.passed = true;
      } catch (error) {
        result.error = error instanceof Error ? error.stack ?? error.message : String(error);
        await shot('failure').catch(() => {});
      } finally {
        if (capture) { result.writes = [...capture.writes]; capture.stop(); }
        results.push(result);
        console.log(JSON.stringify({ journey: name, passed: result.passed, writes: result.writes.length, error: result.error }));
      }
    };
    for (const { owner, finish, pendingColor, name } of [
      { owner: 'host', finish: 'save', pendingColor: 'rgb(239, 68, 68)', name: 'host-save' },
      { owner: 'host', finish: 'discard', pendingColor: undefined, name: 'host-discard' },
      { owner: 'iframe', finish: 'save', pendingColor: 'rgb(239, 68, 68)', name: 'iframe-save' },
      { owner: 'iframe', finish: 'discard', pendingColor: undefined, name: 'iframe-discard' },
      { owner: 'iframe', finish: 'save', pendingColor: undefined, name: 'iframe-save-no-pending-color' },
    ] as const) {
      const repeats = options.journeys ? options.journeys.filter(item => item === name).length : 1;
      for (let repetition = 1; repetition <= repeats; repetition++) {
        const runName = repeats > 1 ? `${name}-${repetition}` : name;
        const fileName = `${runName}.html`;
        await journey(runName, fileName, htmlSource, 'html', async (shot, evidence) => {
        const sourcePath = join(dataRoot, 'projects', projectId, fileName);
        const originalSource = await readFile(sourcePath, 'utf8');
        assert.equal(originalSource, htmlSource);
        return runDeleteJourney({
          page, owner, finish, linked: true, scroll: true,
          ...(pendingColor ? { pendingColor } : {}),
          fixture: { projectId, fileName, targetSelector: '.delete-object', survivorSelector: '.survivor',
            originalSource, readSource: () => readFile(sourcePath, 'utf8') },
          screenshot: shot, evidence,
        });
        }, null, name);
      }
    }
    // The second slide uses the real deck framework, not a mocked slide index.
    const template = await readFile(join(workspaceRoot, 'templates/deck-framework.html'), 'utf8');
    const deck = template.replace('<!-- SLOT: deck title -->', 'Delete slide context')
      .replace('<!-- SLOT: slide 1 content -->', '<h1>First slide</h1>')
      .replace('<!-- SLOT: slide 2 content -->', '<h1 class="delete-object">Delete slide title</h1><p class="survivor">Keep slide sibling</p>');
    await journey('deck-slide-preservation', 'context-deck.html', deck, 'deck', async (shot, evidence) => {
    await page.getByLabel('Next slide', { exact: true }).click();
    await expect(deleteFrame(page).locator('#deck-cur')).toHaveText('02');
    const deckPath = join(dataRoot, 'projects', projectId, 'context-deck.html');
    return runDeleteJourney({ page, owner: 'iframe', finish: 'discard', slide: '02',
      fixture: { projectId, fileName: 'context-deck.html', targetSelector: '.delete-object', survivorSelector: '.survivor',
        originalSource: deck, readSource: () => readFile(deckPath, 'utf8') },
      screenshot: shot, evidence,
    });
    }, '02');
    await journey('native-input-textarea-inline-ime', 'native.html', htmlSource, 'html', async (shot) => {
    const nativeWrites = captureDeleteWrites(page, projectId);
    try {
      await enterDeleteEditMode(page);
      await deleteFrame(page).locator('.delete-object').scrollIntoViewIfNeeded();
      await selectDeleteTarget(page, '.delete-object', 'iframe');
      for (const selector of ['input', 'textarea']) {
        const control = deleteFrame(page).locator(selector);
        await control.focus();
        await page.keyboard.press('Home');
        await page.keyboard.press('Delete');
        await expect(control).toHaveValue('ative');
        await expect(deleteFrame(page).locator('.delete-object')).toHaveCount(1);
      }
      await focusDeleteOwner(page, 'iframe');
      const nativeIme = await deleteFrame(page).locator('body').evaluate(body => {
        const event = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true, isComposing: true });
        body.dispatchEvent(event);
        return { prevented: event.defaultPrevented, remaining: body.querySelectorAll('.delete-object').length };
      });
      expect(nativeIme).toEqual({ prevented: false, remaining: 1 });
      await assertNativeDelete(page, '.delete-object');
      await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
      await expect(page.locator('.manual-edit-left-inspector')).toHaveCount(0);
      expect(nativeWrites.writes).toHaveLength(0);
      expect(await readFile(join(dataRoot, 'projects', projectId, 'native.html'), 'utf8')).toBe(htmlSource);
      await shot('discard');
      return { nativeIme };
    } finally { nativeWrites.stop(); }
    });
    const protectedSource = '<!doctype html><html><body><p class="protected">Only body child</p></body></html>';
    await journey('protected-last-body-child', 'protected.html', protectedSource, 'html', async (shot) => {
    const protectedWrites = captureDeleteWrites(page, projectId);
    try {
      await enterDeleteEditMode(page);
      await selectDeleteTarget(page, '.protected', 'host');
      await page.keyboard.press('Delete');
      await expect(page.locator('.manual-edit-left-inspector').getByRole('alert'))
        .toHaveText('Could not apply this edit. Check the value and try again.');
      await expect(deleteFrame(page).locator('.protected')).toHaveCount(1);
      expect(protectedWrites.writes).toHaveLength(0);
      expect(await readFile(join(dataRoot, 'projects', projectId, 'protected.html'), 'utf8')).toBe(protectedSource);
      await shot('rejected');
    } finally { protectedWrites.stop(); }
    });
    // CDP viewport emulation changes only the hidden renderer.
    await journey('narrow-viewport', 'narrow.html', htmlSource, 'html', async (shot) => {
    await page.setViewportSize({ width: 720, height: 900 });
    await enterDeleteEditMode(page);
    await shot('narrow');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow).toBe(false);
    return { overflow };
    });
    const windowsAfter = await runtime.inspectWindows();
    assert.equal(windowsAfter.inputDesktop, runtime.inputDesktopBefore);
    assert.deepEqual(windowsAfter.activeOwnedWindowPids, []);
    lifecycle = { ...lifecycle as object, windowsAfter };
    if (results.some(result => !result.passed)) failure = new Error('One or more packaged Delete journeys failed');
  } catch (error) {
    failure = error;
    if (runtime) await runtime.page.screenshot({ path: join(options.evidenceRoot, 'failure.png'), fullPage: true }).catch(() => {});
  } finally {
    try { cleanup = runtime ? await runtime.close() : failure instanceof HiddenLaunchError ? failure.cleanup : undefined; }
    catch (error) { failure ??= error; cleanup = { error: String(error) }; }
    await writeFile(join(options.evidenceRoot, 'receipt.json'), JSON.stringify({
      status: failure ? 'failed' : 'passed', sourceManifest, lifecycle, commands, results, cleanup,
      passedChecks: results.filter(result => result.passed).length,
      failedChecks: results.filter(result => !result.passed).length || (failure ? 1 : 0),
      error: failure instanceof Error ? failure.stack : failure,
      logs: runtime?.logs ?? (failure instanceof HiddenLaunchError ? failure.logs : undefined),
    }, null, 2));
    await writeFile(options.journeys ? join(options.evidenceRoot, 'rerun.json')
      : join(options.evidenceRoot, '..', 'f5-all.json'), JSON.stringify({
      zipSha256: (sourceManifest as { zipSha256?: string } | undefined)?.zipSha256,
      journeys: results,
      ...(options.journeys ? { requestedJourneys: options.journeys,
        passedChecks: results.filter(result => result.passed).length,
        failedChecks: results.filter(result => !result.passed).length || (failure ? 1 : 0),
        rootPid: runtime?.rootPid, hostPid: runtime?.hostPid } : {}),
      focus: { inputBefore: (lifecycle as { inputBefore?: string } | undefined)?.inputBefore,
        inputAfter: (cleanup as { inputDesktop?: string } | undefined)?.inputDesktop },
      cleanup,
    }, null, 2));
    await rm(scratch, { recursive: true, force: true });
  }
  if (failure) throw failure;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  parsePackagedDeleteOptions(process.argv.slice(2)).then(runPackagedDelete).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
