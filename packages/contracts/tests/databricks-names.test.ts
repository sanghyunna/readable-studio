import { describe, expect, it } from 'vitest';
import { parseDatabricksNames } from '../src/api/databricks-named.js';

describe('named batch parsing', () => {
  it('preserves exact identities when separators and duplicate names occur', () => {
    // Given
    const text = ' A,\r\nB, A,,system.ai.model-v1.2\n a ';
    // When
    const names = parseDatabricksNames(text);
    // Then
    expect(names).toEqual(['A', 'B', 'system.ai.model-v1.2', 'a']);
  });
  it.each(['', ',\r\n', 'a b', 'a/b', 'a\\b', 'https://host', 'a?b', 'a#b', 'a%b', 'a..b', '.a', 'a.', 'a\u0000b', 'x'.repeat(257), Array.from({length:21}, (_, i) => `m${i}`).join(',')])('rejects an invalid batch: %j', text => {
    // Given / When / Then
    expect(() => parseDatabricksNames(text)).toThrow();
  });
  it('accepts the batch and individual length boundaries', () => {
    // Given
    const text = ['x'.repeat(256), ...Array.from({length:19}, (_, i) => `m${i}`)].join(',');
    // When / Then
    expect(parseDatabricksNames(text)).toHaveLength(20);
  });
});
