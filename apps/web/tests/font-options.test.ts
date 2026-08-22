import { describe, expect, it } from 'vitest';
import type { SystemFontFamily } from '@readable-studio/contracts';

import { quoteFontFamily, systemFontOptions } from '../src/components/font-options';

// A trimmed stand-in for FONT_OPTS (label + font-family value pairs).
const CURATED = [
  { label: 'inherit', value: '' },
  { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times', value: '"Times New Roman", Times, serif' },
];

function family(name: string): SystemFontFamily {
  return { family: name, faces: [] };
}

describe('quoteFontFamily', () => {
  it('always quotes so the value is valid CSS for any name', () => {
    expect(quoteFontFamily('Consolas')).toBe('"Consolas"');
    expect(quoteFontFamily('Segoe UI')).toBe('"Segoe UI"');
    expect(quoteFontFamily('Yu Gothic UI')).toBe('"Yu Gothic UI"');
  });

  it('quotes names that are not valid unquoted identifiers (digit-leading, keyword-like)', () => {
    // Unquoted `3D Grotesk` / `700` would be invalid CSS and silently dropped.
    expect(quoteFontFamily('3D Grotesk')).toBe('"3D Grotesk"');
    expect(quoteFontFamily('700')).toBe('"700"');
  });

  it('escapes internal quotes/backslashes so the string closes cleanly', () => {
    expect(quoteFontFamily('a"b')).toBe('"a\\"b"');
  });
});

describe('systemFontOptions', () => {
  it('maps families to quoted value + display label', () => {
    const options = systemFontOptions([family('Segoe UI'), family('Consolas')], CURATED);
    expect(options).toEqual([
      { value: '"Segoe UI"', label: 'Segoe UI' },
      { value: '"Consolas"', label: 'Consolas' },
    ]);
  });

  it('drops families that duplicate a curated label or primary family (case-insensitive)', () => {
    const options = systemFontOptions(
      [family('Arial'), family('georgia'), family('Times New Roman'), family('Calibri')],
      CURATED,
    );
    // Arial + Georgia match curated labels; "Times New Roman" matches the
    // curated Times option's primary family; only Calibri survives.
    expect(options).toEqual([{ value: '"Calibri"', label: 'Calibri' }]);
  });
});
