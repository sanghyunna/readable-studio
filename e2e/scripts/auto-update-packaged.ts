import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { watch } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { expect, chromium } from '@playwright/test';
import { launchHiddenDesktop, type HiddenDesktop } from '../lib/packaged-hidden-desktop.ts';
import { resolvePackagedAppRoot } from './direct-edit-delete-packaged.ts';
import { captureProcesses, daemonUrlFromProcesses, runCli } from './portable-qa-runtime.ts';
import { runCommand, workspaceRoot } from './portable-qa-support.ts';

// Deliberately opt-in: this runner uses a real authenticated update service.
const [zip, serverUrl, evidenceArg, installedVersion, targetVersion] = process.argv.slice(2);
assert.ok(zip && serverUrl && evidenceArg && installedVersion && targetVersion,
  'Usage: auto-update-packaged.ts <zip> <server URL> <evidence> <installed version> <target version>');
const evidence = resolve(evidenceArg);
const scratch = join(workspaceRoot, '.tmp/au-e2e');
const namespace = 'au-e2e';
const results: Array<{ name: string; passed: boolean; details: unknown }> = [];
let runtime: HiddenDesktop | undefined;
let failed: unknown;
let extractionOwned = false;
let downloadStartedAt: number | undefined;
let initialDaemon: string | undefined;
let downloadWindow: {
  startedAt: string; endedAt: string | null; outcome: string;
  targetVersion: string; requestPath: string; httpStatuses: number[];
  requestCountSource: string;
} | undefined;
const proofDeadline = Number(process.env.READABLE_UPDATE_PROOF_DEADLINE ?? Infinity);
const proofTimer = Number.isFinite(proofDeadline) ? setTimeout(() => {
  void runtime?.close();
}, Math.max(1, proofDeadline - Date.now())) : undefined;
const ownedPids = new Set<number>();
const record = (name: string, details: unknown) => { results.push({ name, passed: true, details }); console.log(`PASS ${name}`); };

async function freePort() {
  const listener = createServer();
  await new Promise<void>(done => listener.listen(0, '127.0.0.1', done));
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>(done => listener.close(() => done()));
  return address.port;
}

function updatedReceipt() {
  return new Promise<unknown>((done, reject) => {
    const timer = setTimeout(() => { watcher.close(); reject(new Error('Launcher readiness timeout')); },
      Math.max(1, Math.min(300_000, proofDeadline - Date.now())));
    const watcher = watch(scratch, (_event, name) => {
      if (String(name) !== 'update-ready.json') return;
      void readFile(join(scratch, 'update-ready.json'), 'utf8').then(raw => {
        const receipt = JSON.parse(raw);
        if (receipt.version !== targetVersion) return;
        clearTimeout(timer); watcher.close(); done(receipt);
      }).catch(() => {});
    });
  });
}

try {
  await mkdir(evidence, { recursive: true });
  assert.equal(await stat(scratch).then(() => true, () => false), false, 'Refuse existing extraction');
  extractionOwned = true;
  const extraction = await runCommand(join(workspaceRoot, 'tools/pack/resources/win/7zip/7z.exe'),
    ['x', resolve(zip), `-o${scratch}`, '-y']);
  assert.equal(extraction.exitCode, 0, extraction.stderr);
  runtime = await launchHiddenDesktop({ executablePath: join(scratch, 'Readable Studio.exe'), namespace, debugPort: await freePort() });
  const { page } = runtime;
  const processes = await captureProcesses(runtime.rootPid);
  processes.processes.forEach(process => ownedPids.add(process.pid));
  ownedPids.add(runtime.rootPid);
  ownedPids.add(runtime.hostPid);
  const daemon = daemonUrlFromProcesses(processes);
  initialDaemon = daemon;
  const appRoot = await resolvePackagedAppRoot(scratch);
  const version = await (await page.request.get(`${daemon}/api/version`)).json();
  assert.equal(version.version.version, installedVersion);
  assert.equal(version.version.packaged, true);
  record('installed-version', version);
  const windows = await runtime.inspectWindows();
  assert.equal(windows.inputDesktop, 'Default');
  assert.deepEqual(windows.activeOwnedWindowPids, []);
  record('private-desktop', { rootPid: runtime.rootPid, hostPid: runtime.hostPid, windows });
  const initial = await page.request.put(`${daemon}/api/app-config`, { data: {
    onboardingCompleted: true, privacyDecisionAt: 1,
    telemetry: { metrics: false, content: false, artifactManifest: false },
    autoUpdate: { enabled: false, serverUrl },
  } });
  assert.ok(initial.ok());
  await page.evaluate(() => {
    localStorage.setItem('readable-studio:welcome-modal-shown', '1');
    localStorage.setItem('readable-studio:locale', 'ko');
    localStorage.setItem('readable-studio:locale-source', 'manual');
    localStorage.setItem('readable-studio:config', JSON.stringify({
      onboardingCompleted: true, privacyDecisionAt: 1,
      telemetry: { metrics: false, content: false, artifactManifest: false },
    }));
  });
  const disabledResponse = page.waitForResponse(response => response.url().includes('/api/update/check?automatic=1'));
  await page.reload();
  assert.deepEqual(await (await disabledResponse).json(), { unavailable: 'disabled' });
  record('disabled-launch', { result: 'disabled', boundary: 'automatic check returns before credentials or transport' });
  const created = await runCli(appRoot, ['project', 'create', '--name', 'Auto Update Private Marker', '--json'], daemon);
  const projectId = JSON.parse(created.stdout).project.id;
  const marker = '<!doctype html><title>Private update marker</title><h1>Preserved</h1>';
  const seeded = await page.request.post(`${daemon}/api/projects/${projectId}/files`, { data: { name: 'marker.html', content: marker } });
  assert.ok(seeded.ok());
  const markerPath = join(scratch, 'ReadableStudioData/namespaces', namespace, 'data/projects', projectId, 'marker.html');
  record('user-data-marker', { projectId, markerPath, response: await seeded.json() });
  await page.keyboard.press('Control+,');
  await page.locator('.settings-nav-item').filter({ has: page.locator('strong', { hasText: /^업데이트$/ }) }).click();
  const section = page.locator('section[aria-label="업데이트"]');
  await expect(section.getByRole('switch', { name: '자동 업데이트' })).toBeVisible();
  await section.locator('input[type="url"]').fill(serverUrl);
  await section.getByRole('switch', { name: '자동 업데이트' }).click();
  await expect(section.getByRole('switch')).toHaveAttribute('aria-checked', 'true', { timeout: 120_000 });
  await page.screenshot({ path: join(evidence, 'settings.png') });
  record('settings-enabled', await (await page.request.get(`${daemon}/api/app-config`)).json());
  const offered = page.waitForResponse(response => response.url().includes('/api/update/check?automatic=1'));
  await page.reload();
  const offer = await (await offered).json();
  assert.equal(offer.latest, targetVersion);
  assert.equal(offer.isNewer, true);
  const banner = page.locator('aside[role="status"]').filter({ hasText: targetVersion });
  await expect(banner).toBeVisible({ timeout: 120_000 });
  await page.screenshot({ path: join(evidence, 'hub-prompt.png') });
  record('hub-offer', offer);
  await page.evaluate((downloadTimeout) => {
    const observed = window as unknown as { updateTransfer: Promise<Array<{ state: string; received: number; total: number; error: string | null }>>; updateEventsReady: Promise<void>; updateLatest?: { state: string } };
    let subscribed!: () => void;
    observed.updateEventsReady = new Promise<void>(done => { subscribed = done; });
    observed.updateTransfer = new Promise(done => {
      const statuses: Array<{ state: string; received: number; total: number; error: string | null }> = [];
      const events = new EventSource('/api/update/events');
      events.onopen = () => subscribed();
      let active = false;
      const timer = setTimeout(() => { events.close(); done(statuses); }, downloadTimeout);
      events.onmessage = event => {
        const value = JSON.parse(event.data); statuses.push(value); observed.updateLatest = value;
        if (value.state === 'downloading' || value.state === 'verifying') active = true;
        if (active && (value.state === 'failed' || value.state === 'ready')) { clearTimeout(timer); events.close(); done(statuses); }
      };
    });
  }, Number(process.env.READABLE_UPDATE_DOWNLOAD_TIMEOUT_MS ?? 900_000));
  await page.evaluate(() => (window as unknown as { updateEventsReady: Promise<void> }).updateEventsReady);
  const startedAt = Date.now();
  downloadStartedAt = startedAt;
  // Request/renewal counts come from the update App's HTTP log, not injected
  // daemon code. Persist UTC bounds so another lane can correlate 200/206 GETs.
  downloadWindow = { startedAt: new Date(startedAt).toISOString(), endedAt: null, outcome: 'running',
    targetVersion, requestPath: `/api/v1/download/${targetVersion}`, httpStatuses: [200, 206],
    requestCountSource: 'databricks apps logs readable-studio-updates' };
  await writeFile(join(evidence, 'download-window.json'), JSON.stringify(downloadWindow, null, 2));
  await banner.getByRole('button', { name: '업데이트', exact: true }).click();
  await expect(banner.locator('progress')).toBeVisible({ timeout: 120_000 });
  await expect(banner.locator('progress')).not.toHaveAttribute('value', '0', { timeout: 120_000 });
  await page.screenshot({ path: join(evidence, 'progress.png') });
  await page.waitForFunction(() => {
    const progress = document.querySelector('aside[role="status"] progress') as HTMLProgressElement | null;
    return progress && progress.value / progress.max >= 0.25
      || (window as unknown as { updateLatest?: { state: string } }).updateLatest?.state === 'failed'
      || document.querySelector('aside[role="status"]')?.textContent?.includes('재시작하기');
  }, null, { timeout: Number(process.env.READABLE_UPDATE_DOWNLOAD_TIMEOUT_MS ?? 900_000) });
  await page.screenshot({ path: join(evidence, 'progress-mid-download.png') });
  const statuses = await page.evaluate(() => (window as unknown as {
    updateTransfer: Promise<Array<{ state: string; received: number; total: number; error: string | null }>>
  }).updateTransfer);
  downloadWindow.endedAt = new Date().toISOString();
  downloadWindow.outcome = statuses.at(-1)?.state ?? 'no-status';
  await writeFile(join(evidence, 'download-window.json'), JSON.stringify(downloadWindow, null, 2));
  await writeFile(join(evidence, 'transfer-statuses.json'), JSON.stringify(statuses));
  assert.equal(statuses.some(value => value.state === 'failed'), false, 'One-click transfer must never fail');
  assert.equal(statuses.at(-1)?.state, 'ready');
  assert.ok(statuses.every((value, index) => index === 0 || value.received >= statuses[index - 1]!.received),
    'Progress must never decrease across transparent renewals');
  record('single-click-monotonic-download', { updateClicks: 1, observations: statuses.length, failedStates: 0,
    elapsedMs: Date.now() - startedAt, downloadWindow });
  const stagedZip = join(scratch, '.update-download/update.zip');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(stagedZip)) hash.update(chunk);
  const sha256 = hash.digest('hex');
  const bytes = (await stat(stagedZip)).size;
  assert.equal(bytes, offer.assetSize);
  assert.equal(sha256, offer.sha256);
  record('download-integrity', { bytes, sha256, expectedBytes: offer.assetSize, expectedSha256: offer.sha256,
    bytesPerSecond: bytes / ((Date.now() - startedAt) / 1000) });
  const status = await (await page.request.get(`${daemon}/api/update/status`)).json();
  assert.equal(status.state, 'ready', JSON.stringify(status));
  assert.equal(status.received, status.total);
  await expect(banner.getByRole('button', { name: '재시작하기' })).toBeVisible();
  await page.screenshot({ path: join(evidence, 'restart.png') });
  record('download-verified', { status, statuses });
  const ready = updatedReceipt();
  await banner.getByRole('button', { name: '재시작하기' }).click();
  const receipt = await ready;
  record('launcher-swap', receipt);
  const updatedProcesses = await captureProcesses((receipt as { pid: number }).pid);
  updatedProcesses.processes.forEach(process => ownedPids.add(process.pid));
  const updatedDaemon = daemonUrlFromProcesses(updatedProcesses);
  const updatedVersion = await (await fetch(`${updatedDaemon}/api/version`)).json();
  assert.equal(updatedVersion.version.version, targetVersion);
  assert.equal(updatedVersion.version.packaged, true);
  record('updated-version', updatedVersion);
  const preserved = await fetch(`${updatedDaemon}/api/projects/${projectId}/files`);
  assert.ok(preserved.ok);
  assert.ok(JSON.stringify(await preserved.json()).includes('marker.html'));
  const markerFiles = await runCommand('fd', ['--hidden', '--no-ignore', '--type', 'f', 'marker.html', join(scratch, 'ReadableStudioData')]);
  assert.equal(markerFiles.exitCode, 0);
  const markerPaths = markerFiles.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.ok(markerPaths.length);
  assert.ok((await Promise.all(markerPaths.map(path => readFile(path, 'utf8')))).includes(marker));
  record('user-data-preserved', { markerPaths });
  const files = await runCommand('fd', ['--hidden', '--no-ignore', '--type', 'f', '.', scratch]);
  assert.equal(files.exitCode, 0);
  const paths = files.stdout.trim().split(/\r?\n/).filter(Boolean);
  const zones: string[] = [];
  for (const path of paths) {
    try { await readFile(`${path}:Zone.Identifier`); zones.push(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  assert.deepEqual(zones, []);
  record('no-zone-identifier', { checkedFiles: paths.length, zones });
  // The actual launcher restart does not inherit the original CDP flag. Render
  // the relaunched web runtime directly, without changing its data or APIs.
  const browser = await chromium.launch({ headless: true });
  try {
    const view = await browser.newPage();
    await view.addInitScript(() => {
      localStorage.setItem('readable-studio:welcome-modal-shown', '1');
      localStorage.setItem('readable-studio:locale', 'ko');
      localStorage.setItem('readable-studio:locale-source', 'manual');
    });
    const webProcess = updatedProcesses.processes.find(process => process.commandLine.includes('--readable-studio-stamp-app=web'));
    assert.ok(webProcess);
    const webListener = updatedProcesses.connections.find(connection => connection.owningProcess === webProcess.pid && connection.state === 'Listen');
    assert.ok(webListener);
    await view.goto(`http://127.0.0.1:${webListener.localPort}`);
    await view.locator('html[data-readable-app-mounted="1"]').waitFor({ timeout: 120_000 });
    await view.keyboard.press('Control+,');
    await view.locator('.settings-nav-item').filter({ has: view.locator('strong', { hasText: /^업데이트$/ }) }).click();
    await expect(view.locator('section[aria-label="업데이트"]')).toContainText(targetVersion);
    await expect(view.locator('section[aria-label="업데이트"]')).toBeVisible();
    await view.screenshot({ path: join(evidence, 'post-update-version.png'), animations: 'disabled' });
  } finally { await browser.close(); }
  record('updated-process-cleanup', await runtime.close());
  runtime = undefined;
  const originalConfigFile = process.env.DATABRICKS_CONFIG_FILE;
  process.env.DATABRICKS_CONFIG_FILE = join(scratch, 'no-profile.databrickscfg');
  try {
    runtime = await launchHiddenDesktop({ executablePath: join(scratch, 'Readable Studio.exe'), namespace, debugPort: await freePort() });
  } finally {
    if (originalConfigFile === undefined) delete process.env.DATABRICKS_CONFIG_FILE;
    else process.env.DATABRICKS_CONFIG_FILE = originalConfigFile;
  }
  const loginProcesses = await captureProcesses(runtime.rootPid);
  loginProcesses.processes.forEach(process => ownedPids.add(process.pid));
  ownedPids.add(runtime.rootPid);
  ownedPids.add(runtime.hostPid);
  const loginDaemon = daemonUrlFromProcesses(loginProcesses);
  const loginResult = await (await runtime.page.request.get(`${loginDaemon}/api/update/check?automatic=1`)).json();
  assert.equal(loginResult.unavailable, 'not-logged-in');
  await expect(runtime.page.locator('aside[role="status"]').getByRole('button', { name: '로그인하기' })).toBeVisible({ timeout: 120_000 });
  await runtime.page.screenshot({ path: join(evidence, 'missing-login.png') });
  record('missing-login', { loginResult, isolatedConfigFile: join(scratch, 'no-profile.databrickscfg'), ownerProfileModified: false });
  // This is the same installation after the real swap, relaunched on the
  // private desktop for the login check. Its new CDP session also gives a
  // direct Electron version screenshot, without depending on desktop IPC.
  await runtime.page.keyboard.press('Control+,');
  await runtime.page.locator('.settings-nav-item').filter({ has: runtime.page.locator('strong', { hasText: /^업데이트$/ }) }).click();
  const updatedSection = runtime.page.locator('section[aria-label="업데이트"]');
  await expect(updatedSection).toBeVisible();
  await expect(updatedSection).toContainText(targetVersion);
  await runtime.page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(animation =>
      Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {})));
  });
  await runtime.page.screenshot({ path: join(evidence, 'post-update-version.png'), animations: 'disabled' });
  record('post-update-native-version', { version: targetVersion, source: 'same updated installation, private Electron relaunch' });
} catch (error) {
  failed = error;
  results.push({ name: 'journey', passed: false, details: String(error) });
  if (runtime && !runtime.page.isClosed()) await runtime.page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
  if (initialDaemon && downloadStartedAt) {
    const status = await fetch(`${initialDaemon}/api/update/status`).then(response => response.json()).catch(() => null);
    const bytes = await stat(join(scratch, '.update-download/update.zip')).then(file => file.size, () => 0);
    await writeFile(join(evidence, 'failure-transfer.json'), JSON.stringify({ status, bytes,
      elapsedMs: Date.now() - downloadStartedAt, bytesPerSecond: bytes / ((Date.now() - downloadStartedAt) / 1000) }, null, 2));
  }
} finally {
  clearTimeout(proofTimer);
  if (downloadWindow && !downloadWindow.endedAt) {
    downloadWindow.endedAt = new Date().toISOString();
    downloadWindow.outcome = 'runner-error';
    await writeFile(join(evidence, 'download-window.json'), JSON.stringify(downloadWindow, null, 2));
  }
  for (const name of ['update-broker.log', 'update-error.log', 'update-ready.json', 'update-state.json']) {
    const contents = await readFile(join(scratch, name)).catch(() => undefined);
    if (contents) await writeFile(join(evidence, name), contents);
  }
  if (runtime) {
    await writeFile(join(evidence, 'hidden-runtime.log'), runtime.logs.join('\n'));
    const cleanup = await runtime.close();
    assert.equal(cleanup.activeProcesses, 0);
    assert.equal(cleanup.inputDesktop, 'Default');
    record('process-cleanup', cleanup);
  }
  const remainingPids = [...ownedPids].filter(pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; return false; }
  });
  assert.deepEqual(remainingPids, []);
  record('owned-pids-gone', { ownedPids: [...ownedPids], remainingPids });
  if (extractionOwned) await rm(scratch, { recursive: true, force: true });
  record('extraction-cleanup', { exists: await stat(scratch).then(() => true, () => false) });
  await writeFile(join(evidence, 'runner.json'), JSON.stringify({ passed: results.filter(result => result.passed).length,
    failed: results.filter(result => !result.passed).length, results }, null, 2));
}
if (failed) throw failed;
