import { describe, expect, it } from 'vitest';

import { API_ERROR_CODES, createApiError } from '../src/errors';

describe('document-not-saved error contract', () => {
  it('registers DOCUMENT_NOT_SAVED as a canonical retryable API error code', () => {
    expect(API_ERROR_CODES).toContain('DOCUMENT_NOT_SAVED');
    const error = createApiError('DOCUMENT_NOT_SAVED', 'missing index.html', { retryable: true });
    expect(error).toEqual({ code: 'DOCUMENT_NOT_SAVED', message: 'missing index.html', retryable: true });
  });
});
