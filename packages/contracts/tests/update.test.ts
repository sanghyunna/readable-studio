import { describe, expect, it } from 'vitest';
import { compareUpdateVersions } from '../src/api/update.js';

describe('update semver precedence', () => {
  it.each([
    ['1.10.0', '1.9.9', 1], ['1.2.1', '1.2.1', 0], ['1.2.0', '1.2.1', -1],
    ['1.2.1', '1.2.1-rc.1', 1], ['1.2.1-beta.10', '1.2.1-beta.2', 1],
    ['1.2.1-1', '1.2.1-alpha', -1], ['1.2.1+build.1', '1.2.1+build.2', 0],
    ['1.2.1-alpha', '1.2.1-alpha.1', -1], ['v1.2.1', '1.2.0', 1],
  ])('%s vs %s', (a, b, result) => expect(compareUpdateVersions(a, b)).toBe(result));
  it.each(['01.2.3', '1.2', '1.2.3-01', 'garbage', '1.2.3-'])('rejects %s', (value) => {
    expect(compareUpdateVersions(value, '1.2.3')).toBeNull();
  });
});
