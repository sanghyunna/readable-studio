import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';

const requiredRegions = [
  'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8',
  'R10', 'R11', 'R12', 'R13', 'R14', 'R15', 'R16', 'R17', 'R18',
] as const;
const temporaryDirectories: string[] = [];

afterEach(() => {
  delete process.env.READABLE_TASK13_EVIDENCE_DIR;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function loadWorker() {
  vi.resetModules();
  return import('../lib/qa-task-13-helpers.ts');
}

function evidence(
  region: (typeof requiredRegions)[number],
  state: string,
  pass = true,
) {
  return { region, state, pass, anchor: 'test-anchor', observation: 'test-observation' } as const;
}

describe('Task 13 region report lifecycle', () => {
  test('assembles and validates region evidence across restarted worker modules', async () => {
    const directory = resolve(tmpdir(), `readable-task-13-report-${randomUUID()}`);
    temporaryDirectories.push(directory);
    process.env.READABLE_TASK13_EVIDENCE_DIR = directory;

    const firstWorker = await loadWorker();
    firstWorker.resetReport();
    for (const region of requiredRegions.slice(0, 13)) {
      firstWorker.recordRegion(evidence(region, 'first-worker'));
    }

    const restartedWorker = await loadWorker();
    for (const region of requiredRegions.slice(13)) {
      restartedWorker.recordRegion(evidence(region, 'restarted-worker'));
    }
    restartedWorker.flushReport();

    const report = JSON.parse(readFileSync(resolve(directory, 'region-report.json'), 'utf8')) as {
      regions: Array<{ region: string }>;
      comparisons: unknown[];
    };
    expect(report.regions).toHaveLength(17);
    expect(new Set(report.regions.map((row) => row.region))).toEqual(new Set(requiredRegions));
    expect(report.comparisons).toHaveLength(0);
  }, 15_000);

  test('writes the report and rejects any failing persisted region verdict', async () => {
    const directory = resolve(tmpdir(), `readable-task-13-report-${randomUUID()}`);
    temporaryDirectories.push(directory);
    process.env.READABLE_TASK13_EVIDENCE_DIR = directory;

    const worker = await loadWorker();
    worker.resetReport();
    for (const region of requiredRegions) {
      worker.recordRegion(evidence(region, 'passing-state'));
    }
    worker.recordRegion(evidence('R7', 'failing-state', false));

    expect(() => worker.flushReport()).toThrowError(
      'region report failed: R7/failing-state',
    );
    const report = JSON.parse(readFileSync(resolve(directory, 'region-report.json'), 'utf8')) as {
      regions: Array<{ region: string; state: string; pass: boolean }>;
    };
    expect(report.regions.filter((row) => !row.pass)).toMatchObject([
      { region: 'R7', state: 'failing-state', pass: false },
    ]);
  }, 15_000);

  test('still rejects genuinely missing persisted regions', async () => {
    const directory = resolve(tmpdir(), `readable-task-13-report-${randomUUID()}`);
    temporaryDirectories.push(directory);
    process.env.READABLE_TASK13_EVIDENCE_DIR = directory;

    const worker = await loadWorker();
    worker.resetReport();
    worker.recordRegion(evidence('R1', 'only-region'));

    expect(() => worker.flushReport()).toThrowError(
      'region report incomplete: R2, R3, R4, R5, R6, R7, R8, R10, R11, R12, R13, R14, R15, R16, R17, R18',
    );
  }, 15_000);
});
