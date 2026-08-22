import { describe, expect, it } from 'vitest';

import {
  buildFontFamilies,
  fontFormatFromPath,
  indexFamiliesByName,
  parseFaceName,
  parseRegistryEntries,
  type RawFontEntry,
} from '../src/system-fonts.js';

describe('parseFaceName', () => {
  it('leaves a plain family as regular 400 normal', () => {
    expect(parseFaceName('Arial')).toEqual({ family: 'Arial', weight: 400, style: 'normal' });
  });

  it('collapses the Regular/Bold/Italic/Bold-Italic quartet into one family', () => {
    expect(parseFaceName('Arial Bold')).toEqual({ family: 'Arial', weight: 700, style: 'normal' });
    expect(parseFaceName('Arial Italic')).toEqual({ family: 'Arial', weight: 400, style: 'italic' });
    expect(parseFaceName('Arial Bold Italic')).toEqual({ family: 'Arial', weight: 700, style: 'italic' });
    expect(parseFaceName('Arial Italic Bold')).toEqual({ family: 'Arial', weight: 700, style: 'italic' });
    expect(parseFaceName('Cambria Regular')).toEqual({ family: 'Cambria', weight: 400, style: 'normal' });
    expect(parseFaceName('Consolas Bold Oblique')).toEqual({ family: 'Consolas', weight: 700, style: 'italic' });
  });

  it('keeps specialty weights as their own family (conservative grouping)', () => {
    expect(parseFaceName('Segoe UI Semibold')).toEqual({ family: 'Segoe UI Semibold', weight: 400, style: 'normal' });
    expect(parseFaceName('Segoe UI Light')).toEqual({ family: 'Segoe UI Light', weight: 400, style: 'normal' });
    expect(parseFaceName('Arial Black')).toEqual({ family: 'Arial Black', weight: 400, style: 'normal' });
    expect(parseFaceName('Cambria Math')).toEqual({ family: 'Cambria Math', weight: 400, style: 'normal' });
  });

  it('never strips a name down to nothing', () => {
    expect(parseFaceName('Bold')).toEqual({ family: 'Bold', weight: 400, style: 'normal' });
    expect(parseFaceName('Italic')).toEqual({ family: 'Italic', weight: 400, style: 'normal' });
  });
});

describe('fontFormatFromPath', () => {
  it('maps known font extensions and rejects the rest', () => {
    expect(fontFormatFromPath('C:/x/arial.ttf')).toBe('truetype');
    expect(fontFormatFromPath('a.OTF')).toBe('opentype');
    expect(fontFormatFromPath('a.ttc')).toBe('collection');
    expect(fontFormatFromPath('a.woff')).toBe('woff');
    expect(fontFormatFromPath('a.woff2')).toBe('woff2');
    expect(fontFormatFromPath('sserife.fon')).toBeNull();
    expect(fontFormatFromPath('noext')).toBeNull();
  });
});

describe('parseRegistryEntries', () => {
  const dir = 'C:\\Windows\\Fonts';

  it('strips the (TrueType) suffix and resolves bare filenames against the fonts dir', () => {
    const out = parseRegistryEntries({ 'Arial (TrueType)': 'arial.ttf' }, dir);
    expect(out).toEqual([{ name: 'Arial', path: 'C:\\Windows\\Fonts\\arial.ttf' }]);
  });

  it('splits a TrueType Collection into one entry per named face sharing the file', () => {
    const out = parseRegistryEntries(
      { 'Batang & BatangChe & Gungsuh & GungsuhChe (TrueType)': 'batang.ttc' },
      dir,
    );
    expect(out.map((e) => e.name)).toEqual(['Batang', 'BatangChe', 'Gungsuh', 'GungsuhChe']);
    expect(new Set(out.map((e) => e.path))).toEqual(new Set(['C:\\Windows\\Fonts\\batang.ttc']));
  });

  it('preserves absolute per-user paths and drops non-embeddable formats', () => {
    const out = parseRegistryEntries(
      {
        'Pretendard (TrueType)': 'C:\\Users\\me\\AppData\\Local\\Microsoft\\Windows\\Fonts\\Pretendard.otf',
        'MS Sans Serif (VGA res)': 'sserife.fon',
      },
      dir,
    );
    expect(out).toEqual([
      { name: 'Pretendard', path: 'C:\\Users\\me\\AppData\\Local\\Microsoft\\Windows\\Fonts\\Pretendard.otf' },
    ]);
  });
});

describe('buildFontFamilies', () => {
  it('groups a family, dedupes faces by weight/style, and sorts', () => {
    const entries: RawFontEntry[] = [
      { name: 'Arial Bold', path: 'C:/f/arialbd.ttf' },
      { name: 'Arial', path: 'C:/f/arial.ttf' },
      { name: 'Arial Italic', path: 'C:/f/ariali.ttf' },
      { name: 'Arial Bold Italic', path: 'C:/f/arialbi.ttf' },
      { name: 'Arial', path: 'C:/f/arial-dupe.ttf' }, // duplicate 400/normal — first wins
      { name: 'Arial Black', path: 'C:/f/ariblk.ttf' },
    ];
    const families = buildFontFamilies(entries);
    const arial = families.find((f) => f.family === 'Arial')!;
    expect(arial.faces).toHaveLength(4);
    expect(arial.faces[0]).toMatchObject({ weight: 400, style: 'normal', path: 'C:/f/arial.ttf' });
    // Arial Black stays its own family.
    expect(families.some((f) => f.family === 'Arial Black')).toBe(true);
    // Sorted alphabetically: Arial before Arial Black.
    expect(families.map((f) => f.family)).toEqual(['Arial', 'Arial Black']);
  });

  it('indexes families case-insensitively for embed lookup', () => {
    const families = buildFontFamilies([{ name: 'Segoe UI', path: 'C:/f/segoeui.ttf' }]);
    const index = indexFamiliesByName(families);
    expect(index.get('segoe ui')?.family).toBe('Segoe UI');
  });
});
