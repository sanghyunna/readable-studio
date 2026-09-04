import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const specPath = fileURLToPath(
  new URL('../e2e/ui/home-capability-reachability.test.ts', import.meta.url),
);
const source = await readFile(specPath, 'utf8');

function section(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`home capability guard markers are missing or out of order: ${startMarker}, ${endMarker}`);
  }
  return source.slice(start + startMarker.length, end);
}

function matches(input: string, pattern: RegExp): string[] {
  return [...input.matchAll(pattern)].map((match) => match[1]).filter((value): value is string => value !== undefined);
}

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  return [...repeated].sort();
}

const controlsSource = section('// CONTROL_LIST_START', '// CONTROL_LIST_END');
const assertionsSource = section('// ASSERTION_MAP_START', '// ASSERTION_MAP_END');
const controlIds = matches(controlsSource, /\bid:\s*'([^']+)'/g);
const assertionIds = matches(assertionsSource, /'([^']+)'\s*:\s*'[^']+'/g);

const errors: string[] = [];
const duplicateControls = duplicates(controlIds);
const duplicateAssertions = duplicates(assertionIds);
if (duplicateControls.length > 0) errors.push(`duplicate control ids: ${duplicateControls.join(', ')}`);
if (duplicateAssertions.length > 0) errors.push(`duplicate assertion ids: ${duplicateAssertions.join(', ')}`);

const controls = new Set(controlIds);
const assertions = new Set(assertionIds);
const missing = [...controls].filter((id) => !assertions.has(id)).sort();
const stale = [...assertions].filter((id) => !controls.has(id)).sort();
if (missing.length > 0) errors.push(`control ids without assertions: ${missing.join(', ')}`);
if (stale.length > 0) errors.push(`assertions without control ids: ${stale.join(', ')}`);

const auditIds = controlIds.filter((id) => id.startsWith('audit-A-'));
const regressionIds = controlIds.filter((id) => id.startsWith('regression-'));
const reconciledIds = controlIds.filter((id) => id.startsWith('section-C-'));
if (auditIds.length !== 46) errors.push(`expected 46 audit-A controls, found ${auditIds.length}`);
if (regressionIds.length !== 49) errors.push(`expected regressions 01-49, found ${regressionIds.length}`);
if (reconciledIds.length !== 10) errors.push(`expected 10 section-C controls, found ${reconciledIds.length}`);

// Absence is fail-closed: every intentionally removed surface needs an exact
// inventory entry and a durable reason. Any other `expect: 'absent'` remains a
// structural-guard failure rather than silently shrinking capability coverage.
const INTENTIONALLY_ABSENT_CONTROLS = {
  'regression-46': 'EntryHelpMenu was deliberately removed from the product; no Help trigger or menu should render.',
  'regression-49': 'The retired first-run onboarding route must continue to resolve to Home without rendering onboarding.',
} as const;
const absentIds = matches(controlsSource, /\bid:\s*'([^']+)'[^\n]*expect:\s*'absent'/g).sort();
const intentionallyAbsentIds = Object.keys(INTENTIONALLY_ABSENT_CONTROLS).sort();
if (
  absentIds.length !== intentionallyAbsentIds.length ||
  absentIds.some((id, index) => id !== intentionallyAbsentIds[index])
) {
  errors.push(
    `intentionally absent controls must be exactly ${intentionallyAbsentIds.join(', ')}; found: ${absentIds.join(', ') || '(none)'}`,
  );
}

if (errors.length > 0) {
  console.error('Home capability structural guard failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Home capability structural guard passed: ${controlIds.length} controls, ${assertionIds.length} assertions.`);
}
