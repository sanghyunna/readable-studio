import type { Response } from 'express';
import { createApiErrorResponse, type ApiError, type ApiErrorCode } from '@readable-studio/contracts';

export function sendJson(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

export function sendApiError(res: Response, status: number, error: ApiError): void {
  res.status(status).json(createApiErrorResponse(error));
}

const ERROR_STATUS_BY_CODE: Partial<Record<ApiErrorCode, number>> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  HOSTED_OVERLOADED: 429,
  HOSTED_CAPACITY_EXHAUSTED: 503,
  HOSTED_QUOTA_EXCEEDED: 413,
  HOSTED_RUNTIME_UNAVAILABLE: 503,
  HOSTED_RUN_CANCELED: 409,
  HOSTED_RUN_TIMED_OUT: 504,
  RETRY_KEY_REUSED: 409,
  HOSTED_SHUTDOWN_TIMEOUT: 504,
  HOSTED_ORIGIN_INVALID: 403,
  HOSTED_CSRF_INVALID: 419,
  HOSTED_PROVIDER_INVALID: 400,
  HOSTED_PROVIDER_MISSING: 409,
  HOSTED_PROVIDER_TEST_FAILED: 502,
  HOSTED_PROVIDER_TEST_TIMED_OUT: 504,
  PROJECT_NOT_FOUND: 404,
  CONVERSATION_NOT_FOUND: 404,
  CHECKPOINT_NOT_FOUND: 404,
  MESSAGE_NOT_FOUND: 404,
  FILE_NOT_FOUND: 404,
  ARTIFACT_NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
  AGENT_UNAVAILABLE: 503,
  UPSTREAM_UNAVAILABLE: 502,
};

export function statusForError(error: ApiError): number {
  return ERROR_STATUS_BY_CODE[error.code] ?? 500;
}
