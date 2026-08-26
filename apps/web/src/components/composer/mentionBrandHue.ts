export const BRAND_SEED_BY_PLUGIN_ID: Readonly<Record<string, string>> = {
  // Notion publishes #000000; #0b0b0b is an app-curated near-black.
  notion: '#0b0b0b',
  slack: '#4a154b',
  github: '#181717',
  linear: '#5e6ad2',
  dropbox: '#0061ff',
  jira: '#0052cc',
  confluence: '#1868db',
  trello: '#0c66e4',
  miro: '#ffd02f',
  zapier: '#ff4a00',
  discord: '#5865f2',
  asana: '#f06a6a',
  airtable: '#18bfff',
};

interface LinearRgb {
  r: number;
  g: number;
  b: number;
}

function decodeChannel(encoded: number): number {
  return encoded <= 0.04045
    ? encoded / 12.92
    : ((encoded + 0.055) / 1.055) ** 2.4;
}

function decodeHex(hex: string): LinearRgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return {
    r: decodeChannel(((value >> 16) & 0xff) / 255),
    g: decodeChannel(((value >> 8) & 0xff) / 255),
    b: decodeChannel((value & 0xff) / 255),
  };
}

function luminance({ r, g, b }: LinearRgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function encodeChannel(linear: number): string {
  const encoded =
    linear <= 0.0031308
      ? 12.92 * linear
      : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.min(255, Math.ceil(255 * encoded)).toString(16).padStart(2, '0');
}

export function deriveBrandHue(
  seedHex: string,
  scheme: 'light' | 'dark',
  panelHex: string,
): string {
  if (scheme === 'light') return seedHex === '#ffffff' ? '#fefefe' : seedHex;

  const seed = decodeHex(seedHex);
  const panel = decodeHex(panelHex);
  const seedLuminance = luminance(seed);
  const requiredLuminance = 4.5 * (luminance(panel) + 0.05) - 0.05;
  const alpha = Math.max(
    1 / 255,
    Math.min(1, Math.max(0, (requiredLuminance - seedLuminance) / (1 - seedLuminance))),
  );

  return `#${encodeChannel(seed.r + alpha * (1 - seed.r))}${encodeChannel(
    seed.g + alpha * (1 - seed.g),
  )}${encodeChannel(seed.b + alpha * (1 - seed.b))}`;
}

export function resolveScheme(root: HTMLElement): 'light' | 'dark' {
  const explicitScheme = root.getAttribute('data-theme-scheme');
  if (explicitScheme === 'light' || explicitScheme === 'dark') return explicitScheme;
  return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}
