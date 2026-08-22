import { mkdir, rm } from 'node:fs/promises';

import { runBadRoot } from './portable-qa-fail-closed.ts';
import { createNetworkTrap, extractPortable } from './portable-qa-runtime.ts';
import {
  acceptanceExitCode,
  cleanupExtractionRoot,
  parseOptions,
  validateEvidenceRoot,
  writeEvidence,
} from './portable-qa-support.ts';
import { runFull } from './portable-qa-workflows.ts';

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  validateEvidenceRoot(options.evidenceRoot);
  await rm(options.evidenceRoot, { force: true, recursive: true });
  await mkdir(options.evidenceRoot, { recursive: true });
  const extractionRoot = await extractPortable(options.zipPath);
  const trap = await createNetworkTrap();
  const startedAt = new Date().toISOString();
  let passed = false;
  try {
    const detail = options.case === 'full'
      ? await runFull(options, extractionRoot, trap)
      : await runBadRoot(options, extractionRoot, trap);
    await trap.close();
    const cleanup = await cleanupExtractionRoot(extractionRoot);
    if (cleanup.warning != null) process.stderr.write(`${cleanup.warning}\n`);
    await writeEvidence(options.evidenceRoot, 'summary.json', {
      case: options.case,
      cleanup,
      detail,
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
