// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { STYLESHEET_IMPORT, buildComponents } from '../esbuild.config';

const outdir = mkdtempSync(join(tmpdir(), 'readable-components-dist-'));

beforeAll(async () => {
  await buildComponents(outdir);
});

afterAll(() => {
  rmSync(outdir, { force: true, recursive: true });
});

describe('components bundle', () => {
  it('ships its CSS Modules stylesheet from the ESM entry so production consumers load it', () => {
    // Given
    const entry = readFileSync(join(outdir, 'index.mjs'), 'utf8');
    const stylesheet = readFileSync(join(outdir, 'index.css'), 'utf8');

    // Then
    expect(entry.startsWith(STYLESHEET_IMPORT)).toBe(true);
    expect(entry).toContain('track: "selection_primitives_track"');
    expect(stylesheet).toContain('.selection_primitives_track');
    expect(stylesheet).toContain('.selection_primitives_switch[data-state=on] .selection_primitives_thumb');
  });
});
