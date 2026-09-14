import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  API_ERROR_CODES,
  createApiErrorResponse,
  type AgentInfo,
  type AgentModelOption,
  type ApiErrorResponse,
  type DatabricksAuthState,
  type DatabricksAvailability,
  type DatabricksClientRequest,
  type DatabricksConnectionMode,
  type DatabricksSetupRequest,
  type DatabricksSetupResponse,
  type DatabricksProfile,
  type DatabricksStatusResponse,
  type DatabricksEndpointApi,
  type DatabricksEndpointKind,
  type DatabricksError,
  type DatabricksErrorCode,
  type DatabricksErrorResponse,
  type DatabricksLookupRequest,
  type DatabricksLoginRequest, type DatabricksLoginResponse, type DatabricksLoginState,
  type DatabricksRegisteredEndpoint,
  type DatabricksScanResponse,
  type DatabricksScanState,
  type DatabricksVerifyRequest,
} from '../src/index.js';

const errorCodes = [
  'DATABRICKS_CLI_MISSING',
  'DATABRICKS_CLI_UNSUPPORTED',
  'DATABRICKS_AUTH_REQUIRED',
  'DATABRICKS_KEYRING_UNAVAILABLE',
  'DATABRICKS_PERMISSION_DENIED',
  'DATABRICKS_SCAN_EXPIRED',
  'DATABRICKS_STALE_REVISION',
  'DATABRICKS_UNSUPPORTED_DIALECT',
  'DATABRICKS_VERIFICATION_REQUIRED',
  'DATABRICKS_RATE_LIMITED',
  'DATABRICKS_UPSTREAM_UNAVAILABLE',
] as const satisfies readonly DatabricksErrorCode[];

describe('Databricks contracts', () => {
  it('exports the exact state and protocol unions through the barrel', () => {
    expectTypeOf<DatabricksAuthState>().toEqualTypeOf<
      'unchecked' | 'authenticated' | 'auth-required' | 'unsupported-auth' | 'keyring-unavailable' | 'unreachable'
    >();
    expectTypeOf<DatabricksScanState>().toEqualTypeOf<
      'queued' | 'running' | 'complete' | 'partial' | 'failed' | 'cancelled'
    >();
    expectTypeOf<DatabricksAvailability>().toEqualTypeOf<
      'compatible' | 'verification-required' | 'unavailable' | 'stale'
    >();
    expectTypeOf<DatabricksEndpointKind>().toEqualTypeOf<'serving-endpoint' | 'uc-model-service'>();
    expectTypeOf<DatabricksEndpointApi>().toEqualTypeOf<'openai-completions' | 'anthropic-messages' | null>();
  });

  it('freezes browser login request, progress states and credential-free response', () => {
    expectTypeOf<DatabricksLoginRequest>().toEqualTypeOf<{ host: string }>();
    expectTypeOf<DatabricksLoginState>().toEqualTypeOf<'starting' | 'waiting-for-browser' | 'authenticated' | 'cancelled' | 'timed-out' | 'failed'>();
    expectTypeOf<keyof DatabricksLoginResponse>().toEqualTypeOf<'loginId' | 'state' | 'createdAt' | 'deadlineAt' | 'completedAt' | 'profileId' | 'issues'>();
    expectTypeOf<DatabricksLoginResponse['profileId']>().toEqualTypeOf<string | null>();
  });

  it('adds write-only setup input and a backwards-compatible status envelope', () => {
    expectTypeOf<DatabricksConnectionMode>().toEqualTypeOf<'cli-profile' | 'workspace-token'>();
    expectTypeOf<DatabricksSetupRequest>().toEqualTypeOf<{
      mode: DatabricksConnectionMode; host?: string; token?: string; profileId?: string;
    }>();
    expectTypeOf<DatabricksSetupResponse>().toEqualTypeOf<{ profile: DatabricksProfile; status: DatabricksStatusResponse }>();
    expectTypeOf<DatabricksStatusResponse['setupRequired']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<Extract<keyof DatabricksSetupResponse, 'token' | 'host'>>().toEqualTypeOf<never>();
  });

  it('registers every domain error in the shared runtime envelope', () => {
    expectTypeOf<DatabricksErrorCode>().toEqualTypeOf<typeof errorCodes[number]>();
    expect(API_ERROR_CODES.filter((code) => code.startsWith('DATABRICKS_'))).toEqual(errorCodes);
    const error: DatabricksError = { code: 'DATABRICKS_SCAN_EXPIRED', message: 'Expired', retryable: true,
      reason: 'model-not-found', upstreamStatus: 404 };
    expectTypeOf<DatabricksError['upstreamStatus']>().toEqualTypeOf<number | null | undefined>();
    const response: DatabricksErrorResponse = { error };
    expectTypeOf<DatabricksErrorResponse>().toExtend<ApiErrorResponse>();
    expect(createApiErrorResponse(error)).toEqual(response);
  });

  it('keeps existing agent and model payloads valid without new fields', () => {
    const model: AgentModelOption = { id: 'existing', label: 'Existing' };
    const agent: AgentInfo = { id: 'pi', name: 'Pi', bin: 'pi', available: true, models: [model] };
    expect(agent.modelSelectionRequired).toBeUndefined();
    expect(agent.modelManagement).toBeUndefined();
    expect(model.source).toBeUndefined();
    expect(model.capabilities).toBeUndefined();
  });

  it('represents a partial dual-branch scan independently of pagination', () => {
    const scan: DatabricksScanResponse = {
      scanId: 's_01',
      profileId: 'p_01',
      revision: 4,
      state: 'partial',
      createdAt: '2026-09-10T00:00:00.000Z',
      startedAt: '2026-09-10T00:00:00.000Z',
      completedAt: '2026-09-10T00:00:01.000Z',
      endpoints: [],
      cursor: null,
      counters: { scopesChecked: 2, scopesInaccessible: 1, candidates: 0, excluded: 1 },
      completeness: { serving: true, uc: false, truncated: false },
      issues: [{ code: 'DATABRICKS_PERMISSION_DENIED', action: 'check-permissions', retryable: false }],
    };
    expect(JSON.parse(JSON.stringify(scan))).toEqual(scan);
    expect(scan.completeness.serving).toBe(true);
    expect(scan.completeness.uc).toBe(false);
  });

  it('allows additive real identity labels in UI DTOs without changing opaque registration fields', () => {
    expectTypeOf<DatabricksRegisteredEndpoint['displayName']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<DatabricksRegisteredEndpoint['servedModelName']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<DatabricksProfile['displayName']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<DatabricksProfile['workspaceDisplayLabel']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<DatabricksRegisteredEndpoint['id']>().toEqualTypeOf<string>();
    expectTypeOf<DatabricksRegisteredEndpoint['profileId']>().toEqualTypeOf<string>();
  });

  it('round-trips captured token maxima and explicit unknown provenance without inventing limits', () => {
    type Capabilities = DatabricksRegisteredEndpoint['capabilities'];
    const known: Capabilities = { tools: 'unknown', images: 'unknown', contextWindow: 1_000_000, maxTokens: 128_000,
      limitSources: { contextWindow: 'metadata', maxTokens: 'model-table' } };
    const unknown: Capabilities = { tools: 'unknown', images: 'unknown', contextWindow: null, maxTokens: null,
      limitSources: { contextWindow: 'unknown', maxTokens: 'unknown' } };
    expect(JSON.parse(JSON.stringify([known, unknown]))).toEqual([known, unknown]);
    expectTypeOf<NonNullable<Capabilities['limitSources']>['contextWindow']>().toEqualTypeOf<'metadata' | 'model-table' | 'unknown'>();
  });

  it('requires registration identity and explicit inference consent', () => {
    expectTypeOf<DatabricksRegisteredEndpoint['enabled']>().toEqualTypeOf<true>();
    expectTypeOf<DatabricksRegisteredEndpoint['appModelId']>().toEqualTypeOf<string>();
    expectTypeOf<DatabricksVerifyRequest['allowInference']>().toEqualTypeOf<true>();
    expectTypeOf<DatabricksVerifyRequest['expectedRevision']>().toEqualTypeOf<number>();
  });

  it('does not declare private input or arbitrary error body fields', () => {
    expectTypeOf<keyof DatabricksLookupRequest>().toEqualTypeOf<'profileId' | 'resourceId' | 'kind'>();
    expectTypeOf<keyof DatabricksClientRequest>().toEqualTypeOf<'executableId'>();
    expectTypeOf<Extract<keyof DatabricksError, 'details' | 'body' | 'host' | 'token' | 'path'>>().toEqualTypeOf<never>();
  });
});
