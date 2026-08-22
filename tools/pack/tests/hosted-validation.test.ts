import { describe, expect, it } from 'vitest';

import { resolveHostedValidationCommands } from '../src/hosted-validation.js';

describe('hosted validation manifest', () => {
  it('expands prior boundaries once and rejects cycles', () => {
    expect(resolveHostedValidationCommands({
      pr01: ['first', 'shared'],
      pr02: ['@pr01', 'second', 'shared'],
    }, 'pr02')).toEqual(['first', 'second', 'shared']);

    expect(() => resolveHostedValidationCommands({
      pr01: ['@pr02'],
      pr02: ['@pr01'],
    }, 'pr01')).toThrow(/cycle/u);
  });
});
