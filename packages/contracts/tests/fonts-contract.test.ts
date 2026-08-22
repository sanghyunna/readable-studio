import { describe, expect, it } from 'vitest';

import {
  FONTS_CONTRACT_VERSION,
  type SystemFontsResponse,
} from '../src/api/fonts.js';

describe('fonts contract', () => {
  it('exposes a runtime version marker', () => {
    expect(FONTS_CONTRACT_VERSION).toBe(1);
  });

  it('round-trips a SystemFontsResponse through JSON', () => {
    const value: SystemFontsResponse = {
      platform: 'win32',
      fonts: [
        {
          family: 'Segoe UI',
          faces: [
            { path: 'C:\\Windows\\Fonts\\segoeui.ttf', weight: 400, style: 'normal', format: 'truetype' },
            { path: 'C:\\Windows\\Fonts\\segoeuib.ttf', weight: 700, style: 'normal', format: 'truetype' },
          ],
        },
      ],
    };
    const parsed = JSON.parse(JSON.stringify(value)) as SystemFontsResponse;
    expect(parsed).toEqual(value);
    expect(parsed.fonts[0]?.faces[1]?.weight).toBe(700);
  });
});
