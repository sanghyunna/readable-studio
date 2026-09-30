import { parseDatabricksNames, type DatabricksNamedInputResult, type DatabricksNamedScanRequest, type DatabricksScanResponse } from '@readable-studio/contracts';
import { normalizeResource } from './catalogue.js';
import { DatabricksServiceError } from './client.js';
import { NamedProbeError } from './named-failure.js';
import { probeNamed } from './named-probe.js';
import type { DatabricksStore } from './store.js';
import type { WorkspaceScanOptions } from './scan.js';

export interface NamedScanContext {
  readonly store: DatabricksStore;
  readonly snapshot: DatabricksScanResponse;
  readonly signal: AbortSignal;
  readonly workspace: () => Promise<WorkspaceScanOptions>;
  readonly emit: () => void;
}
export async function runNamedScan(request: DatabricksNamedScanRequest, context: NamedScanContext): Promise<void> {
  const { snapshot, store, signal } = context;
  const rows: DatabricksNamedInputResult[] = parseDatabricksNames(request.names).map((displayName, inputIndex) => ({ inputIndex, displayName, state: 'pending', attempts: 0 }));
  snapshot.inputResults = rows; snapshot.state = 'running'; snapshot.startedAt = new Date().toISOString(); snapshot.revision++;
  context.emit();
  let workspace: WorkspaceScanOptions | undefined;
  const initial = await store.read();
  const pending: number[] = [];
  rows.forEach((row, index) => {
    const duplicates = initial.entries.filter(entry => entry.endpoint.profileId === request.profileId && entry.upstreamName === row.displayName
      && (!request.kindHint || request.kindHint === 'auto' || request.kindHint === entry.endpoint.kind));
    const duplicate = duplicates.length === 1 ? duplicates[0] : undefined;
    if (duplicate?.endpoint.enabled) {
      rows[index] = { ...row, state: 'already-registered', endpointId: duplicate.endpoint.id };
      snapshot.endpoints.push(duplicate.endpoint);
    } else pending.push(index);
  });
  try {
    if (pending.length) workspace = await context.workspace();
    const worker = async () => {
      for (;;) {
        const index = pending.shift(); if (index === undefined) return;
        const row = rows[index]; if (!row || !workspace) return;
        let attempts = 0;
        try {
          signal.throwIfAborted();
          const result = await probeNamed({ name: row.displayName, request, workspace: { ...workspace, signal }, onAttempt: () => { attempts++; } });
          await store.update(generation => {
            signal.throwIfAborted();
            if (!generation.bindings.some(binding => binding.id === request.profileId)) throw new DatabricksServiceError('DATABRICKS_AUTH_REQUIRED');
            const previous = generation.entries.find(entry => entry.endpoint.profileId === request.profileId && entry.endpoint.kind === result.resource.kind && entry.upstreamName === row.displayName);
            if (previous?.endpoint.enabled) {
              rows[index] = { ...row, state: 'already-registered', endpointId: previous.endpoint.id, attempts };
              snapshot.endpoints.push(previous.endpoint); return;
            }
            const entry = normalizeResource(generation.secret, request.profileId, result.resource);
            entry.provenance = 'manual';
            entry.endpoint.availability = 'compatible'; entry.endpoint.evidence = 'verified'; delete entry.endpoint.issue;
            entry.endpoint.reasoningOptions = result.profile.reasoning.map(id => ({ id, label: id }));
            entry.endpoint.capabilities.tools = result.tools ? 'supported' : 'unknown';
            if (result.profile.outputLimit !== undefined) {
              entry.endpoint.capabilities.maxTokens = result.profile.outputLimit;
              entry.endpoint.capabilities.limitSources = { contextWindow: entry.endpoint.capabilities.limitSources?.contextWindow ?? 'unknown',
                maxTokens: entry.endpoint.capabilities.limitSources?.contextWindow === 'advertised' || entry.endpoint.capabilities.limitSources?.contextWindow === 'default' ? 'probed' : 'endpoint' };
            }
            const outputLimit = entry.endpoint.capabilities.maxTokens;
            const namedProfile = outputLimit === null ? result.profile : { ...result.profile, outputLimit };
            entry.wireCapabilities = { responsesUnsupported: true, chatTokensField: result.profile.tokenField, requiredOutputBudget: true, omittedFields: [],
              tools: result.tools ? 'supported' : 'unknown', ...(result.tools ? { toolsCompletionVersion: 1 } : {}), namedProfile };
            generation.entries = generation.entries.filter(item => item.endpoint.id !== entry.endpoint.id);
            generation.entries.push(entry); snapshot.endpoints.push(entry.endpoint);
            rows[index] = { ...row, state: result.tools ? 'verified' : 'chat-only', endpointId: entry.endpoint.id, checks: result.checks, attempts };
            console.info('Databricks model limits resolved', { endpointId: entry.endpoint.id,
              contextSource: entry.endpoint.capabilities.limitSources?.contextWindow,
              outputSource: entry.endpoint.capabilities.limitSources?.maxTokens });
          });
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          const failure = error instanceof NamedProbeError ? error.failure : new NamedProbeError(signal.aborted ? 'cancelled' : 'workspace-unreachable').failure;
          rows[index] = { ...row, state: failure.reason === 'incomplete-response' ? 'inconclusive' : 'failed', failure, attempts };
        }
        snapshot.revision++; context.emit();
      }
    };
    await Promise.all([worker(), worker()]);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const reason = error instanceof DatabricksServiceError && error.code === 'DATABRICKS_AUTH_REQUIRED' ? 'auth-failed' : 'workspace-unreachable';
    for (const index of pending) { const row = rows[index]; if (row) rows[index] = { ...row, state: 'failed', failure: new NamedProbeError(reason).failure }; }
  }
  snapshot.state = signal.aborted ? 'cancelled' : rows.every(row => row.endpointId) ? 'complete' : rows.some(row => row.endpointId) ? 'partial' : 'failed';
  snapshot.counters.candidates = rows.length;
  snapshot.completedAt = new Date().toISOString(); snapshot.revision++;
  await store.update(generation => { if (generation.bindings.some(binding => binding.id === request.profileId)) generation.scans.push(structuredClone(snapshot)); });
  context.emit();
}
