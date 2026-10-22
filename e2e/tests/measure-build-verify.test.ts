import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildReport,
  decodeBuffer,
  parseLog,
  parseSamples,
  run,
} from '../scripts/measure-build-verify.ts';

function sampleLine(sample: number, timestampMs: number, cpu: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    record: 'sample',
    sample,
    timestampMs,
    collectionStartMs: timestampMs,
    elapsedSeconds: sample,
    intervalSeconds: sample === 0 ? null : 1,
    systemCpuPercentNormalized: cpu,
    treeCpuPercentNormalized: cpu / 2,
    cores: Array.from({ length: 20 }, (_, i) => ({ name: String(i), percentProcessorTime: cpu > 80 ? 5 : 0 })),
    activeCoreCount: cpu > 80 ? 20 : 0,
    activeCores: cpu > 80 ? Array.from({ length: 20 }, (_, i) => String(i)) : [],
    allCoresActive: cpu > 80,
    ...extra,
  });
}

function samplesText(cpus: number[], inputHash?: string, gapAt?: number): string {
  const metadata = JSON.stringify({ record: 'metadata', schemaVersion: 2, ...(inputHash ? { inputHash } : {}) });
  const lines = cpus.map((cpu, index) => sampleLine(index, 1_000 + index * (gapAt === index ? 2_000 : 1_000), cpu, gapAt === index ? { gap: true, gapMs: 1_000 } : {}));
  return [metadata, ...lines].join('\n') + '\n';
}

describe('measure-build-verify', () => {
  it('decodes UTF-16LE and does not double count nested phases', () => {
    const log = [
      'inputHash=abc123',
      '[tools-pack win] phase:start phase=acquire timestampMs=1000',
      '[tools-pack win] phase:start phase=electron-builder-raw timestampMs=1100',
      '[tools-pack win] phase:done durationMs=300 phase=electron-builder-raw timestampMs=1400',
      '[tools-pack win] phase:done durationMs=500 phase=acquire timestampMs=1500',
    ].join('\r\n');
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(log, 'utf16le')]);
    const decoded = decodeBuffer(utf16);
    const parsedLog = parseLog(decoded);
    const parsedSamples = parseSamples(samplesText([90, 90], 'abc123'));
    const report = buildReport(parsedLog, parsedSamples);

    expect(report.valid).toBe(true);
    expect(report.phases.find((phase) => phase.phase === 'acquire')).toMatchObject({
      wallDurationMs: 500,
      ownDurationMs: 200,
    });
    expect(report.intervals.reduce((sum, interval) => sum + interval.endMs - interval.startMs, 0)).toBe(500);
    expect(report.metadata.logInputHash).toBe('abc123');
  });

  it('marks a truncated phase log invalid', () => {
    const log = '[tools-pack win] phase:start phase=acquire timestampMs=1000\n';
    const report = buildReport(parseLog(log), parseSamples(samplesText([90])));
    expect(report.valid).toBe(false);
    expect(report.invalidReason).toMatch(/truncated/i);
  });

  it('marks missing samples and sample gaps invalid', () => {
    const missing = buildReport(parseLog('[tools-pack win] phase:start phase=x timestampMs=1000\n[tools-pack win] phase:done durationMs=100 phase=x timestampMs=1100'), parseSamples(''));
    expect(missing.valid).toBe(false);
    expect(missing.invalidReason).toMatch(/no samples/i);

    const gap = buildReport(
      parseLog('[tools-pack win] phase:start phase=x timestampMs=1000\n[tools-pack win] phase:done durationMs=3000 phase=x timestampMs=4000'),
      parseSamples(samplesText([90, 90], undefined, 1)),
    );
    expect(gap.valid).toBe(false);
    expect(gap.invalidReason).toMatch(/gap/i);
    expect(gap.gaps).toHaveLength(1);
  });

  it('marks mismatched input hashes invalid', () => {
    const log = '[tools-pack win] inputHash=log-hash\n[tools-pack win] phase:start phase=x timestampMs=1000\n[tools-pack win] phase:done durationMs=100 phase=x timestampMs=1100';
    const report = buildReport(parseLog(log), parseSamples(samplesText([90], 'sample-hash')));
    expect(report.valid).toBe(false);
    expect(report.invalidReason).toMatch(/input hash mismatch/i);
  });

  it('reports a low-CPU tail segment instead of averaging it away', () => {
    const log = [
      '[tools-pack win] phase:start phase=zip:cache timestampMs=1000',
      '[tools-pack win] phase:done durationMs=4000 phase=zip:cache timestampMs=5000',
    ].join('\n');
    const report = buildReport(parseLog(log), parseSamples(samplesText([95, 95, 20, 10])));
    expect(report.valid).toBe(true);
    expect(report.summary.failingSamples).toBe(2);
    expect(report.lowCpuSegments[0]).toMatchObject({
      sampleCount: 2,
      minCpu: 10,
      phases: ['zip:cache'],
    });
    expect(report.lowCpuSegments[0]?.durationMs).toBeGreaterThanOrEqual(1_500);
  });

  it('writes the CLI report to --out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'measure-build-verify-'));
    try {
      const logPath = join(dir, 'build.log');
      const samplesPath = join(dir, 'samples.jsonl');
      const outPath = join(dir, 'report.json');
      await writeFile(logPath, '[tools-pack win] phase:start phase=x timestampMs=1000\n[tools-pack win] phase:done durationMs=1000 phase=x timestampMs=2000\n');
      await writeFile(samplesPath, samplesText([90, 90]));
      await run(['--log', logPath, '--samples', samplesPath, '--out', outPath]);
      const output = JSON.parse(await readFile(outPath, 'utf8')) as { valid: boolean };
      expect(output.valid).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
