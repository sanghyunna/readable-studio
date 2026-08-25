import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium, type ElectronApplication, type Page } from '@playwright/test';

import type { FullRunResult } from '../lib/portable-qa-evidence.ts';
import { runManualEditTransactions } from '../lib/portable-qa-manual-edit.ts';
import {
  assertPortableBoundaries,
  captureProcesses,
  closePortable,
  daemonUrlFromProcesses,
  extractPortable,
  launchPortable,
  registrySnapshot,
  runCli,
  type AppCapture,
  type NetworkTrap,
} from './portable-qa-runtime.ts';
import {
  canonicalProductName,
  toRecord,
  writeEvidence,
  type Options,
} from './portable-qa-support.ts';

function projectIdFromCreate(text: string): string {
  const payload = toRecord(JSON.parse(text), 'project create JSON');
  const project = toRecord(payload.project, 'project create project');
  const id = project.id;
  if (typeof id !== 'string' || id.length === 0) throw new Error('project create JSON has no project id');
  return id;
}

type DeckSeed = {
  readonly daemonUrl: string;
  readonly evidenceRoot: string;
  readonly extractionRoot: string;
  readonly projectId: string;
};

async function seedDeck(input: DeckSeed): Promise<void> {
  const sourcePath = join(input.evidenceRoot, 'portable-deck-source.html');
  const manifestPath = join(input.evidenceRoot, 'portable-deck-manifest.json');
  await writeFile(sourcePath, `<!doctype html><html><head><meta charset="utf-8"><title>Portable Deck</title></head><body style="font-family:Arial,sans-serif"><section class="slide"><h1 data-readable-id="task30-title" data-readable-label="Title">Portable Original</h1><p data-readable-id="task30-copy">Editable deck object</p></section></body></html>`, 'utf8');
  await writeFile(manifestPath, `${JSON.stringify({ schema: 'readable-studio.artifact-manifest.v1', kind: 'deck', title: 'Portable Deck', entry: 'portable-deck.html', renderer: 'deck-html', exports: ['html', 'pptx'] })}\n`, 'utf8');
  await runCli(input.extractionRoot, [
    'artifacts', 'create', '--name', 'portable-deck.html', '--input', sourcePath,
    '--manifest', manifestPath, '--project', input.projectId,
  ], input.daemonUrl);
}

type DeckSession = DeckSeed & { readonly electronApp: ElectronApplication; readonly page: Page };

function projectFilePath(input: DeckSession): string {
  return join(
    input.extractionRoot,
    'ReadableStudioData',
    'namespaces',
    'task30-a',
    'data',
    'projects',
    input.projectId,
    'portable-deck.html',
  );
}

async function editDeckAndExport(input: DeckSession) {
  const manualEdit = await runManualEditTransactions({
    daemonUrl: input.daemonUrl,
    electronApp: input.electronApp,
    evidenceRoot: input.evidenceRoot,
    page: input.page,
    projectId: input.projectId,
    sourcePath: projectFilePath(input),
  });
  const exportPath = join(input.evidenceRoot, 'portable-deck-standalone.html');
  await runCli(input.extractionRoot, [
    'export', 'html', '--project', input.projectId, '--file', 'portable-deck.html',
    '--output', exportPath, '--force', '--json',
  ], input.daemonUrl);
  const exported = await readFile(exportPath, 'utf8');
  assert.match(exported, /Portable Edited/u);
  assert.match(exported, /font-size:\s*44px/u);
  assert.match(exported, /rgb\(37,\s*99,\s*235\)/u);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.setOffline(true);
    const independent = await context.newPage();
    await independent.goto(pathToFileURL(exportPath).href);
    await independent.getByText('Portable Edited', { exact: true }).waitFor({ state: 'visible' });
    await independent.screenshot({ path: join(input.evidenceRoot, 'standalone-independent.png'), fullPage: true });
  } finally {
    await browser.close();
  }
  return { ...manualEdit, exportPath };
}

async function finishColdStart(page: Page): Promise<void> {
  const skip = page.getByRole('button', { name: /Skip for now/i });
  if (await skip.isVisible()) await skip.click();
  const privacyDialog = page.getByRole('dialog').filter({ hasText: /improve Readable Studio/i });
  if (await privacyDialog.isVisible()) {
    await privacyDialog.getByRole('button', { name: /not now|got it|don't share/i }).click();
  }
  await page.getByTestId('home-hero').waitFor({ state: 'visible', timeout: 30_000 });
}

export async function runFull(options: Options, extractionRoot: string, trap: NetworkTrap): Promise<FullRunResult> {
  const registryBefore = await registrySnapshot();
  const primary = await launchPortable(extractionRoot, 'task30-a', trap, options.offline);
  let secondary: AppCapture | null = null;
  let secondaryRoot: string | null = null;
  try {
    assert.equal(await primary.page.title(), canonicalProductName);
    await primary.page.screenshot({ path: join(options.evidenceRoot, 'cold-start.png'), fullPage: true });
    process.stdout.write('[portable-qa] cold start ready\n');
    const primaryPid = primary.app.process().pid;
    assert.ok(primaryPid != null, 'Electron root PID is unavailable');
    const primaryProcesses = await captureProcesses(primaryPid);
    const daemonUrl = daemonUrlFromProcesses(primaryProcesses);

    const help = await runCli(extractionRoot, ['--help']);
    assert.match(help.stdout, /Readable Studio/u);
    const created = await runCli(extractionRoot, ['project', 'create', '--name', 'Task30 CLI Deck', '--json'], daemonUrl);
    const projectId = projectIdFromCreate(created.stdout);
    const pluginList = await runCli(extractionRoot, ['plugin', 'list', '--bundled', '--json'], daemonUrl);
    assert.match(pluginList.stdout, /example-simple-deck/u);
    const pluginApply = await runCli(extractionRoot, ['plugin', 'apply', 'example-simple-deck', '--inputs', '{}', '--json'], daemonUrl);
    const applied = toRecord(JSON.parse(pluginApply.stdout), 'plugin apply JSON');
    const appliedPlugin = toRecord(applied.appliedPlugin, 'plugin apply snapshot');
    assert.equal(typeof appliedPlugin.snapshotId, 'string', 'bundled plugin apply did not generate a snapshot');
    process.stdout.write('[portable-qa] CLI and bundled plugin ready\n');

    await seedDeck({ daemonUrl, evidenceRoot: options.evidenceRoot, extractionRoot, projectId });
    await finishColdStart(primary.page);
    const workflow = await editDeckAndExport({
      daemonUrl,
      electronApp: primary.app,
      evidenceRoot: options.evidenceRoot,
      extractionRoot,
      page: primary.page,
      projectId,
    });
    const { exportPath } = workflow;
    await primary.page.screenshot({ path: join(options.evidenceRoot, 'edited-reloaded.png'), fullPage: true });
    process.stdout.write('[portable-qa] explicit Save, Discard, conflict, undo, reload, and export ready\n');

    secondaryRoot = await extractPortable(options.zipPath);
    secondary = await launchPortable(secondaryRoot, 'task30-b', trap, options.offline);
    assert.equal(await secondary.page.title(), canonicalProductName);
    await finishColdStart(secondary.page);
    const secondaryPid = secondary.app.process().pid;
    assert.ok(secondaryPid != null, 'secondary Electron root PID is unavailable');
    const secondaryProcesses = await captureProcesses(secondaryPid);
    const secondaryDaemonUrl = daemonUrlFromProcesses(secondaryProcesses);
    const secondaryProjects = await runCli(secondaryRoot, ['project', 'list', '--json'], secondaryDaemonUrl);
    assert.doesNotMatch(secondaryProjects.stdout, new RegExp(projectId, 'u'), 'namespace data leaked to the second runtime');
    await secondary.page.screenshot({ path: join(options.evidenceRoot, 'concurrent-namespace-b.png'), fullPage: true });
    process.stdout.write('[portable-qa] concurrent namespace ready\n');

    await writeEvidence(options.evidenceRoot, 'console.json', { primary: primary.consoleMessages, secondary: secondary.consoleMessages });
    await writeEvidence(options.evidenceRoot, 'network.json', { primary: primary.networkRequests, proxyAttempts: trap.attempts, secondary: secondary.networkRequests });
    await writeEvidence(options.evidenceRoot, 'processes.json', { primary: primaryProcesses, secondary: secondaryProcesses });
    assertPortableBoundaries(extractionRoot, primary, primaryProcesses, trap);
    assertPortableBoundaries(secondaryRoot, secondary, secondaryProcesses, trap);
    const registryAfter = await registrySnapshot();
    assert.deepEqual(registryAfter, registryBefore, 'portable launch changed product registry keys');
    await writeEvidence(options.evidenceRoot, 'commands.json', { created, help, pluginApply, pluginList, secondaryProjects });
    await writeEvidence(options.evidenceRoot, 'paths.json', {
      executable: join(extractionRoot, `${canonicalProductName}.exe`),
      exportPath,
      namespaceA: join(extractionRoot, 'ReadableStudioData', 'namespaces', 'task30-a'),
      namespaceB: join(secondaryRoot, 'ReadableStudioData', 'namespaces', 'task30-b'),
    });
    await writeEvidence(options.evidenceRoot, 'registry.json', { after: registryAfter, before: registryBefore });
    const { actionEvidence, ...workflowDetail } = workflow;
    return {
      actionEvidence,
      detail: { daemonUrl, projectId, ...workflowDetail, status: 'passed' },
      lifecycle: {
        extractionRoots: [extractionRoot, secondaryRoot],
        listenerPorts: [Number(new URL(daemonUrl).port), Number(new URL(secondaryDaemonUrl).port)],
        rootPids: [primaryPid, secondaryPid],
        runtimePaths: [
          join(extractionRoot, 'ReadableStudioData', 'namespaces', 'task30-a'),
          join(secondaryRoot, 'ReadableStudioData', 'namespaces', 'task30-b'),
        ],
      },
    };
  } finally {
    if (secondary != null) await closePortable(secondary.app);
    if (secondaryRoot != null) await rm(secondaryRoot, { force: true, recursive: true });
    await closePortable(primary.app);
  }
}
