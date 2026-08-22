// Plugin doctor. Surfaces pre-apply lint diagnostics:
//
//   - Validates the manifest using @readable-studio/plugin-runtime's validateSafe.
//   - Cross-checks atom ids against the FIRST_PARTY_ATOMS catalog (warns on
//     planned atoms, errors on unknown atoms).
//   - Re-resolves context against the live registry and reports any refs that
//     the registry could not bind (skills/design-systems/craft).
//   - Compares the registry-cached manifestSourceDigest against a freshly
//     computed digest and flips snapshots to `stale` when the upstream plugin
//     changed under their feet.
//
// Phase 1 returns a flat list of issues rather than a JSON-structured report;
// the CLI renders them as `readable plugin doctor <id>` output. Spec §11.5 promises
// a richer report (severity / kind enum) which we'll layer in once Phase 4
// adds the diagnostics endpoint.

import { manifestSourceDigest, resolveContext, validateSafe, type RegistryView } from '@readable-studio/plugin-runtime';
import type { InstalledPluginRecord } from '@readable-studio/contracts';
import { findAtom, isImplementedAtom, isKnownAtom } from './atoms.js';
import { isParseableUntil } from './until.js';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  field?: string;
}

export interface DoctorReport {
  pluginId: string;
  ok: boolean;
  issues: Diagnostic[];
  freshDigest: string;
}

export function doctorPlugin(
  plugin: InstalledPluginRecord,
  registry: RegistryView,
  options?: {
    warnOnMissingRefs?: boolean;
  },
): DoctorReport {
  const issues: Diagnostic[] = [];
  const manifest = plugin.manifest;

  const validation = validateSafe(manifest);
  for (const err of validation.errors) {
    issues.push({ severity: 'error', code: 'manifest.invalid', message: err });
  }
  for (const warn of validation.warnings) {
    issues.push({ severity: 'warning', code: 'manifest.warning', message: warn });
  }

  for (const atomId of manifest.readable?.context?.atoms ?? []) {
    if (!isKnownAtom(atomId)) {
      issues.push({
        severity: 'error',
        code: 'atom.unknown',
        message: `Unknown atom id: '${atomId}'.`,
        field: 'readable.context.atoms',
      });
    } else if (!isImplementedAtom(atomId)) {
      const atom = findAtom(atomId);
      issues.push({
        severity: 'warning',
        code: 'atom.planned',
        message: `Atom '${atomId}'${atom ? ` (${atom.label})` : ''} is planned but not yet implemented; runs will skip this atom.`,
        field: 'readable.context.atoms',
      });
    }
  }

  for (const stage of manifest.readable?.pipeline?.stages ?? []) {
    for (const atomId of stage.atoms ?? []) {
      if (!isKnownAtom(atomId)) {
        issues.push({
          severity: 'error',
          code: 'atom.unknown',
          message: `Pipeline stage '${stage.id}' references unknown atom '${atomId}'.`,
          field: `readable.pipeline.stages.${stage.id}`,
        });
      }
    }
    if (stage.repeat === true && !stage.until) {
      issues.push({
        severity: 'error',
        code: 'pipeline.until-missing',
        message: `Pipeline stage '${stage.id}' sets repeat:true but no until expression.`,
        field: `readable.pipeline.stages.${stage.id}`,
      });
    }
    if (stage.until && !isParseableUntil(stage.until)) {
      issues.push({
        severity: 'error',
        code: 'pipeline.until-invalid',
        message: `Pipeline stage '${stage.id}' has an unparseable until expression: '${stage.until}'.`,
        field: `readable.pipeline.stages.${stage.id}`,
      });
    }
  }

  // Plan §3.K3 / spec §10.3.5 — surface.component capability gate.
  // A plugin that ships a custom React component must declare the
  // `genui:custom-component` capability so the trust gate at apply
  // time can refuse it for restricted installs.
  for (const surface of manifest.readable?.genui?.surfaces ?? []) {
    if (!surface.component) continue;
    const declared = new Set(manifest.readable?.capabilities ?? []);
    if (!declared.has('genui:custom-component')) {
      issues.push({
        severity: 'error',
        code:     'genui.component-capability',
        message:  `Surface '${surface.id}' ships a component but the manifest does not declare the 'genui:custom-component' capability.`,
        field:    'readable.genui.surfaces',
      });
    }
    if (surface.component.path.includes('..')) {
      issues.push({
        severity: 'error',
        code:     'genui.component-traversal',
        message:  `Surface '${surface.id}' component path must be relative without traversal segments.`,
        field:    'readable.genui.surfaces',
      });
    }
  }

  const resolved = resolveContext(manifest, {
    registry,
    warnOnMissing: options?.warnOnMissingRefs ?? true,
  });
  for (const warn of resolved.warnings) {
    issues.push({ severity: 'warning', code: 'context.unresolved', message: warn });
  }

  const freshDigest = manifestSourceDigest({
    manifest,
    inputs: {},
    resolvedContextRefs: resolved.digestRefs,
  });
  if (plugin.sourceDigest && plugin.sourceDigest !== freshDigest) {
    issues.push({
      severity: 'warning',
      code: 'digest.drift',
      message: `Cached source digest '${plugin.sourceDigest.slice(0, 12)}…' differs from fresh '${freshDigest.slice(0, 12)}…'. Existing snapshots may be marked stale.`,
    });
  }

  const ok = issues.every((d) => d.severity !== 'error');
  return { pluginId: plugin.id, ok, issues, freshDigest };
}

