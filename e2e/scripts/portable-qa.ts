import assert from 'node:assert/strict';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { runBadRoot } from './portable-qa-fail-closed.ts';
import { writeActionsEvidence, writeCleanupReceipt, type FullRunResult } from '../lib/portable-qa-evidence.ts';
import { assertPristinePortableRoot, captureProcesses, createNetworkTrap, preparePortableQaRoot, runPortableQaHidden } from './portable-qa-runtime.ts';
import {
  acceptanceExitCode,
  cleanupExtractionRoot,
  parseOptions,
  validateEvidenceRoot,
  writeEvidence,
  verifyZipReceipt,
  sha256File,
  runCommand,
} from './portable-qa-support.ts';
import { runFull, runLaunch } from './portable-qa-workflows.ts';

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  validateEvidenceRoot(options.evidenceRoot);
  if (!process.env.READABLE_PORTABLE_QA_PRIVATE_DESKTOP) {
    await rm(options.evidenceRoot, { force: true, recursive: true });
    await mkdir(options.evidenceRoot, { recursive: true });
    process.exitCode = await runPortableQaHidden(process.argv.slice(2), options.evidenceRoot,
      process.execPath, undefined, join(options.evidenceRoot, 'hidden-desktop.log'));
    return;
  }
  await mkdir(options.evidenceRoot, { recursive: true });
  const extractionRoot = await preparePortableQaRoot(options);
  const zipHash = options.mode === 'zip-gate' ? await sha256File(options.zipPath) : null;
  const trap = await createNetworkTrap();
  const startedAt = new Date().toISOString();
  let passed = false;
  try {
    let fullRun: Pick<FullRunResult, 'detail' | 'lifecycle'> | null = null;
    let detail: Record<string, unknown>;
    if (options.case === 'full') {
      const result = await runFull(options, extractionRoot, trap);
      fullRun = result;
      detail = fullRun.detail;
      await writeActionsEvidence(options.evidenceRoot, result.actionEvidence);
    } else if (options.case === 'launch') {
      fullRun = await runLaunch(options, extractionRoot, trap);
      detail = fullRun.detail;
    } else {
      detail = await runBadRoot(options, extractionRoot, trap);
    }
    if (options.mode === 'zip-gate') {
      const finalHash = await verifyZipReceipt(options.zipPath, options.zipReceiptPath!, options.runId!);
      if (finalHash !== zipHash) throw new Error('ZIP changed during portable QA');
    }
    if (options.mode === 'tree-precheck') await assertPristinePortableRoot(options.treePath!);
    const proxyPort = Number(new URL(trap.proxyUrl).port);
    await trap.close();
    const cleanup = await cleanupExtractionRoot(extractionRoot);
    if (fullRun != null && options.mode === 'tree-precheck') {
      const remainingRoots = [];
      for (const root of fullRun.lifecycle.extractionRoots) {
        if (await stat(root).then(() => true, (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        })) remainingRoots.push(root);
      }
      const processes = await Promise.all(fullRun.lifecycle.rootPids.map(captureProcesses));
      const ports = [...fullRun.lifecycle.listenerPorts, proxyPort];
      const listeners = await runCommand('powershell.exe', ['-NoProfile', '-Command',
        `@(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { @(${ports.join(',')}) -contains $_.LocalPort -and $_.State -eq 'Listen' }).Count`]);
      assert.equal(listeners.exitCode, 0, listeners.stderr);
      assert.deepEqual(remainingRoots, [], 'private tree roots remain');
      for (const evidence of processes) assert.deepEqual(evidence.processes, [], 'tree QA processes remain');
      assert.equal(Number(listeners.stdout.trim()), 0, 'tree QA listeners remain');
      assert.equal(cleanup.warning, null, 'tree QA cleanup failed');
      await writeEvidence(options.evidenceRoot, 'cleanup-receipt.json', {
        status: 'passed', mode: options.mode, sourceTree: options.treePath,
        remainingRoots, processes, listenerPorts: ports, relevantListenerCount: 0, cleanup,
      });
    } else if (fullRun != null) {
      await writeCleanupReceipt({
        cleanup,
        evidenceRoot: options.evidenceRoot,
        lifecycle: fullRun.lifecycle,
        proxyPort,
        zipPath: options.zipPath,
      });
    }
    if (cleanup.warning != null) process.stderr.write(`${cleanup.warning}\n`);
    await writeEvidence(options.evidenceRoot, 'summary.json', {
      case: options.case,
      cleanup,
      detail,
      ...detail,
      finishedAt: new Date().toISOString(),
      offline: options.offline,
      startedAt,
      status: 'passed',
      zipPath: options.zipPath,
    });
    passed = true;
    process.stdout.write(`${JSON.stringify({ case: options.case, evidence: options.evidenceRoot, status: 'passed' })}\n`);
  } finally {
    if (!passed) {
      await trap.close().catch(() => undefined);
      process.stderr.write(`[portable-qa] preserved failed extraction at ${extractionRoot}\n`);
    }
  }
  process.exitCode = acceptanceExitCode(!passed, { leftoverPath: null, warning: null });
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? `${error.name}: ${error.message}` : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
