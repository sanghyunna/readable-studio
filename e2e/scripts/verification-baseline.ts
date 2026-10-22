import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import {
  collectObservation, importBaseline, judgeBaseline,
  type Baseline, type Observation, type Project,
} from '../lib/verification-baseline.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: 'string' },
    commit: { type: 'string' },
    observation: { type: 'string', multiple: true },
    'repo-root': { type: 'string', multiple: true },
    baseline: { type: 'string' },
    current: { type: 'string' },
    out: { type: 'string' },
    'exit-code': { type: 'string' },
  },
});

async function main(): Promise<void> {
  const project = values.project;
  if (project !== 'web' && project !== 'daemon') throw new Error('--project must be web or daemon');
  if (!values.out) throw new Error('--out is required');
  const exitCode = values['exit-code'] === undefined ? null : Number(values['exit-code']);
  if (exitCode !== null && (!Number.isInteger(exitCode) || values['exit-code']?.trim() === '')) {
    throw new Error('--exit-code must be an integer');
  }
  const command = positionals[0];
  if (positionals.length !== 1) throw new Error('Expected one command: import or judge');
  if (command === 'import') {
    if (!values.commit || !values.observation?.length) throw new Error('import requires --commit and --observation');
    const observations: Observation[] = [];
    // --repo-root pairs with --observation by position; a single value applies to all.
    const roots = values['repo-root'] ?? [];
    for (const [index, path] of values.observation.entries()) {
      const repoRoot = roots[index] ?? (roots.length === 1 ? roots[0] : undefined);
      observations.push(collectObservation(JSON.parse(await readFile(path, 'utf8')), project, {
        exitCode, ...(repoRoot === undefined ? {} : { repoRoot }),
      }));
    }
    const baseline = importBaseline(project, values.commit, observations);
    await writeFile(values.out, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ project, tests: baseline.tests.length, observations: observations.length }));
    return;
  }
  if (command !== 'judge') throw new Error('Expected command: import or judge');
  if (!values.baseline || !values.current) throw new Error('judge requires --baseline and --current');
  let baseline: Baseline | null = null;
  try {
    const data: unknown = JSON.parse(await readFile(values.baseline, 'utf8'));
    if (validBaseline(data)) baseline = data;
  } catch {
    // An absent or malformed baseline blocks comparison, never exempts failures.
  }
  let current: Observation | null = null;
  let reporterError: string | undefined;
  try {
    current = collectObservation(JSON.parse(await readFile(values.current, 'utf8')), project, { exitCode });
  } catch (error) {
    reporterError = error instanceof Error ? error.message : String(error);
  }
  const diff = judgeBaseline(baseline, current, project, {
    exitCode, ...(reporterError === undefined ? {} : { reporterError }),
  });
  await writeFile(values.out, `${JSON.stringify(diff, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ verdict: diff.verdict, rawCounts: diff.rawCounts, rawExitCode: diff.rawExitCode }));
  process.exitCode = diff.verdict === 'BLOCKED' ? 2 : diff.verdict === 'NEW_FAILURES' ? 1 : 0;
}

function validBaseline(value: unknown): value is Baseline {
  if (value === null || typeof value !== 'object') return false;
  const data = value as Partial<Baseline>;
  return data.version === 1 && (['web', 'daemon'] satisfies Project[]).some((project) => project === data.project)
    && typeof data.commit === 'string' && Array.isArray(data.observations)
    && Array.isArray(data.collectedIds) && data.collectedIds.every((id) => typeof id === 'string')
    && Array.isArray(data.tests) && data.tests.length === data.collectedIds.length
    && new Set(data.collectedIds).size === data.collectedIds.length
    && data.tests.every((test) => test && typeof test.id === 'string' && data.collectedIds?.includes(test.id)
      && ['pass', 'always-fail', 'flaky'].includes(test.status)
      && Array.isArray(test.observedStatuses) && Array.isArray(test.fingerprints)
      && test.fingerprints.every((fingerprint) => typeof fingerprint === 'string'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
