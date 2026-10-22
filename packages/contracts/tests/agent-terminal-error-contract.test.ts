import { expect, it } from 'vitest';
import { API_ERROR_CODES, createApiError } from '../src/errors';

it.each(['AGENT_QUOTA_EXHAUSTED', 'AGENT_MODEL_UNAVAILABLE'] as const)('preserves the terminal %s machine cause', code => {
  expect(API_ERROR_CODES).toContain(code);
  expect(createApiError(code, 'Provider detail', { retryable: false }))
    .toEqual({ code, message: 'Provider detail', retryable: false });
});
