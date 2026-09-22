import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabricksFailureDetail } from '@readable-studio/contracts';
import { redactText } from '@readable-studio/diagnostics';
import { redactSecrets } from '../redact.js';
import { failureDetail } from './failure.js';

export const DATABRICKS_FAILURE_CAPTURE_NAME = 'last-gateway-failure.json';

export type DatabricksRouteKind = 'chat-completions' | 'anthropic-messages' | 'openai-responses' | 'serving-invocations';

type RedactedJson = string | readonly RedactedJson[] | { readonly [key: string]: RedactedJson };
type SafeJson = null | boolean | number | string | readonly SafeJson[] | { readonly [key: string]: SafeJson };

export interface DatabricksFailureCaptureInput {
  readonly routeKind: DatabricksRouteKind;
  readonly endpoint: URL;
  readonly model: string;
  readonly appModelId: string;
  readonly endpointId: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly status: number | null;
  readonly upstreamBody: unknown;
  readonly privateValues?: readonly string[];
  readonly capturedAt?: string;
}

export interface DatabricksFailureCapture {
  readonly schemaVersion: 1;
  readonly diagnosticOutcome: 'gateway-rejection' | 'transport-failure';
  readonly captureStatus: 'captured';
  readonly capturedAt: string;
  readonly route: {
    readonly kind: DatabricksRouteKind;
    readonly endpoint: { readonly id: string; readonly origin: '[redacted]'; readonly pathTemplate: string; readonly sha256: string };
    readonly model: { readonly appModelId: string; readonly upstreamValue: '[redacted]'; readonly sha256: string };
  };
  readonly request: {
    readonly body: RedactedJson;
    readonly indicators: {
      readonly tools: {
        readonly present: boolean;
        readonly envelope: 'none' | 'empty' | 'openai-function' | 'anthropic-input-schema' | 'responses-function' | 'mixed-or-unknown';
        readonly strict: boolean;
        readonly additionalProperties: boolean;
      };
      readonly fields: Readonly<Record<'reasoning_effort' | 'parallel_tool_calls' | 'max_completion_tokens' | 'stream_options' | 'output_config', boolean>>;
    };
  };
  readonly response: {
    readonly status: number | null;
    readonly body: SafeJson;
    readonly rejectionFields: readonly string[];
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function redactShape(value: unknown): RedactedJson {
  if (Array.isArray(value)) return value.map(redactShape);
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactShape(child)]));
  if (value === null) return '[redacted:null]';
  return `[redacted:${typeof value}]`;
}

function requestValues(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(requestValues);
  if (record(value)) return Object.values(value).flatMap(requestValues);
  return [];
}

const SENSITIVE_RESPONSE_KEY = /prompt|document|content|echo|input|output|authorization|cookie|token|secret|key/i;
function sanitizeResponse(value: unknown, secrets: readonly string[], key = ''): SafeJson {
  if (Array.isArray(value)) return value.map((child) => sanitizeResponse(child, secrets));
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([childKey, child]) =>
    [childKey, sanitizeResponse(child, secrets, childKey)]));
  if (typeof value !== 'string') return value === null || typeof value === 'boolean' || typeof value === 'number'
    ? value : `[redacted:${typeof value}]`;
  if (SENSITIVE_RESPONSE_KEY.test(key)) return '[redacted:string]';
  let safe = value;
  for (const secret of [...secrets].filter(Boolean).sort((left, right) => right.length - left.length)) {
    safe = safe.split(secret).join('[redacted]');
  }
  return redactText(redactSecrets(safe))
    .replace(/\b(Bearer|Token|Basic)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(/\b(authorization|cookie|set-cookie)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted-url]')
    .replace(/\b(?:dapi|eyJ)[A-Za-z0-9._~+\/-]{8,}\b/g, '[redacted-token]')
    .replace(/\b[A-Za-z0-9_~+\/-]{40,}\b/g, '[redacted-value]');
}

function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function pathTemplate(endpoint: URL, routeKind: DatabricksRouteKind): string {
  if (routeKind !== 'serving-invocations') return endpoint.pathname;
  return endpoint.pathname.replace(/^(\/serving-endpoints\/)[^/]+(\/invocations)$/, '$1[redacted]$2');
}

function toolEnvelope(tools: unknown): DatabricksFailureCapture['request']['indicators']['tools']['envelope'] {
  if (tools === undefined) return 'none';
  if (!Array.isArray(tools) || tools.some((tool) => !record(tool))) return 'mixed-or-unknown';
  if (tools.length === 0) return 'empty';
  if (tools.every((tool) => tool.type === 'function' && record(tool.function))) return 'openai-function';
  if (tools.every((tool) => typeof tool.name === 'string' && record(tool.input_schema))) return 'anthropic-input-schema';
  if (tools.every((tool) => tool.type === 'function' && typeof tool.name === 'string')) return 'responses-function';
  return 'mixed-or-unknown';
}

function schemaKeyword(tools: unknown, target: 'strict' | 'additionalProperties'): boolean {
  const visit = (value: unknown, parentKey?: string): boolean => {
    if (Array.isArray(value)) return value.some((child) => visit(child, parentKey));
    if (!record(value)) return false;
    return Object.entries(value).some(([key, child]) =>
      key === target && !['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'].includes(parentKey ?? '')
      || visit(child, key));
  };
  return visit(tools);
}

const REJECTION_FIELDS = [
  'tools', 'strict', 'additionalProperties', 'reasoning_effort', 'parallel_tool_calls',
  'max_completion_tokens', 'stream_options', 'output_config',
] as const;

function rejectionFields(value: unknown): string[] {
  const strings: string[] = [];
  const collect = (child: unknown): void => {
    if (typeof child === 'string') strings.push(child);
    else if (Array.isArray(child)) child.forEach(collect);
    else if (record(child)) Object.values(child).forEach(collect);
  };
  collect(value);
  return REJECTION_FIELDS.filter((field) => strings.some((text) => text.includes(field)));
}

export function createDatabricksFailureCapture(input: DatabricksFailureCaptureInput): DatabricksFailureCapture {
  const tools = input.body.tools;
  return {
    schemaVersion: 1,
    diagnosticOutcome: input.status === null ? 'transport-failure' : 'gateway-rejection',
    captureStatus: 'captured',
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    route: {
      kind: input.routeKind,
      endpoint: { id: input.endpointId, origin: '[redacted]', pathTemplate: pathTemplate(input.endpoint, input.routeKind), sha256: fingerprint(input.endpoint.href) },
      model: { appModelId: input.appModelId, upstreamValue: '[redacted]', sha256: fingerprint(input.model) },
    },
    request: {
      body: redactShape(input.body),
      indicators: {
        tools: {
          present: Object.hasOwn(input.body, 'tools'),
          envelope: toolEnvelope(tools),
          strict: schemaKeyword(tools, 'strict'),
          additionalProperties: schemaKeyword(tools, 'additionalProperties'),
        },
        fields: {
          reasoning_effort: Object.hasOwn(input.body, 'reasoning_effort'),
          parallel_tool_calls: Object.hasOwn(input.body, 'parallel_tool_calls'),
          max_completion_tokens: Object.hasOwn(input.body, 'max_completion_tokens'),
          stream_options: Object.hasOwn(input.body, 'stream_options'),
          output_config: Object.hasOwn(input.body, 'output_config'),
        },
      },
    },
    response: {
      status: input.status,
      body: sanitizeResponse(input.upstreamBody, [...requestValues(input.body), ...(input.privateValues ?? [])]),
      rejectionFields: rejectionFields(input.upstreamBody),
    },
  };
}

/** Only the request-aware redacted capture may supply free text to logs or the child. */
export function capturedFailureDetail(original: DatabricksFailureDetail, capture: DatabricksFailureCapture): DatabricksFailureDetail {
  const payload = capture.response.body;
  const error = record(payload) && record(payload.error) ? payload.error : payload;
  if (!record(error)) return original;
  const message = original.upstreamMessage ?? (typeof error.message === 'string' ? error.message : undefined);
  const code = error.code ?? error.error_code;
  const parameter = error.param ?? error.parameter;
  const fields = [
    typeof code === 'string' ? `Code: ${code}` : undefined,
    typeof parameter === 'string' ? `Parameter: ${parameter}` : undefined,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map(value => value.replace(/[\r\n\t]+/g, ' ').slice(0, 512));
  const detail = message ? failureDetail(original.reason, original.upstreamStatus, message.replace(/[\r\n\t]+/g, ' ').slice(0, 512)) : original;
  return fields.length ? { ...detail, message: `${detail.message}; ${fields.join('; ')}` } : detail;
}

export function databricksFailureCapturePath(dataRoot: string): string {
  return join(dataRoot, 'databricks', DATABRICKS_FAILURE_CAPTURE_NAME);
}

export async function writeDatabricksFailureCapture(dataRoot: string, capture: DatabricksFailureCapture): Promise<void> {
  const destination = databricksFailureCapturePath(dataRoot);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await mkdir(join(dataRoot, 'databricks'), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify(capture, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
