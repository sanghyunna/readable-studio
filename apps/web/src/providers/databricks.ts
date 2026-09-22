// Thin client for the daemon's Databricks routes.
//
// Every call maps 1:1 onto a `/api/databricks/*` endpoint and returns the
// contract DTO unchanged. Errors surface as `DatabricksApiError` carrying the
// sanitized daemon envelope (`code`, `retryable`) so the UI can branch on the
// code without ever seeing credentials, hosts or upstream bodies.

import type {
  DatabricksDisableRequest,
  DatabricksEnableRequest,
  DatabricksEndpointResponse,
  DatabricksErrorResponse,
  DatabricksLoginRequest,
  DatabricksLoginResponse,
  DatabricksLookupRequest,
  DatabricksModelResponse,
  DatabricksModelsRequest,
  DatabricksModelsResponse,
  DatabricksProbeRequest,
  DatabricksProfilesResponse,
  DatabricksScanEvent,
  DatabricksScanPageRequest,
  DatabricksScanRequest,
  DatabricksScanResponse,
  DatabricksSetupRequest,
  DatabricksSetupResponse,
  DatabricksStatusResponse,
} from '@readable-studio/contracts';
import { parseSseFrame } from './sse';

const BASE = '/api/databricks';

export type {
  DatabricksConnectionMode,
  DatabricksSetupRequest,
  DatabricksSetupResponse,
  DatabricksStatusResponse as DatabricksStatusWithSetup,
} from '@readable-studio/contracts';

export class DatabricksApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryable: boolean;

  constructor(status: number, code: string | null, message: string, retryable: boolean) {
    super(message);
    this.name = 'DatabricksApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

async function toApiError(resp: Response): Promise<DatabricksApiError> {
  const body = (await resp.json().catch(() => null)) as
    | Partial<DatabricksErrorResponse>
    | null;
  const error = body?.error;
  return new DatabricksApiError(
    resp.status,
    typeof error?.code === 'string' ? error.code : null,
    typeof error?.message === 'string' && error.message
      ? error.message
      : `Databricks request failed (${resp.status})`,
    error?.retryable === true,
  );
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, { cache: 'no-store', ...init });
  if (!resp.ok) throw await toApiError(resp);
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

export function fetchDatabricksStatus(): Promise<DatabricksStatusResponse> {
  return request<DatabricksStatusResponse>('/status');
}

/**
 * Saves a workspace connection (or pins a CLI profile) and returns the
 * connection as a scannable profile. The token travels in this one request
 * body only; the sanitized error envelope never echoes it back.
 */
export function setupDatabricks(req: DatabricksSetupRequest): Promise<DatabricksSetupResponse> {
  return request<DatabricksSetupResponse>('/setup', jsonInit('POST', req));
}

/**
 * Starts a browser (SSO) sign-in owned by the installed CLI and returns an
 * opaque login job. Poll `fetchDatabricksLogin` until the state settles; no
 * credential ever crosses this client.
 */
export function startDatabricksLogin(req: DatabricksLoginRequest): Promise<DatabricksLoginResponse> {
  return request<DatabricksLoginResponse>('/login', jsonInit('POST', req));
}

export function fetchDatabricksLogin(loginId: string): Promise<DatabricksLoginResponse> {
  return request<DatabricksLoginResponse>(`/login/${encodeURIComponent(loginId)}`);
}

export function cancelDatabricksLogin(loginId: string): Promise<DatabricksLoginResponse> {
  return request<DatabricksLoginResponse>(`/login/${encodeURIComponent(loginId)}`, { method: 'DELETE' });
}

export function probeDatabricks(
  req: DatabricksProbeRequest = {},
): Promise<DatabricksProfilesResponse> {
  return request<DatabricksProfilesResponse>('/probe', jsonInit('POST', req));
}

// Bounds the complete operation, including response bodies and silent SSE.
// The daemon allows 60s for credentials and 60s for discovery branches.
async function withScanDeadline<T>(work: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new DatabricksApiError(504, 'DATABRICKS_UPSTREAM_UNAVAILABLE', 'Databricks scan timed out. Try scanning again.', true));
          controller.abort();
        }, 150_000);
      }),
      work(signal),
    ]);
  } finally { clearTimeout(timer); controller.abort(); }
}

export function startDatabricksScan(
  req: DatabricksScanRequest,
): Promise<DatabricksScanResponse> {
  return withScanDeadline(signal => request<DatabricksScanResponse>('/scans', { ...jsonInit('POST', req), signal }));
}

export function fetchDatabricksScan(
  scanId: string,
  page: DatabricksScanPageRequest = {},
): Promise<DatabricksScanResponse> {
  const query = new URLSearchParams();
  if (page.cursor) query.set('cursor', page.cursor);
  if (page.limit != null) query.set('limit', String(page.limit));
  const encoded = query.toString();
  const suffix = encoded ? `?${encoded}` : '';
  return withScanDeadline(signal => request<DatabricksScanResponse>(
    `/scans/${encodeURIComponent(scanId)}${suffix}`, { signal },
  ));
}

export function cancelDatabricksScan(scanId: string): Promise<void> {
  return request<void>(`/scans/${encodeURIComponent(scanId)}`, { method: 'DELETE' });
}

export function lookupDatabricksEndpoint(
  req: DatabricksLookupRequest,
): Promise<DatabricksEndpointResponse> {
  return request<DatabricksEndpointResponse>('/lookup', jsonInit('POST', req));
}

export function fetchDatabricksModels(
  req: DatabricksModelsRequest = {},
): Promise<DatabricksModelsResponse> {
  const suffix = req.profileId
    ? `?profileId=${encodeURIComponent(req.profileId)}`
    : '';
  return request<DatabricksModelsResponse>(`/models${suffix}`);
}

export function enableDatabricksModel(
  endpointId: string,
  req: DatabricksEnableRequest,
): Promise<DatabricksModelResponse> {
  return request<DatabricksModelResponse>(
    `/models/${encodeURIComponent(endpointId)}`,
    jsonInit('PUT', req),
  );
}

export function disableDatabricksModel(
  endpointId: string,
  req: DatabricksDisableRequest,
): Promise<DatabricksModelsResponse> {
  return request<DatabricksModelsResponse>(
    `/models/${encodeURIComponent(endpointId)}`,
    jsonInit('DELETE', req),
  );
}

/** Forgets a whole workspace profile and every model registered from it. */
export function disconnectDatabricksConnection(
  connectionId: string,
): Promise<DatabricksStatusResponse> {
  return request<DatabricksStatusResponse>(
    `/connections/${encodeURIComponent(connectionId)}`,
    { method: 'DELETE' },
  );
}

export interface DatabricksScanEventHandlers {
  onEvent: (event: DatabricksScanEvent) => void;
}

export interface DatabricksScanEventsOptions {
  signal?: AbortSignal;
}

const SCAN_EVENT_TYPES = new Set(['snapshot', 'progress', 'endpoint', 'done']);

function parseScanEvent(event: string, data: Record<string, unknown>): DatabricksScanEvent | null {
  const type = typeof data.type === 'string' ? data.type : event;
  if (!SCAN_EVENT_TYPES.has(type)) return null;
  return { ...data, type } as DatabricksScanEvent;
}

/**
 * Streams `/scans/:scanId/events` until the daemon reports `done` or the stream
 * ends. Resolves `true` when a `done` event was seen, `false` when the stream
 * closed early (the caller should re-read the scan snapshot). Aborting through
 * `signal` resolves `false` without throwing.
 */
export async function streamDatabricksScanEvents(
  scanId: string,
  handlers: DatabricksScanEventHandlers,
  options: DatabricksScanEventsOptions = {},
): Promise<boolean> {
  try {
    return await withScanDeadline(signal => readDatabricksScanEvents(scanId, handlers, signal), options.signal);
  } catch (error) {
    if (options.signal?.aborted) return false;
    throw error;
  }
}

async function readDatabricksScanEvents(
  scanId: string,
  handlers: DatabricksScanEventHandlers,
  signal: AbortSignal,
): Promise<boolean> {
  const resp = await fetch(`${BASE}/scans/${encodeURIComponent(scanId)}/events`, {
    cache: 'no-store',
    headers: { Accept: 'text/event-stream' },
    signal,
  });
  if (!resp.ok) throw await toApiError(resp);
  if (!resp.body) return false;

  const reader = resp.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;

  const consume = (frame: string) => {
    const parsed = parseSseFrame(frame);
    if (!parsed || parsed.kind !== 'event') return;
    if (parsed.event === 'error') {
      const error = parsed.data.error as DatabricksErrorResponse['error'] | undefined;
      throw new DatabricksApiError(503, error?.code ?? null, error?.message ?? 'Databricks scan failed.', error?.retryable === true);
    }
    const event = parseScanEvent(parsed.event, parsed.data);
    if (!event) return;
    handlers.onEvent(event);
    if (event.type === 'done') done = true;
  };

  try {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let separator = buffer.indexOf('\n\n');
      while (separator !== -1 && !done) {
        consume(buffer.slice(0, separator));
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf('\n\n');
      }
    }
    if (!done && buffer.trim()) consume(buffer);
  } catch (err) {
    if (signal.aborted) return false;
    throw err;
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
  }
  return done;
}
