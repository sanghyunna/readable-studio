import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
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

const specPath = resolve(dirname(fileURLToPath(import.meta.url)), '../ui/qa-task-13.test.ts');

interface AnchorSite {
  readonly label: string;
  readonly anchor: ts.Expression;
}

/**
 * Collects the `anchor` expression of every `recordRegion` record in the Task 13
 * spec, covering both call shapes: a direct object literal, and the
 * `[region, pass, anchor, observation]` tuples fed through the shared loop.
 */
function collectAnchorSites(): AnchorSite[] {
  const source = ts.createSourceFile(
    specPath,
    readFileSync(specPath, 'utf8'),
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
  const sites: AnchorSite[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'recordRegion'
    ) {
      const [argument] = node.arguments;
      if (!argument || !ts.isObjectLiteralExpression(argument)) {
        throw new Error(`recordRegion is called without an object literal at ${specPath}`);
      }
      const named = (name: string): ts.ObjectLiteralElementLike | undefined =>
        argument.properties.find(
          (property) =>
            (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
            && ts.isIdentifier(property.name)
            && property.name.text === name,
        );
      const anchorProperty = named('anchor');
      if (!anchorProperty) throw new Error(`recordRegion record without an anchor at ${specPath}`);
      if (ts.isPropertyAssignment(anchorProperty)) {
        const regionProperty = named('region');
        const label =
          regionProperty
          && ts.isPropertyAssignment(regionProperty)
          && ts.isStringLiteral(regionProperty.initializer)
            ? regionProperty.initializer.text
            : 'unknown-region';
        sites.push({ label, anchor: anchorProperty.initializer });
      }
    }
    if (ts.isArrayLiteralExpression(node) && node.elements.length === 4) {
      const [region, , anchor] = node.elements;
      if (region && anchor && ts.isStringLiteral(region) && /^R\d+$/u.test(region.text)) {
        sites.push({ label: region.text, anchor });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

describe('Task 13 region anchors report what they measured', () => {
  test('every anchor is a template built from measured values', () => {
    const sites = collectAnchorSites();
    expect(sites).toHaveLength(19);
    const constant = sites.filter(
      ({ anchor }) => !ts.isTemplateExpression(anchor) || anchor.templateSpans.length === 0,
    );
    expect(constant.map(({ label }) => label)).toEqual([]);
  });

  test('no anchor asserts a value the record never substitutes', () => {
    const claim = /[A-Za-z_][\w-]*=/gu;
    const offenders: string[] = [];
    for (const { label, anchor } of collectAnchorSites()) {
      if (!ts.isTemplateExpression(anchor)) continue;
      const spans = anchor.templateSpans;
      // Every chunk except the final one is immediately followed by a
      // substitution; a `key=` claim is honest only when the measured value is
      // what comes next, so it must sit at the very end of its chunk. The final
      // chunk has nothing after it and therefore may not open a claim at all.
      const substituted = [anchor.head.text, ...spans.slice(0, -1).map((span) => span.literal.text)];
      const tail = spans.at(-1)?.literal.text ?? '';
      for (const chunk of substituted) {
        for (const match of chunk.matchAll(claim)) {
          if (match.index + match[0].length !== chunk.length) {
            offenders.push(`${label}: hardcoded ${match[0]}`);
          }
        }
      }
      for (const match of tail.matchAll(claim)) offenders.push(`${label}: hardcoded ${match[0]}`);
    }
    expect(offenders).toEqual([]);
  });
});

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
