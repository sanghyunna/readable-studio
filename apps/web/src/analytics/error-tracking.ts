// Web observability compatibility surface.
//
// The upstream app used this module as a direct-fetch safety telemetry
// transport. This fork keeps the public functions so existing call sites
// remain type-clean, but dispatch is a hard no-op and no browser exception,
// resource, long-task, boot-timing, or white-screen event leaves the app.

import { scrubExceptionList, scrubFilePath } from './scrub';

interface ExceptionTrackingContext {
  apiKey: string;
  host: string;
  distinctId: string;
  appVersion?: string;
  sessionId?: string;
  telemetryEnv?: string;
}

interface BufferedSafetyEvent {
  eventName: string;
  body: { properties: Record<string, unknown> };
  timestamp: string;
}

// Cap the compatibility buffer so a chain of early errors (e.g. an infinite
// render loop) cannot grow indefinitely. 50 is enough to capture the burst
// that usually surrounds a real bug while keeping the memory footprint trivial.
const MAX_BUFFER_SIZE = 50;

let context: ExceptionTrackingContext | null = null;
const buffer: BufferedSafetyEvent[] = [];
let installed = false;

export function setExceptionTrackingContext(next: ExceptionTrackingContext): void {
  context = next;
  if (buffer.length === 0) return;
  const drain = buffer.splice(0, buffer.length);
  for (const item of drain) {
    dispatch(item);
  }
}

export function clearExceptionTrackingContext(): void {
  context = null;
}

// Called once at app boot. Idempotent — repeated calls are no-ops.
export function installErrorHandlers(): void {
  if (installed) return;
  if (typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (event) => {
    captureException(event.error, event.message ?? 'Uncaught error', {
      filename: typeof event.filename === 'string' ? event.filename : undefined,
      lineno: typeof event.lineno === 'number' ? event.lineno : undefined,
      colno: typeof event.colno === 'number' ? event.colno : undefined,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const fallback =
      typeof reason === 'string' ? reason : 'Unhandled promise rejection';
    captureException(reason, fallback);
  });
}

// Public entry point retained for code paths that catch their own error.
// Unhandled errors go through the window listeners above, then stop at the
// no-op dispatch boundary.
export function reportHandledException(error: unknown, message?: string): void {
  captureException(error, message ?? defaultMessage(error), { handled: true });
}

interface CaptureMetadata {
  filename?: string;
  lineno?: number;
  colno?: number;
  handled?: boolean;
}

function captureException(
  error: unknown,
  fallbackMessage: string,
  metadata: CaptureMetadata = {},
): void {
  const list = buildExceptionList(error, fallbackMessage, metadata);
  const scrubbed = scrubExceptionList(list);
  const properties: Record<string, unknown> = {
    $exception_list: scrubbed,
    $exception_type: scrubbed[0]?.type,
    $exception_message: scrubbed[0]?.value,
    $exception_source: scrubFirstFrameSource(scrubbed),
    $current_url: scrubUrl(typeof window !== 'undefined' ? window.location.href : ''),
    $insert_id: randomId(),
    capture_source: 'web/error-tracking',
    handled: metadata.handled === true,
  };

  enqueue('$exception', properties);
}

// Generic observability surface retained for existing non-exception call sites
// (long tasks, white screens, resource errors, boot timing, visibility
// changes, etc.). Events are parsed and scrubbed locally, then dropped.
export function reportSafetyEvent(
  eventName: string,
  properties: Record<string, unknown> = {},
): void {
  const merged: Record<string, unknown> = {
    ...properties,
    $current_url: scrubUrl(typeof window !== 'undefined' ? window.location.href : ''),
    $insert_id: randomId(),
    capture_source: 'web/error-tracking',
  };
  enqueue(eventName, merged);
}

function enqueue(eventName: string, properties: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const item: BufferedSafetyEvent = {
    eventName,
    body: { properties },
    timestamp,
  };
  if (context == null) {
    if (buffer.length >= MAX_BUFFER_SIZE) buffer.shift();
    buffer.push(item);
    return;
  }
  dispatch(item);
}

function dispatch(_item: BufferedSafetyEvent): void {
  // Telemetry network egress is hard-removed in this fork. This used to POST
  // safety events to a remote ingest endpoint; that is now a no-op, which
  // zeroes ALL observability egress: white-screen,
  // boot-timing, long-task, visibility, resource-error, and exceptions all
  // funnel through here. The buffer/scrub/parse machinery above is kept
  // intact (harmless) so the module's public surface stays type-clean.
  return;
}

function buildExceptionList(
  error: unknown,
  fallbackMessage: string,
  metadata: CaptureMetadata,
): Array<Record<string, unknown>> {
  const isError = error instanceof Error;
  const type = isError ? error.name : typeof error === 'string' ? 'Error' : 'NonError';
  const value = isError
    ? error.message
    : typeof error === 'string'
      ? error
      : fallbackMessage;
  const stack = isError && typeof error.stack === 'string' ? error.stack : '';
  const frames = parseStack(stack, metadata);
  return [
    {
      type,
      value,
      stacktrace: { type: 'raw', frames },
      mechanism: {
        type: metadata.handled === true ? 'handled' : 'generic',
        handled: metadata.handled === true,
      },
    },
  ];
}

// Minimal stack parser. Covers V8 (`at Foo (url:1:2)` and `at url:1:2`)
// and the SpiderMonkey-style `Foo@url:1:2`. Lines we cannot parse are
// kept as a raw line so the report stays useful even without symbolicated
// frames.
const STACK_RE_V8 = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/;
const STACK_RE_SPIDERMONKEY = /^(.*?)@(.+?):(\d+):(\d+)$/;

function parseStack(stack: string, metadata: CaptureMetadata): Array<Record<string, unknown>> {
  if (!stack) {
    if (metadata.filename) {
      return [
        {
          function: '<anonymous>',
          filename: metadata.filename,
          abs_path: metadata.filename,
          lineno: metadata.lineno ?? 0,
          colno: metadata.colno ?? 0,
          in_app: true,
        },
      ];
    }
    return [];
  }
  const lines = stack.split('\n');
  // The first line is usually the message (e.g. "TypeError: foo is not a
  // function") rather than a frame — skip it when it doesn't start with
  // `at` or contain `@`.
  const frameLines = lines[0]?.match(/^\s*at\b|@/) ? lines : lines.slice(1);
  return frameLines
    .map((line) => parseFrame(line))
    .filter((frame): frame is Record<string, unknown> => frame != null);
}

function parseFrame(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const v8 = STACK_RE_V8.exec(trimmed);
  if (v8) {
    return {
      function: v8[1] ?? '<anonymous>',
      filename: v8[2],
      abs_path: v8[2],
      lineno: Number(v8[3]),
      colno: Number(v8[4]),
      in_app: true,
    };
  }
  const sm = STACK_RE_SPIDERMONKEY.exec(trimmed);
  if (sm) {
    return {
      function: sm[1] || '<anonymous>',
      filename: sm[2],
      abs_path: sm[2],
      lineno: Number(sm[3]),
      colno: Number(sm[4]),
      in_app: true,
    };
  }
  return { raw: trimmed, in_app: true };
}

function scrubFirstFrameSource(list: Array<Record<string, unknown>>): string | undefined {
  const first = list[0];
  if (!first) return undefined;
  const stacktrace = first.stacktrace as
    | { frames?: Array<{ abs_path?: unknown }> }
    | undefined;
  const frame = stacktrace?.frames?.[0];
  if (frame == null || typeof frame.abs_path !== 'string') return undefined;
  // Already scrubbed by scrubExceptionList; just narrow the type.
  return frame.abs_path;
}

function scrubUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function defaultMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return 'Unknown error';
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for older browsers / SSR. Collision risk is negligible because
  // this only needs to dedupe within a single user-session window.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Re-exported helpers for the file-path scrub so callers that hand-build
// frames (e.g. legacy code paths) can apply the same redaction without
// reaching into scrub.ts directly.
export { scrubFilePath };
