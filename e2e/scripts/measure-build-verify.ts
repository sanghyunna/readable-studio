import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export interface PhaseInterval {
  startMs: number;
  endMs: number;
  activePhases: string[];
}

export interface PhaseSummary {
  phase: string;
  wallDurationMs: number;
  ownDurationMs: number;
  occurrences: number;
}

export interface ProcessRow {
  pid: number;
  parentPid: number;
  name: string;
  cpuPercentNormalized: number | null;
  workingSetBytes: number | null;
  handleCount: number | null;
}

export interface Sample {
  record: 'sample';
  sample: number;
  timestampMs: number;
  collectionStartMs?: number;
  collectionDurationMs?: number;
  elapsedSeconds: number;
  intervalSeconds: number | null;
  gapMs?: number;
  gap?: boolean;
  systemCpuPercentNormalized: number;
  cores?: Array<{ name: string; percentProcessorTime: number }>;
  activeCoreCount?: number;
  activeCores?: string[];
  allCoresActive?: boolean;
  treeCpuPercentNormalized: number | null;
  treeProcessCount?: number;
  treeWorkingSetBytes?: number | null;
  treeHandleCount?: number | null;
  processes?: ProcessRow[];
  commitChargeUsedBytes?: number | null;
  commitChargeLimitBytes?: number | null;
  disks?: Array<{
    name: string;
    percentBusyTime: number;
    percentIdleTime: number;
    currentQueueDepth: number;
  }>;
}

export interface ParsedLog {
  valid: boolean;
  reason?: string;
  inputHash?: string;
  intervals: PhaseInterval[];
  phases: PhaseSummary[];
  absolute: boolean;
}

export interface ParsedSamples {
  valid: boolean;
  reason?: string;
  inputHash?: string;
  samples: Sample[];
  metadata: unknown;
}

export interface PerSampleReport {
  sample: number;
  timestampMs: number;
  systemCpuPercentNormalized: number;
  pass: boolean;
  activeCoreCount: number;
  activeCores: string[];
  allCoresActive: boolean;
  treeCpuPercentNormalized: number | null;
  gap: boolean;
  gapMs: number | null;
  phases: string[];
  treeWorkingSetBytes: number | null;
  treeHandleCount: number | null;
}

export interface LowCpuSegment {
  startMs: number;
  endMs: number;
  durationMs: number;
  sampleCount: number;
  avgCpu: number;
  minCpu: number;
  phases: string[];
}

export interface BuildVerifyReport {
  valid: boolean;
  invalidReason?: string;
  metadata: {
    logInputHash?: string;
    samplesInputHash?: string;
    sampleCount: number;
    firstSampleMs: number;
    lastSampleMs: number;
    totalDurationMs: number;
  };
  phases: PhaseSummary[];
  intervals: PhaseInterval[];
  samples: PerSampleReport[];
  gaps: Array<{ sample: number; timestampMs: number; gapMs: number }>;
  lowCpuSegments: LowCpuSegment[];
  summary: {
    totalSamples: number;
    passingSamples: number;
    failingSamples: number;
    gapSamples: number;
    allCoresActiveSamples: number;
    longestLowSegmentMs: number;
    longestLowSegmentPhases: string[];
  };
}

const CPU_PASS_THRESHOLD = 80;
const GAP_MS_THRESHOLD = 100;
const GAP_INTERVAL_SECONDS = 1.5;
const GAP_TIMESTAMP_DELTA_MS = 1500;

export function detectEncoding(buffer: Buffer): 'utf-16le' | 'utf-8' {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return 'utf-16le';
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return 'utf-8';
  }
  // UTF-16 text (including ASCII represented as UTF-16) contains NUL bytes;
  // valid UTF-8 text for these logs does not. Inspect a small prefix.
  const inspect = Math.min(1024, buffer.length);
  for (let i = 0; i < inspect; i++) {
    if (buffer[i] === 0x00) return 'utf-16le';
  }
  return 'utf-8';
}

export function decodeBuffer(buffer: Buffer): string {
  const encoding = detectEncoding(buffer);
  const bomLen = encoding === 'utf-16le' ? 2 : encoding === 'utf-8' && buffer.length >= 3 && buffer[0] === 0xef ? 3 : 0;
  return new TextDecoder(encoding, { fatal: false }).decode(buffer.subarray(bomLen));
}

const PHASE_KIND_RE = /phase:(start|done|failed)\b/;
const PHASE_NAME_RE = /\bphase=([^\s\r\n]+)/;
const DURATION_RE = /\bdurationMs=(\d+)/;
const TIMESTAMP_RE = /\btimestampMs=(\d+)/;
const INPUT_HASH_RE = /(?:^|\s)(?:inputHash|input hash)[:=]\s*([A-Za-z0-9_-]+)/;

interface StackFrame {
  name: string;
  startMs: number | null;
  startOffsetMs: number;
}

interface ParsedEvent {
  time: number;
  type: 'start' | 'done';
  name: string;
}

export function parseLog(text: string): ParsedLog {
  const lines = text.split(/\r?\n/);
  const openFrames: StackFrame[] = [];
  const events: ParsedEvent[] = [];
  const phaseOccurrences = new Map<string, number>();
  let inputHash: string | undefined;
  let absolute = false;
  let offsetMs = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const hashMatch = INPUT_HASH_RE.exec(line);
    if (hashMatch?.[1] !== undefined) inputHash = hashMatch[1];

    const kindMatch = PHASE_KIND_RE.exec(line);
    const nameMatch = PHASE_NAME_RE.exec(line);
    if (!kindMatch || !nameMatch) continue;

    const kind = kindMatch[1]!;
    const durationMatch = DURATION_RE.exec(line);
    const timestampMatch = TIMESTAMP_RE.exec(line);
    const name = nameMatch[1]!;
    const durationMs = durationMatch ? parseInt(durationMatch[1]!, 10) : null;
    const timestampMs = timestampMatch ? parseInt(timestampMatch[1]!, 10) : null;
    if (timestampMs !== null) absolute = true;

    if (kind === 'start') {
      if (absolute && timestampMs === null) {
        return { valid: false, reason: 'phase:start missing timestampMs after absolute timestamps seen', intervals: [], phases: [], absolute: false };
      }
      openFrames.push({ name, startMs: timestampMs, startOffsetMs: offsetMs });
      events.push({ time: absolute ? timestampMs! : offsetMs, type: 'start', name });
      phaseOccurrences.set(name, (phaseOccurrences.get(name) ?? 0) + 1);
    } else {
      // done or failed
      const frameIndex = openFrames.map((frame) => frame.name).lastIndexOf(name);
      if (frameIndex < 0) {
        return { valid: false, reason: `phase:${kind} for ${name} with empty phase stack`, intervals: [], phases: [], absolute: false };
      }
      const top = openFrames[frameIndex]!;
      openFrames.splice(frameIndex, 1);
      let endMs: number;
      let wallMs: number;
      if (absolute) {
        if (timestampMs === null) {
          return { valid: false, reason: `phase:${kind} for ${name} missing timestampMs`, intervals: [], phases: [], absolute: false };
        }
        endMs = timestampMs;
        wallMs = durationMs ?? endMs - (top.startMs ?? endMs);
      } else {
        wallMs = durationMs ?? (offsetMs - top.startOffsetMs);
        if (wallMs < 0) wallMs = 0;
        offsetMs = top.startOffsetMs + wallMs;
        endMs = offsetMs;
      }
      events.push({ time: endMs, type: 'done', name });
    }
  }

  if (openFrames.length > 0) {
    return { valid: false, reason: `truncated log: ${openFrames.length} unclosed phase(s) starting with ${openFrames[0]?.name}`, intervals: [], phases: [], absolute };
  }

  // Build non-overlapping intervals annotated with the active phase stack.
  const intervals: PhaseInterval[] = [];
  const activeStack: string[] = [];
  let lastTime = 0;
  let endTime = 0;
  const phaseWall = new Map<string, number>();
  const phaseOwn = new Map<string, number>();

  for (const event of events) {
    if (event.time > lastTime) {
      const duration = event.time - lastTime;
      const snapshot = activeStack.slice();
      if (snapshot.length > 0) {
        intervals.push({ startMs: lastTime, endMs: event.time, activePhases: snapshot });
        for (const name of snapshot) {
          phaseWall.set(name, (phaseWall.get(name) ?? 0) + duration);
        }
        if (snapshot.length === 1) {
          const only = snapshot[0]!;
          phaseOwn.set(only, (phaseOwn.get(only) ?? 0) + duration);
        }
      }
      endTime = event.time;
    }
    if (event.type === 'start') {
      activeStack.push(event.name);
    } else {
      // done; overlapping phases may finish out of start order.
      const activeIndex = activeStack.lastIndexOf(event.name);
      if (activeIndex < 0) {
        return { valid: false, reason: `phase stack corrupted around ${event.name}`, intervals: [], phases: [], absolute };
      }
      activeStack.splice(activeIndex, 1);
    }
    lastTime = event.time;
  }

  if (activeStack.length > 0) {
    return { valid: false, reason: `truncated log: phases still open at EOF`, intervals: [], phases: [], absolute };
  }

  const phases: PhaseSummary[] = [];
  for (const [name, occurrences] of phaseOccurrences) {
    phases.push({
      phase: name,
      wallDurationMs: phaseWall.get(name) ?? 0,
      ownDurationMs: phaseOwn.get(name) ?? 0,
      occurrences,
    });
  }
  phases.sort((a, b) => b.wallDurationMs - a.wallDurationMs);

  return { valid: true, ...(inputHash !== undefined ? { inputHash } : {}), intervals, phases, absolute };
}

export function parseSamples(text: string): ParsedSamples {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const samples: Sample[] = [];
  let metadata: unknown = null;
  let inputHash: string | undefined;

  for (const line of lines) {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return { valid: false, reason: 'samples file contains invalid JSON', samples: [], metadata: null };
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      return { valid: false, reason: 'samples file line is not a JSON object', samples: [], metadata: null };
    }
    const rec = obj as Record<string, unknown>;
    if (rec.record === 'metadata') {
      metadata = rec;
      if (typeof rec.inputHash === 'string') inputHash = rec.inputHash;
    } else if (rec.record === 'sample') {
      if (typeof rec.timestampMs !== 'number' || typeof rec.systemCpuPercentNormalized !== 'number') {
        return { valid: false, reason: 'sample missing timestampMs or systemCpuPercentNormalized', samples: [], metadata };
      }
      samples.push(rec as unknown as Sample);
    }
  }

  if (samples.length === 0) {
    return { valid: false, reason: 'no samples found', samples: [], metadata };
  }

  samples.sort((a, b) => a.timestampMs - b.timestampMs);

  // Enrich each sample with deterministic gap detection.
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    let gap = false;
    let gapMs: number | null = null;
    if (s.gap === true) gap = true;
    if (typeof s.gapMs === 'number') {
      gapMs = s.gapMs;
      if (gapMs > GAP_MS_THRESHOLD) gap = true;
    }
    if (i > 0) {
      const prev = samples[i - 1]!;
      const delta = s.timestampMs - prev.timestampMs;
      if (delta > GAP_TIMESTAMP_DELTA_MS) {
        gap = true;
        gapMs = Math.max(gapMs ?? 0, delta - 1000);
      }
    }
    if (s.intervalSeconds !== null && s.intervalSeconds > GAP_INTERVAL_SECONDS) {
      gap = true;
    }
    s.gap = gap;
    if (gapMs !== null) s.gapMs = gapMs;
  }

  return { valid: true, ...(inputHash !== undefined ? { inputHash } : {}), samples, metadata };
}

function alignIntervalsToSamples(intervals: PhaseInterval[], samples: Sample[]): PhaseInterval[] {
  if (intervals.length === 0) return [];
  const firstSample = samples[0]!;
  const firstMs = firstSample.collectionStartMs ?? firstSample.timestampMs;
  const lastMs = samples[samples.length - 1]!.timestampMs;
  const offsetEnd = intervals[intervals.length - 1]!.endMs;
  const span = lastMs - firstMs;
  const scale = offsetEnd > 0 ? span / offsetEnd : 1;
  return intervals.map((iv) => ({
    startMs: firstMs + iv.startMs * scale,
    endMs: firstMs + iv.endMs * scale,
    activePhases: iv.activePhases,
  }));
}

function activePhasesAt(intervals: PhaseInterval[], timeMs: number): string[] {
  for (let i = intervals.length - 1; i >= 0; i--) {
    const iv = intervals[i]!;
    if (timeMs >= iv.startMs && timeMs < iv.endMs) return iv.activePhases.slice();
  }
  return [];
}

export function buildReport(log: ParsedLog, samples: ParsedSamples): BuildVerifyReport {
  if (!log.valid) {
    return {
      valid: false,
      ...(log.reason !== undefined ? { invalidReason: log.reason } : {}),
      metadata: { sampleCount: 0, firstSampleMs: 0, lastSampleMs: 0, totalDurationMs: 0 },
      phases: [], intervals: [], samples: [], gaps: [], lowCpuSegments: [],
      summary: { totalSamples: 0, passingSamples: 0, failingSamples: 0, gapSamples: 0, allCoresActiveSamples: 0, longestLowSegmentMs: 0, longestLowSegmentPhases: [] },
    };
  }
  if (!samples.valid) {
    return {
      valid: false,
      ...(samples.reason !== undefined ? { invalidReason: samples.reason } : {}),
      metadata: { sampleCount: 0, firstSampleMs: 0, lastSampleMs: 0, totalDurationMs: 0 },
      phases: log.phases, intervals: [], samples: [], gaps: [], lowCpuSegments: [],
      summary: { totalSamples: 0, passingSamples: 0, failingSamples: 0, gapSamples: 0, allCoresActiveSamples: 0, longestLowSegmentMs: 0, longestLowSegmentPhases: [] },
    };
  }
  if (log.inputHash && samples.inputHash && log.inputHash !== samples.inputHash) {
    return {
      valid: false,
      invalidReason: `input hash mismatch: log=${log.inputHash} samples=${samples.inputHash}`,
      metadata: { sampleCount: samples.samples.length, firstSampleMs: samples.samples[0]!.timestampMs, lastSampleMs: samples.samples[samples.samples.length - 1]!.timestampMs, totalDurationMs: 0 },
      phases: log.phases, intervals: [], samples: [], gaps: [], lowCpuSegments: [],
      summary: { totalSamples: 0, passingSamples: 0, failingSamples: 0, gapSamples: 0, allCoresActiveSamples: 0, longestLowSegmentMs: 0, longestLowSegmentPhases: [] },
    };
  }

  const intervals = log.absolute ? log.intervals : alignIntervalsToSamples(log.intervals, samples.samples);
  const firstMs = samples.samples[0]!.timestampMs;
  const lastMs = samples.samples[samples.samples.length - 1]!.timestampMs;

  const perSample: PerSampleReport[] = [];
  const gaps: Array<{ sample: number; timestampMs: number; gapMs: number }> = [];
  let passing = 0;
  let failing = 0;
  let gapSamples = 0;
  let allCoresActive = 0;

  for (const s of samples.samples) {
    const sampleTime = s.collectionStartMs ?? s.timestampMs;
    const phases = activePhasesAt(intervals, sampleTime);
    const pass = s.systemCpuPercentNormalized > CPU_PASS_THRESHOLD;
    const activeCoreCount = s.activeCoreCount ?? (s.cores ? s.cores.filter((c) => c.percentProcessorTime > 0).length : 0);
    const activeCores = s.activeCores ?? (s.cores ? s.cores.filter((c) => c.percentProcessorTime > 0).map((c) => c.name) : []);
    const allActive = s.allCoresActive ?? activeCoreCount >= 20;
    if (pass) passing++; else failing++;
    if (s.gap) gapSamples++;
    if (allActive) allCoresActive++;
    const gapMs = typeof s.gapMs === 'number' ? s.gapMs : 0;
    if (s.gap) gaps.push({ sample: s.sample, timestampMs: s.timestampMs, gapMs });
    perSample.push({
      sample: s.sample,
      timestampMs: s.timestampMs,
      systemCpuPercentNormalized: s.systemCpuPercentNormalized,
      pass,
      activeCoreCount,
      activeCores,
      allCoresActive: allActive,
      treeCpuPercentNormalized: s.treeCpuPercentNormalized ?? null,
      gap: !!s.gap,
      gapMs: s.gap ?? false ? gapMs : null,
      phases,
      treeWorkingSetBytes: s.treeWorkingSetBytes ?? null,
      treeHandleCount: s.treeHandleCount ?? null,
    });
  }

  // Any gap invalidates the measurement: we cannot prove the >80% rule held
  // during unobserved seconds.
  if (gapSamples > 0) {
    return {
      valid: false,
      invalidReason: `sample gap(s) detected (${gapSamples} sample(s))`,
      metadata: { sampleCount: samples.samples.length, firstSampleMs: firstMs, lastSampleMs: lastMs, totalDurationMs: lastMs - firstMs + 1000 },
      phases: log.phases,
      intervals,
      samples: perSample,
      gaps,
      lowCpuSegments: [],
      summary: { totalSamples: samples.samples.length, passingSamples: passing, failingSamples: failing, gapSamples, allCoresActiveSamples: allCoresActive, longestLowSegmentMs: 0, longestLowSegmentPhases: [] },
    };
  }

  // Find contiguous low-CPU segments; report them honestly, not averaged away.
  const lowSegments: LowCpuSegment[] = [];
  let current: { startIdx: number; samples: Sample[] } | null = null;
  for (let i = 0; i < samples.samples.length; i++) {
    const s = samples.samples[i]!;
    const low = s.systemCpuPercentNormalized <= CPU_PASS_THRESHOLD;
    if (low && current === null) {
      current = { startIdx: i, samples: [s] };
    } else if (low && current !== null) {
      current.samples.push(s);
    } else if (!low && current !== null) {
      lowSegments.push(buildSegment(current.samples, samples.samples, intervals));
      current = null;
    }
  }
  if (current !== null) {
    lowSegments.push(buildSegment(current.samples, samples.samples, intervals));
  }

  lowSegments.sort((a, b) => b.durationMs - a.durationMs);

  const longest = lowSegments[0];
  const summary = {
    totalSamples: samples.samples.length,
    passingSamples: passing,
    failingSamples: failing,
    gapSamples,
    allCoresActiveSamples: allCoresActive,
    longestLowSegmentMs: longest?.durationMs ?? 0,
    longestLowSegmentPhases: longest?.phases ?? [],
  };

  return {
    valid: true,
    metadata: {
      ...(log.inputHash !== undefined ? { logInputHash: log.inputHash } : {}),
      ...(samples.inputHash !== undefined ? { samplesInputHash: samples.inputHash } : {}),
      sampleCount: samples.samples.length,
      firstSampleMs: firstMs,
      lastSampleMs: lastMs,
      totalDurationMs: lastMs - firstMs + 1000,
    },
    phases: log.phases,
    intervals,
    samples: perSample,
    gaps,
    lowCpuSegments: lowSegments,
    summary,
  };
}

function buildSegment(segmentSamples: Sample[], allSamples: Sample[], intervals: PhaseInterval[]): LowCpuSegment {
  const startMs = segmentSamples[0]!.timestampMs;
  const last = segmentSamples[segmentSamples.length - 1]!;
  const nextIdx = allSamples.findIndex((s) => s.timestampMs > last.timestampMs);
  const endMs = nextIdx >= 0 ? allSamples[nextIdx]!.timestampMs : last.timestampMs + 1000;
  const durationMs = endMs - startMs;
  const cpus = segmentSamples.map((s) => s.systemCpuPercentNormalized);
  const avg = cpus.reduce((a, b) => a + b, 0) / cpus.length;
  const min = Math.min(...cpus);
  const phaseSet = new Set<string>();
  for (const s of segmentSamples) {
    const t = s.collectionStartMs ?? s.timestampMs;
    for (const name of activePhasesAt(intervals, t)) phaseSet.add(name);
  }
  return {
    startMs,
    endMs,
    durationMs,
    sampleCount: segmentSamples.length,
    avgCpu: Math.round(avg * 1000) / 1000,
    minCpu: Math.round(min * 1000) / 1000,
    phases: Array.from(phaseSet).sort(),
  };
}

export async function run(argv: string[]): Promise<void> {
  let logPath: string | undefined;
  let samplesPath: string | undefined;
  let outPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--log' || arg === '-l') && i + 1 < argv.length) logPath = argv[++i];
    else if ((arg === '--samples' || arg === '-s') && i + 1 < argv.length) samplesPath = argv[++i];
    else if ((arg === '--out' || arg === '-o') && i + 1 < argv.length) outPath = argv[++i];
  }
  if (!logPath || !samplesPath || !outPath) {
    console.error('Usage: tsx measure-build-verify.ts --log <file> --samples <file> --out <json>');
    process.exit(1);
  }

  const logBuffer = await readFile(logPath);
  const samplesBuffer = await readFile(samplesPath);
  const logText = decodeBuffer(logBuffer);
  const samplesText = decodeBuffer(samplesBuffer);
  const log = parseLog(logText);
  const samples = parseSamples(samplesText);
  const report = buildReport(log, samples);
  await writeFile(outPath, JSON.stringify(report, null, 2));
  if (!report.valid) {
    console.error(`Invalid: ${report.invalidReason}`);
    process.exit(2);
  }
}

if (process.argv.length > 1 && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(process.argv.slice(2));
}
