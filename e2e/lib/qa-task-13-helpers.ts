import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { Page } from '@playwright/test';

const helperDir = dirname(fileURLToPath(import.meta.url));
const mainRepo = resolve(helperDir, '../..');

export const evidenceDir =
  process.env.READABLE_TASK13_EVIDENCE_DIR ?? resolve(mainRepo, '.omo/evidence/task-13');

const referenceDir = resolve(mainRepo, '.tmp/design/main-hub/shots');

export const references = {
  start: 'r1-start.png',
  filtered: 'f2-empty-cleared.png',
  busy: 'h3-busy.png',
  error: 'h2-error.png',
  collapsed: 'g1-collapsed.png',
  narrow: 'f3-narrow.png',
  palette: 'final-3-palette.png',
} as const;

export type CanonicalState = keyof typeof references;

export function resolveReferencePath(reference: (typeof references)[CanonicalState]): string {
  return resolve(referenceDir, reference);
}

export interface RegionEvidence {
  readonly region: `R${number}`;
  readonly state: string;
  readonly pass: boolean;
  readonly anchor: string;
  readonly observation: string;
}

interface DiffEvidence {
  readonly state: CanonicalState;
  readonly reference: string;
  readonly actual: string;
  readonly dimensionsMatch: boolean;
  readonly width: number;
  readonly height: number;
  readonly diffPixels: number;
  readonly diffRatio: number;
  readonly similarityScore: number;
}

const regions: RegionEvidence[] = [];
const diffs: DiffEvidence[] = [];

function readPng(path: string): PNG {
  const bytes = readFileSync(path);
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error(`${path} is not a PNG`);
  }
  return PNG.sync.read(bytes);
}

for (const reference of Object.values(references)) {
  const path = resolveReferencePath(reference);
  if (!statSync(path).isFile()) throw new Error(`${path} is not a file`);
  const image = readPng(path);
  if (image.width < 1 || image.height < 1) throw new Error(`${path} has invalid dimensions`);
}

export function recordRegion(evidence: RegionEvidence): void {
  regions.push(evidence);
}

export async function captureCanonical(page: Page, state: CanonicalState): Promise<DiffEvidence> {
  mkdirSync(evidenceDir, { recursive: true });
  const actualPath = resolve(evidenceDir, `13-${state}.png`);
  const referencePath = resolveReferencePath(references[state]);
  await page.screenshot({ path: actualPath, fullPage: false, animations: 'disabled' });

  const actual = readPng(actualPath);
  const reference = readPng(referencePath);
  const dimensionsMatch = actual.width === reference.width && actual.height === reference.height;
  if (!dimensionsMatch) {
    throw new Error(
      `${state} dimensions ${actual.width}x${actual.height}; expected ${reference.width}x${reference.height}`,
    );
  }

  const output = new PNG({ width: reference.width, height: reference.height });
  const diffPixels = pixelmatch(reference.data, actual.data, output.data, reference.width, reference.height, {
    threshold: 0.1,
    includeAA: false,
  });
  const totalPixels = reference.width * reference.height;
  const result: DiffEvidence = {
    state,
    reference: referencePath,
    actual: actualPath,
    dimensionsMatch,
    width: actual.width,
    height: actual.height,
    diffPixels,
    diffRatio: diffPixels / totalPixels,
    similarityScore: 100 * (1 - diffPixels / totalPixels),
  };
  writeFileSync(resolve(evidenceDir, `13-${state}-diff.png`), PNG.sync.write(output));
  writeFileSync(resolve(evidenceDir, `13-${state}-diff.json`), JSON.stringify(result, null, 2));
  diffs.push(result);
  return result;
}

export function flushReport(): void {
  mkdirSync(evidenceDir, { recursive: true });
  const ordered = [...regions].sort((a, b) => {
    const byRegion = Number(a.region.slice(1)) - Number(b.region.slice(1));
    return byRegion || a.state.localeCompare(b.state);
  });
  const missing = Array.from({ length: 18 }, (_, index) => `R${index + 1}`).filter(
    (region) => !ordered.some((row) => row.region === region),
  );
  if (missing.length > 0) throw new Error(`region report incomplete: ${missing.join(', ')}`);

  const lines = [
    '# Task 13 rendered region report',
    '',
    '| Region | State | Verdict | Numeric anchor | Rendered observation |',
    '|---|---|---|---|---|',
    ...ordered.map(
      (row) =>
        `| ${row.region} | ${row.state} | ${row.pass ? 'PASS' : 'FAIL'} | ${row.anchor} | ${row.observation} |`,
    ),
    '',
    '## Canonical pixel comparisons',
    '',
    '| State | Reference | Dimensions | Diff ratio | Similarity |',
    '|---|---|---:|---:|---:|',
    ...diffs.map(
      (diff) =>
        `| ${diff.state} | ${references[diff.state]} | ${diff.width}x${diff.height} | ${diff.diffRatio.toFixed(6)} | ${diff.similarityScore.toFixed(3)} |`,
    ),
    '',
    'Dark theme is contrast/accent extrapolation only; the approved mockup references are light-theme.',
  ];
  writeFileSync(resolve(evidenceDir, 'region-report.md'), `${lines.join('\n')}\n`);
  writeFileSync(
    resolve(evidenceDir, 'region-report.json'),
    JSON.stringify({ regions: ordered, comparisons: diffs }, null, 2),
  );
}
