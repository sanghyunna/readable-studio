// Phase 4 / spec §11.5 / plan §3.AA1 — plugin diff helper.
//
// Pure helper that compares two InstalledPluginRecord values (or
// two AppliedPluginSnapshot values) and returns a structured
// report of every field that changed. The author dev-loop needs
// this when:
//
//   - debugging replay invariance ('why does my snapshot's prompt
//     block differ from the previous run?'),
//   - reviewing a github-installed plugin's bump ('what changed in
//     v0.2.0 vs. v0.1.5?'),
//   - inspecting a fork ('how does my edit deviate from upstream?').
//
// The report is intentionally shallow per field so the CLI's
// renderer can show a useful one-line summary without dragging in
// a generic diff library. Deep object diffs (e.g. context.skills[]
// content) collapse to a single 'changed' summary with the count
// of additions / removals.

import type { InstalledPluginRecord, PluginManifest } from '@readable-studio/contracts';

export interface PluginDiffEntry {
  field:    string;
  // 'added' = present in b but not a; 'removed' = inverse;
  // 'changed' = both sides have it but values differ.
  kind:     'added' | 'removed' | 'changed';
  // Stringified for display. CLI renders as `<a> -> <b>`.
  before?:  string;
  after?:   string;
  // Optional human hint for collection-shaped fields (e.g.
  // 'inputs[]: 2 added, 1 removed').
  summary?: string;
}

export interface PluginDiffReport {
  // Same id when both sides share an id; otherwise the diff
  // surfaces the rename via the entries.
  pluginId?: string;
  // Stable, sorted by field path so re-runs produce byte-equal
  // output (modulo timestamps).
  entries: PluginDiffEntry[];
  // Aggregate count for at-a-glance audit.
  added:    number;
  removed:  number;
  changed:  number;
}

export interface DiffPluginsInput {
  a: InstalledPluginRecord;
  b: InstalledPluginRecord;
}

export function diffPlugins(input: DiffPluginsInput): PluginDiffReport {
  const out: PluginDiffEntry[] = [];

  // Top-level record fields that matter to the user.
  diffScalar(out, 'id',        input.a.id,                input.b.id);
  diffScalar(out, 'title',     input.a.title,             input.b.title);
  diffScalar(out, 'version',   input.a.version,           input.b.version);
  diffScalar(out, 'sourceKind', input.a.sourceKind,       input.b.sourceKind);
  diffScalar(out, 'source',    input.a.source,            input.b.source);
  diffScalar(out, 'trust',     input.a.trust,             input.b.trust);
  diffArray(out,  'capabilitiesGranted', input.a.capabilitiesGranted, input.b.capabilitiesGranted);

  // Manifest body — the field set the prompt + apply paths read.
  diffManifest(out, input.a.manifest, input.b.manifest);

  out.sort((a, b) => a.field.localeCompare(b.field));

  let added = 0; let removed = 0; let changed = 0;
  for (const e of out) {
    if (e.kind === 'added')   added++;
    if (e.kind === 'removed') removed++;
    if (e.kind === 'changed') changed++;
  }

  const report: PluginDiffReport = { entries: out, added, removed, changed };
  if (input.a.id === input.b.id) report.pluginId = input.a.id;
  return report;
}

function diffManifest(out: PluginDiffEntry[], a: PluginManifest, b: PluginManifest): void {
  diffScalar(out, 'manifest.title',       a.title,        b.title);
  diffScalar(out, 'manifest.version',     a.version,      b.version);
  diffScalar(out, 'manifest.description', a.description,  b.description);
  diffScalar(out, 'manifest.license',     a.license,      b.license);
  diffArray (out, 'manifest.tags',        a.tags ?? [],    b.tags ?? []);
  diffScalar(out, 'readable.kind',              a.readable?.kind,      b.readable?.kind);
  diffScalar(out, 'readable.taskKind',          a.readable?.taskKind,  b.readable?.taskKind);
  diffScalar(out, 'readable.mode',              a.readable?.mode,      b.readable?.mode);
  diffArray (out, 'readable.capabilities',      a.readable?.capabilities ?? [], b.readable?.capabilities ?? []);
  diffArray (out, 'readable.inputs[]',
    (a.readable?.inputs ?? []).map((i) => i?.name).filter(Boolean) as string[],
    (b.readable?.inputs ?? []).map((i) => i?.name).filter(Boolean) as string[]);
  diffArray (out, 'readable.context.skills',
    (a.readable?.context?.skills ?? []).map((s) => s?.ref ?? s?.path ?? '').filter(Boolean),
    (b.readable?.context?.skills ?? []).map((s) => s?.ref ?? s?.path ?? '').filter(Boolean));
  diffArray (out, 'readable.context.craft',
    (a.readable?.context?.craft ?? []).slice() as string[],
    (b.readable?.context?.craft ?? []).slice() as string[]);
  diffArray (out, 'readable.context.assets',
    (a.readable?.context?.assets ?? []).slice() as string[],
    (b.readable?.context?.assets ?? []).slice() as string[]);
  diffPipeline(out, a.readable?.pipeline, b.readable?.pipeline);
  diffArray (out, 'readable.genui.surfaces',
    (a.readable?.genui?.surfaces ?? []).map((s) => s?.id ?? '').filter(Boolean),
    (b.readable?.genui?.surfaces ?? []).map((s) => s?.id ?? '').filter(Boolean));
}

function diffPipeline(
  out: PluginDiffEntry[],
  a: PluginManifest['readable'] extends infer T ? T extends { pipeline?: infer P } ? Exclude<P, undefined> | undefined : never : never,
  b: PluginManifest['readable'] extends infer T ? T extends { pipeline?: infer P } ? Exclude<P, undefined> | undefined : never : never,
): void {
  if (!a && !b) return;
  if (!a && b) {
    out.push({ field: 'readable.pipeline', kind: 'added',
      after: stagesSummary(b!.stages) });
    return;
  }
  if (a && !b) {
    out.push({ field: 'readable.pipeline', kind: 'removed',
      before: stagesSummary(a.stages) });
    return;
  }
  diffArray(out, 'readable.pipeline.stages',
    (a!.stages ?? []).map((s) => s.id),
    (b!.stages ?? []).map((s) => s.id));
  // Per-stage atoms diff. Key by stage id; stages added or removed
  // surface above already.
  const aById = new Map((a!.stages ?? []).map((s) => [s.id, s] as const));
  const bById = new Map((b!.stages ?? []).map((s) => [s.id, s] as const));
  for (const id of new Set([...aById.keys(), ...bById.keys()])) {
    const sa = aById.get(id);
    const sb = bById.get(id);
    if (!sa || !sb) continue; // covered by stages-array diff above
    diffArray(out, `readable.pipeline.stages[${id}].atoms`,
      sa.atoms ?? [], sb.atoms ?? []);
    diffScalar(out, `readable.pipeline.stages[${id}].until`, sa.until, sb.until);
    diffScalar(out, `readable.pipeline.stages[${id}].repeat`,
      sa.repeat === undefined ? undefined : String(sa.repeat),
      sb.repeat === undefined ? undefined : String(sb.repeat));
  }
}

function stagesSummary(stages: ReadonlyArray<{ id: string }> | undefined): string {
  if (!stages || stages.length === 0) return '<empty>';
  return stages.map((s) => s.id).join(' \u2192 ');
}

function diffScalar(out: PluginDiffEntry[], field: string, a: unknown, b: unknown): void {
  const aPresent = a !== undefined && a !== null;
  const bPresent = b !== undefined && b !== null;
  if (!aPresent && !bPresent) return;
  if (!aPresent && bPresent)  { out.push({ field, kind: 'added',   after: String(b) }); return; }
  if (aPresent && !bPresent)  { out.push({ field, kind: 'removed', before: String(a) }); return; }
  // Both present.
  if (toComparable(a) === toComparable(b)) return;
  out.push({ field, kind: 'changed', before: String(a), after: String(b) });
}

function diffArray(out: PluginDiffEntry[], field: string, a: ReadonlyArray<string>, b: ReadonlyArray<string>): void {
  const setA = new Set(a);
  const setB = new Set(b);
  const added   = [...setB].filter((x) => !setA.has(x));
  const removed = [...setA].filter((x) => !setB.has(x));
  if (added.length === 0 && removed.length === 0) {
    // Detect order changes that aren't set-changes.
    if (a.length === b.length && a.every((v, i) => v === b[i])) return;
    out.push({ field, kind: 'changed',
      before: a.join(','),
      after:  b.join(','),
      summary: `reordered (${a.length} entries)`,
    });
    return;
  }
  out.push({
    field,
    kind: 'changed',
    summary: `${added.length} added, ${removed.length} removed`,
    before: removed.join(','),
    after:  added.join(','),
  });
}

function toComparable(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  try { return JSON.stringify(value); } catch { return String(value); }
}
