import { describe, expect, it } from 'vitest';
import { validateManifest } from '../src/validate';

describe('validateManifest', () => {
  it('flags repeat=true without an until expression', () => {
    const result = validateManifest({
      name: 'x',
      version: '1.0.0',
      readable: {
        pipeline: { stages: [{ id: 'critique', atoms: ['critique-theater'], repeat: true }] },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/until/);
  });

  it('warns on unknown capability strings but stays ok', () => {
    const result = validateManifest({
      name: 'x',
      version: '1.0.0',
      readable: { capabilities: ['prompt:inject', 'made-up'] },
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes('made-up'))).toBe(true);
  });

});
