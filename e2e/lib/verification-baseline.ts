import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Project = 'web' | 'daemon';
type Status = 'passed' | 'failed' | 'pending' | 'skipped' | 'todo' | 'disabled';
export type Verdict = 'NEW_FAILURES' | 'NO_NEW_FAILURES_BASELINE_FAILURES_REMAIN' | 'ALL_PASS' | 'BLOCKED';

export interface CollectedTest {
  id: string;
  file: string;
  fullName: string;
  caseIndex: number | null;
  status: Status;
  fingerprints: string[];
}

export interface Observation {
  collectedIds: string[];
  tests: CollectedTest[];
  suiteErrors: string[];
  rawCounts: Record<string, number>;
  rawExitCode: number | null;
}

export interface BaselineTest {
  id: string;
  status: 'always-fail' | 'flaky' | 'pass';
  observedStatuses: Status[];
  fingerprints: string[];
}

export interface Baseline {
  version: 1;
  project: Project;
  commit: string;
  collectedIds: string[];
  observations: Observation[];
  tests: BaselineTest[];
}

export interface BaselineDiff {
  verdict: Verdict;
  project: Project;
  baselineCommit: string | null;
  rawCounts: Record<string, number>;
  rawExitCode: number | null;
  newFailures: { id: string; reason: string; fingerprints: string[] }[];
  knownFailures: string[];
  knownFlaky: string[];
  fixed: string[];
  missing: string[];
  newSkipped: string[];
  suiteErrors: string[];
  blockedReason: string | null;
}

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const skipped = (status: Status) => ['pending', 'skipped', 'todo', 'disabled'].includes(status);

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected object`);
  }
  return value as Record<string, unknown>;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`Invalid ${label}: expected string array`);
  }
  return value;
}

function relativeFile(name: string, root: string, project: Project): string {
  const path = name.replaceAll('\\', '/');
  const base = root.replaceAll('\\', '/').replace(/\/$/, '');
  const relative = /^[a-z]:\//i.test(path)
    ? win32.relative(base, path).replaceAll('\\', '/')
    : posix.relative(base, path);
  if (!relative.startsWith(`apps/${project}/`) || relative.split('/').includes('..')) {
    throw new Error(`Reporter file outside project ${project}: ${name}`);
  }
  return relative;
}

/** Run-specific timestamps in test titles must not make IDs differ between runs. */
export function normalizeTestName(name: string): string {
  return name
    .replace(/(?<!\d)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?(?![\d])/g, '<timestamp>')
    .replace(/(?<!\d)\d{13}(?!\d)/g, '<epoch-ms>');
}

/** Keep assertion values intact; replace only explicitly volatile runtime fields. */
export function failureFingerprint(message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0] ?? '';
  const errorClass = /^([\w.]+(?:Error|Exception)|Error|AssertionError)(?::|$)/.exec(firstLine)?.[1] ?? 'Error';
  const normalized = firstLine
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\b/g, '<timestamp>')
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<timestamp>')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|milliseconds?|seconds?|secs?)\b/g, '<duration>')
    .replace(/\b(pid[\s:=#]+)\d+\b/gi, '$1<pid>')
    .replace(/\(node:\d+\)/g, '(node:<pid>)')
    .replace(/(?:[A-Za-z]:[\\/][^\r\n"'<>]*?[\\/]AppData[\\/]Local[\\/]Temp[\\/]|(?:[A-Za-z]:)?[\\/](?:tmp|temp)[\\/])[^\s"'<>),]*/gi, '<temp>')
    .replace(/(?:[A-Za-z]:)?[\\/][^\s"'<>]*?[\\/]\.tmp[\\/][^\s"'<>),]*/gi, '<temp>')
    .replace(/((?:https?:\/\/[^\s/:]+)|(?:\b(?:localhost|\d{1,3}(?:\.\d{1,3}){3}))|(?:\[[\da-f:]+\])):\d+\b/gi, '$1:<port>')
    .replace(/\b(port["']?[\s:=]+)\d+\b/gi, '$1<port>');
  const errno = [...new Set(message.match(/\bE[A-Z][A-Z0-9_]{2,}\b/g) ?? [])].sort();
  return JSON.stringify({ errorClass, message: normalized, errno });
}

export function collectObservation(
  input: unknown,
  project: Project,
  options: { repoRoot?: string; exitCode?: number | null } = {},
): Observation {
  const report = record(input, 'reporter');
  if (!Array.isArray(report.testResults)) throw new Error('Invalid reporter: missing testResults');
  const tests: CollectedTest[] = [];
  const suiteErrors: string[] = [];
  const ids = new Set<string>();
  const rawCounts: Record<string, number> = {};
  for (const [key, value] of Object.entries(report)) {
    if (key.startsWith('num') && typeof value === 'number') rawCounts[key] = value;
  }
  for (const item of report.testResults) {
    const suite = record(item, 'suite');
    if (typeof suite.name !== 'string' || !Array.isArray(suite.assertionResults)) {
      throw new Error('Invalid suite: missing name or assertionResults');
    }
    const file = relativeFile(suite.name, options.repoRoot ?? repositoryRoot, project);
    const assertions = suite.assertionResults.map((value) => {
      const assertion = record(value, 'assertion');
      if (typeof assertion.title !== 'string') throw new Error('Invalid assertion title');
      const fullName = [...strings(assertion.ancestorTitles, 'ancestorTitles'), assertion.title].join(' ');
      const status = assertion.status;
      if (!['passed', 'failed', 'pending', 'skipped', 'todo', 'disabled'].includes(String(status))) {
        throw new Error(`Invalid assertion status: ${String(status)}`);
      }
      return { assertion, fullName: normalizeTestName(fullName), status: status as Status };
    });
    const totals = new Map<string, number>();
    const indices = new Map<string, number>();
    for (const { fullName } of assertions) totals.set(fullName, (totals.get(fullName) ?? 0) + 1);
    for (const { assertion, fullName, status } of assertions) {
      // Vitest emits parameter cases in declaration/collection order, not completion order.
      // Never use status, duration, or the failure text to disambiguate their identity.
      const ordinal = indices.get(fullName) ?? 0;
      indices.set(fullName, ordinal + 1);
      const caseIndex = (totals.get(fullName) ?? 0) > 1 ? ordinal : null;
      const id = JSON.stringify([project, file, fullName, caseIndex]);
      if (ids.has(id)) throw new Error(`Duplicate test ID without disambiguation: ${id}`);
      ids.add(id);
      const failures = strings(assertion.failureMessages, 'failureMessages');
      if (status === 'failed' && failures.length === 0) suiteErrors.push(`${id}: failed without diagnostic`);
      tests.push({ id, file, fullName, caseIndex, status, fingerprints: failures.map(failureFingerprint) });
    }
    if (typeof suite.message === 'string' && suite.message.trim()) suiteErrors.push(`${file}: ${suite.message}`);
    if (suite.testExecError) suiteErrors.push(`${file}: ${JSON.stringify(suite.testExecError)}`);
    if (suite.status === 'failed' && !assertions.some((test) => test.status === 'failed')) {
      suiteErrors.push(`${file}: suite failed outside assertions`);
    }
  }
  if (Array.isArray(report.unhandledErrors) && report.unhandledErrors.length) {
    suiteErrors.push(`Unhandled runner errors: ${JSON.stringify(report.unhandledErrors)}`);
  }
  if (typeof report.numRuntimeErrorTestSuites === 'number' && report.numRuntimeErrorTestSuites > 0) {
    suiteErrors.push(`Runtime error suites: ${report.numRuntimeErrorTestSuites}`);
  }
  if (report.numTotalTests !== tests.length) suiteErrors.push('Reporter collection count does not match numTotalTests');
  const failed = tests.filter((test) => test.status === 'failed').length;
  if (report.numFailedTests !== failed) suiteErrors.push('Reporter failure count does not match assertions');
  if (record(report.snapshot ?? {}, 'snapshot').failure === true) suiteErrors.push('Snapshot failure');
  const rawExitCode = options.exitCode ?? null;
  if ((rawExitCode !== null && rawExitCode !== 0 && rawExitCode !== 1)
    || (rawExitCode === 1 && failed === 0)
    || (report.success === false && failed === 0 && suiteErrors.length === 0)) {
    suiteErrors.push(`Runner crash or unexplained failure (exit ${rawExitCode})`);
  }
  return { collectedIds: [...ids].sort(), tests, suiteErrors, rawCounts, rawExitCode };
}

export function importBaseline(project: Project, commit: string, observations: Observation[]): Baseline {
  if (!commit.trim() || observations.length === 0) throw new Error('A commit and at least one observation are required');
  const collectedIds = [...new Set(observations.flatMap((observation) => observation.collectedIds))].sort();
  const maps = observations.map((observation) => new Map(observation.tests.map((test) => [test.id, test])));
  const tests = collectedIds.map((id): BaselineTest => {
    const samples = maps.map((map) => map.get(id));
    const observedStatuses = [...new Set(samples.flatMap((test) => test ? [test.status] : []))];
    const status = samples.every((test) => test?.status === 'failed') ? 'always-fail'
      : samples.every((test) => test?.status === 'passed') ? 'pass' : 'flaky';
    return { id, status, observedStatuses, fingerprints: [...new Set(samples.flatMap((test) => test?.fingerprints ?? []))].sort() };
  });
  return { version: 1, project, commit, collectedIds, observations, tests };
}

export function judgeBaseline(
  baseline: Baseline | null,
  current: Observation | null,
  project: Project,
  options: { reporterError?: string; exitCode?: number | null } = {},
): BaselineDiff {
  const diff: BaselineDiff = {
    verdict: 'ALL_PASS', project, baselineCommit: baseline?.commit ?? null,
    rawCounts: current?.rawCounts ?? {}, rawExitCode: options.exitCode ?? current?.rawExitCode ?? null,
    newFailures: [], knownFailures: [], knownFlaky: [], fixed: [], missing: [], newSkipped: [],
    suiteErrors: [...(current?.suiteErrors ?? [])], blockedReason: null,
  };
  if (!baseline || baseline.project !== project) {
    diff.verdict = 'BLOCKED';
    diff.blockedReason = baseline ? 'Baseline belongs to a different project' : 'Baseline is missing or unparseable';
    return diff;
  }
  if (!current || options.reporterError) {
    diff.suiteErrors.push(options.reporterError ?? 'Reporter file is missing or unparseable');
    diff.verdict = 'NEW_FAILURES';
    return diff;
  }
  const previous = new Map(baseline.tests.map((test) => [test.id, test]));
  const currentIds = new Set(current.collectedIds);
  diff.missing = baseline.collectedIds.filter((id) => !currentIds.has(id));
  for (const test of current.tests) {
    const old = previous.get(test.id);
    if (skipped(test.status) && !old?.observedStatuses.includes(test.status)) diff.newSkipped.push(test.id);
    if (test.status === 'passed' && old?.fingerprints.length) diff.fixed.push(test.id);
    if (test.status !== 'failed') continue;
    if (old?.status === 'flaky' && old.observedStatuses.includes('failed')) {
      diff.knownFlaky.push(test.id);
    } else if (old?.status === 'always-fail' && test.fingerprints.every((value) => old.fingerprints.includes(value))) {
      diff.knownFailures.push(test.id);
    } else {
      diff.newFailures.push({
        id: test.id,
        reason: !old ? 'new-test' : old.status === 'pass' ? 'previously-passed' : 'changed-fingerprint',
        fingerprints: test.fingerprints,
      });
    }
  }
  if (diff.newFailures.length || diff.missing.length || diff.newSkipped.length || diff.suiteErrors.length) {
    diff.verdict = 'NEW_FAILURES';
  } else if (diff.knownFailures.length || diff.knownFlaky.length) {
    diff.verdict = 'NO_NEW_FAILURES_BASELINE_FAILURES_REMAIN';
  }
  return diff;
}
