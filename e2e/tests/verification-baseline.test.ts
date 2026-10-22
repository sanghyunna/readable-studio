import { describe, expect, it } from 'vitest';

import {
  collectObservation, failureFingerprint, importBaseline, judgeBaseline, normalizeTestName,
  type Baseline, type Observation,
} from '../lib/verification-baseline.ts';

const root = 'D:/readable-studio';
type Case = [title: string, status: string, message?: string];

function reporter(cases: Case[]) {
  return {
    numTotalTests: cases.length,
    numPassedTests: cases.filter((test) => test[1] === 'passed').length,
    numFailedTests: cases.filter((test) => test[1] === 'failed').length,
    numPendingTests: cases.filter((test) => test[1] === 'pending').length,
    numTodoTests: cases.filter((test) => test[1] === 'todo').length,
    success: !cases.some((test) => test[1] === 'failed'),
    testResults: [{
      name: `${root}/apps/daemon/tests/example.test.ts`,
      status: cases.some((test) => test[1] === 'failed') ? 'failed' : 'passed',
      message: '',
      assertionResults: cases.map(([title, status, message]) => ({
        ancestorTitles: ['suite'], title, fullName: `suite ${title}`, status,
        failureMessages: status === 'failed' ? [message ?? 'AssertionError: expected 1 to be 2'] : [],
      })),
    }],
  };
}

function observation(cases: Case[], exitCode: number | null = null): Observation {
  return collectObservation(reporter(cases), 'daemon', { repoRoot: root, exitCode });
}

function baseline(...cases: Case[][]): Baseline {
  return importBaseline('daemon', 'e16a5544', cases.map((value) => observation(value)));
}

describe('per-test baseline', () => {
  it('does not confuse equal failure counts with the same failing tests', () => {
    const before = baseline([['A', 'failed'], ['B', 'failed'], ['C', 'passed']]);
    const diff = judgeBaseline(before, observation([['A', 'failed'], ['B', 'passed'], ['C', 'failed']], 1), 'daemon');
    expect(diff.verdict).toBe('NEW_FAILURES');
    expect(diff.newFailures).toHaveLength(1);
    expect(diff.newFailures[0]?.id).toContain('suite C');
    expect(diff.fixed).toEqual([expect.stringContaining('suite B')]);
    expect(diff.knownFailures).toHaveLength(1);
    expect(diff.rawCounts.numFailedTests).toBe(2);
    expect(diff.rawExitCode).toBe(1);
  });

  it('retains known failures without claiming ALL_PASS', () => {
    const diff = judgeBaseline(baseline([['A', 'failed']]), observation([['A', 'failed']], 1), 'daemon');
    expect(diff.verdict).toBe('NO_NEW_FAILURES_BASELINE_FAILURES_REMAIN');
    expect(diff.newFailures).toEqual([]);
    expect(diff.rawExitCode).toBe(1);
  });

  it('reports ALL_PASS and fixes when all failures disappear', () => {
    const diff = judgeBaseline(baseline([['A', 'failed']]), observation([['A', 'passed']], 0), 'daemon');
    expect(diff.verdict).toBe('ALL_PASS');
    expect(diff.fixed).toHaveLength(1);
  });

  it('detects assertion to EFAULT failure changes', () => {
    const diff = judgeBaseline(baseline([['A', 'failed']]), observation([
      ['A', 'failed', 'Error: listen EFAULT: bad address in system call argument 127.0.0.1'],
    ]), 'daemon');
    expect(diff.verdict).toBe('NEW_FAILURES');
    expect(diff.newFailures[0]?.reason).toBe('changed-fingerprint');
  });

  it('preserves different assertion values within the same error class', () => {
    const diff = judgeBaseline(baseline([['A', 'failed']]), observation([
      ['A', 'failed', 'AssertionError: expected 1 to be 3'],
    ]), 'daemon');
    expect(diff.verdict).toBe('NEW_FAILURES');
  });

  it('detects a new failing test ID', () => {
    const diff = judgeBaseline(baseline([['A', 'passed']]), observation([['A', 'passed'], ['B', 'failed']]), 'daemon');
    expect(diff.verdict).toBe('NEW_FAILURES');
    expect(diff.newFailures[0]?.reason).toBe('new-test');
  });

  it('detects missing collected IDs even when all remaining tests pass', () => {
    const diff = judgeBaseline(baseline([['A', 'passed'], ['B', 'passed']]), observation([['A', 'passed']]), 'daemon');
    expect(diff.verdict).toBe('NEW_FAILURES');
    expect(diff.missing).toEqual([expect.stringContaining('suite B')]);
  });

  it.each(['pending', 'skipped', 'todo', 'disabled'])('detects a new %s test', (status) => {
    const diff = judgeBaseline(baseline([['A', 'passed']]), observation([['A', 'passed'], ['B', status]]), 'daemon');
    expect(diff.verdict).toBe('NEW_FAILURES');
    expect(diff.newSkipped).toHaveLength(1);
  });

  it('detects an existing passing test that becomes skipped', () => {
    const diff = judgeBaseline(baseline([['A', 'passed']]), observation([['A', 'pending']]), 'daemon');
    expect(diff.verdict).toBe('NEW_FAILURES');
  });

  it('does not flag an unchanged baseline skip', () => {
    const diff = judgeBaseline(baseline([['A', 'pending']]), observation([['A', 'pending']]), 'daemon');
    expect(diff.verdict).toBe('ALL_PASS');
    expect(diff.newSkipped).toEqual([]);
  });

  it('never exempts a failure for a test that was only skipped before', () => {
    const diff = judgeBaseline(baseline([['A', 'pending']]), observation([['A', 'failed']]), 'daemon');
    expect(diff.verdict).toBe('NEW_FAILURES');
    expect(diff.knownFlaky).toEqual([]);
  });

  it('classifies observations individually and keeps mixed failures known-flaky', () => {
    const before = baseline(
      [['A', 'failed'], ['B', 'passed'], ['C', 'failed']],
      [['A', 'passed'], ['B', 'passed'], ['C', 'failed']],
    );
    expect(before.tests.map((test) => test.status)).toEqual(['flaky', 'pass', 'always-fail']);
    expect(before.observations).toHaveLength(2);
    expect(before.observations.every((sample) => sample.collectedIds.length === 3)).toBe(true);
    const diff = judgeBaseline(before, observation([
      ['A', 'failed', 'Error: ETIMEDOUT'], ['B', 'passed'], ['C', 'passed'],
    ]), 'daemon');
    expect(diff.verdict).toBe('NO_NEW_FAILURES_BASELINE_FAILURES_REMAIN');
    expect(diff.knownFlaky).toEqual([expect.stringContaining('suite A')]);
    expect(diff.fixed).toEqual([expect.stringContaining('suite C')]);
  });

  it('retains all observed fingerprints of an always-failing test', () => {
    const before = baseline([['A', 'failed', 'Error: first']], [['A', 'failed', 'Error: second']]);
    expect(before.tests[0]?.fingerprints).toHaveLength(2);
    expect(judgeBaseline(before, observation([['A', 'failed', 'Error: second']]), 'daemon').newFailures).toEqual([]);
  });

  it('uses project, POSIX repository path, ancestors, title and ordered case index', () => {
    const source = reporter([['same', 'passed'], ['same', 'failed']]);
    source.testResults[0]!.name = 'D:\\readable-studio\\apps\\daemon\\tests\\example.test.ts';
    source.testResults[0]!.assertionResults[0]!.fullName = 'ignored reporter fullName';
    const sample = collectObservation(source, 'daemon', { repoRoot: root });
    expect(sample.tests.map((test) => JSON.parse(test.id))).toEqual([
      ['daemon', 'apps/daemon/tests/example.test.ts', 'suite same', 0],
      ['daemon', 'apps/daemon/tests/example.test.ts', 'suite same', 1],
    ]);
    const diff = judgeBaseline(importBaseline('daemon', 'sha', [sample]), observation([
      ['same', 'failed'], ['same', 'passed'],
    ]), 'daemon');
    expect(diff.verdict).toBe('NEW_FAILURES');
    expect(diff.fixed).toHaveLength(1);
  });

  it('rejects duplicate IDs across file records instead of overwriting them', () => {
    const source = reporter([['same', 'passed']]);
    source.testResults.push(source.testResults[0]!);
    expect(() => collectObservation(source, 'daemon', { repoRoot: root })).toThrow('Duplicate test ID');
  });

  it('rejects files outside the selected project', () => {
    expect(() => collectObservation(reporter([['A', 'passed']]), 'web', { repoRoot: root })).toThrow('outside project');
  });

  it('records full collection and suite errors for each baseline observation', () => {
    const source = reporter([['A', 'passed']]);
    source.testResults[0]!.message = 'Error: beforeAll failed';
    const sample = collectObservation(source, 'daemon', { repoRoot: root });
    const before = importBaseline('daemon', 'sha', [sample]);
    expect(before.collectedIds).toEqual(sample.collectedIds);
    expect(before.observations[0]?.suiteErrors).toEqual([expect.stringContaining('beforeAll failed')]);
    expect(judgeBaseline(before, sample, 'daemon').verdict).toBe('NEW_FAILURES');
  });

  it('detects failed suites with no failing assertions', () => {
    const source = reporter([]);
    source.testResults[0]!.status = 'failed';
    const sample = collectObservation(source, 'daemon', { repoRoot: root });
    expect(judgeBaseline(baseline([]), sample, 'daemon').verdict).toBe('NEW_FAILURES');
  });

  it.each([1, 2, -1, 3221225477])('detects runner crashes with exit code %s', (exitCode) => {
    const diff = judgeBaseline(baseline([['A', 'passed']]), observation([['A', 'passed']], exitCode), 'daemon');
    expect(diff.verdict).toBe('NEW_FAILURES');
    expect(diff.rawExitCode).toBe(exitCode);
    expect(diff.suiteErrors).not.toEqual([]);
  });

  it('detects truncated collection and unhandled runner errors', () => {
    const source = { ...reporter([['A', 'passed']]), numTotalTests: 2, unhandledErrors: [{ message: 'worker crashed' }] };
    const sample = collectObservation(source, 'daemon', { repoRoot: root });
    const diff = judgeBaseline(baseline([['A', 'passed']]), sample, 'daemon');
    expect(diff.verdict).toBe('NEW_FAILURES');
    expect(diff.suiteErrors).toHaveLength(2);
  });

  it.each(['missing reporter', 'unparseable reporter'])('does not excuse a %s', (reporterError) => {
    const diff = judgeBaseline(baseline([['A', 'passed']]), null, 'daemon', { reporterError, exitCode: 9 });
    expect(diff.verdict).toBe('NEW_FAILURES');
    expect(diff.suiteErrors).toEqual([reporterError]);
    expect(diff.rawExitCode).toBe(9);
  });

  it('rejects malformed reporter records', () => {
    expect(() => collectObservation({}, 'daemon')).toThrow('missing testResults');
    const source = reporter([['A', 'passed']]);
    source.testResults[0]!.assertionResults[0]!.status = 'mystery';
    expect(() => collectObservation(source, 'daemon', { repoRoot: root })).toThrow('status');
  });

  it('blocks missing or wrong-project baselines', () => {
    expect(judgeBaseline(null, observation([['A', 'failed']]), 'daemon').verdict).toBe('BLOCKED');
    expect(judgeBaseline(baseline([['A', 'failed']]), null, 'web').verdict).toBe('BLOCKED');
  });

  it('requires observations and a source commit', () => {
    expect(() => importBaseline('daemon', 'sha', [])).toThrow('observation');
    expect(() => importBaseline('daemon', '', [observation([])])).toThrow('commit');
  });
});

describe('volatile test names', () => {
  it('matches the same test whose title embeds different timestamps', () => {
    const before = baseline([['returns {"checkedAt":"2026-10-19T06:26:46.449Z","at":1760855206449}', 'passed']]);
    const diff = judgeBaseline(before, observation([
      ['returns {"checkedAt":"2026-10-20T01:02:03.004Z","at":1760920923004}', 'passed'],
    ]), 'daemon');
    expect(diff.missing).toEqual([]);
    expect(diff.verdict).toBe('ALL_PASS');
  });

  it('normalizes only timestamps and keeps case-index disambiguation on collisions', () => {
    expect(normalizeTestName('a 2026-10-19T06:26:46Z b 1760855206449 c 12345')).toBe('a <timestamp> b <epoch-ms> c 12345');
    const sample = observation([['t 2026-10-19T06:26:46.449Z', 'passed'], ['t 2026-10-19T07:00:00.000Z', 'passed']]);
    expect(sample.tests.map((test) => test.caseIndex)).toEqual([0, 1]);
  });
});

describe('failure fingerprints', () => {
  it('normalizes volatile runtime fields but not assertion text', () => {
    const first = 'Error: 2026-10-19T12:04:01.000Z pid=12 port=31234 after 120 ms at http://localhost:12345 C:\\Users\\User\\AppData\\Local\\Temp\\probe-a\\file.txt';
    const second = 'Error: 2026-10-20T13:05:02.100Z pid=45 port=54321 after 900 ms at http://localhost:54321 C:\\Users\\User\\AppData\\Local\\Temp\\probe-b\\file.txt';
    expect(failureFingerprint(first)).toBe(failureFingerprint(second));
    expect(failureFingerprint('AssertionError: expected 42 to be 43')).not.toBe(
      failureFingerprint('AssertionError: expected 42 to be 44'),
    );
  });

  it('includes errno from later lines, while ignoring stack location changes', () => {
    expect(failureFingerprint('Error: failed\ncode: EFAULT\n at file:12')).not.toBe(
      failureFingerprint('Error: failed\ncode: ETIMEDOUT\n at file:12'),
    );
    expect(failureFingerprint('Error: failed\n at file:12')).toBe(failureFingerprint('Error: failed\n at file:99'));
  });

  it('normalizes short durations, node PIDs, IPv4/IPv6 and remote URL ports', () => {
    expect(failureFingerprint('Error: (node:12) 3s 0.0.0.0:1234 [::1]:1234 https://example.test:1234')).toBe(
      failureFingerprint('Error: (node:34) 5s 0.0.0.0:4321 [::1]:4321 https://example.test:4321'),
    );
    expect(failureFingerprint('Error: D:/readable-studio/.tmp/run-a/file.txt')).toBe(
      failureFingerprint('Error: D:/readable-studio/.tmp/run-b/file.txt'),
    );
  });
});
