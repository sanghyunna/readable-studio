import { crc32, deflateRawSync } from 'node:zlib';

// Minimal in-memory ZIP writer for design-template import tests (CRC is not
// validated by the daemon parser, so it is left at zero).
export function buildTemplateZip(entries: { name: string; body: string | Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const body = typeof entry.body === 'string' ? Buffer.from(entry.body, 'utf8') : entry.body;
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const localBlob = Buffer.concat(locals);
  const centralBlob = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBlob.length, 12);
  eocd.writeUInt32LE(localBlob.length, 16);
  return Buffer.concat([localBlob, centralBlob, eocd]);
}

export interface ZipEntryInput {
  name: string | Buffer;
  body: string | Buffer;
  method?: 0 | 8;
  /** Sets general-purpose flag bit 11 (UTF-8 names). */
  utf8Flag?: boolean;
  /** Adds an Info-ZIP Unicode Path extra field (0x7075) with this UTF-8 name. */
  unicodePathExtra?: string;
  /** Raw extra-field bytes appended to both headers (e.g. a ZIP64 0x0001 field). */
  extra?: Buffer;
}

// Configurable ZIP writer: raw (e.g. CP949) names, stored or deflated
// bodies, flag 0x800, Unicode Path extra field and a real CRC32.
export function buildZip(entries: ZipEntryInput[], options: { crc?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const body = typeof entry.body === 'string' ? Buffer.from(entry.body, 'utf8') : entry.body;
    const name = typeof entry.name === 'string' ? Buffer.from(entry.name, 'utf8') : entry.name;
    const method = entry.method ?? 8;
    const data = method === 0 ? body : deflateRawSync(body);
    const crc = options.crc === false ? 0 : crc32(body);
    const flags = entry.utf8Flag ? 0x800 : 0;
    const extras: Buffer[] = [];
    if (entry.unicodePathExtra !== undefined) {
      const unicode = Buffer.from(entry.unicodePathExtra, 'utf8');
      const header = Buffer.alloc(9);
      header.writeUInt16LE(0x7075, 0);
      header.writeUInt16LE(5 + unicode.length, 2);
      header.writeUInt8(1, 4);
      header.writeUInt32LE(crc32(name), 5);
      extras.push(header, unicode);
    }
    if (entry.extra) extras.push(entry.extra);
    const extra = Buffer.concat(extras);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    locals.push(local, name, extra, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name, extra);
    offset += local.length + name.length + extra.length + data.length;
  }
  const localBlob = Buffer.concat(locals);
  const centralBlob = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBlob.length, 12);
  eocd.writeUInt32LE(localBlob.length, 16);
  return Buffer.concat([localBlob, centralBlob, eocd]);
}

// Offsets of each central-directory record in an archive written by these
// builders (no archive comment, so the EOCD is the last 22 bytes); tests
// patch header fields through them.
export function centralOffsets(zip: Buffer): number[] {
  const eocd = zip.length - 22;
  const offsets: number[] = [];
  let offset = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < zip.readUInt16LE(eocd + 10); i += 1) {
    offsets.push(offset);
    offset += 46 + zip.readUInt16LE(offset + 28) + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  return offsets;
}

let cp949Table: Map<string, [number, number]> | undefined;

// CP949 bytes for ASCII + KS X 1001 Hangul (no euc-kr encoder exists, so the
// table is derived once by decoding the 0xB0A1-0xC8FE syllable block).
export function cp949Name(name: string): Buffer {
  if (!cp949Table) {
    cp949Table = new Map();
    const decoder = new TextDecoder('euc-kr');
    for (let lead = 0xb0; lead <= 0xc8; lead += 1) {
      for (let trail = 0xa1; trail <= 0xfe; trail += 1) {
        cp949Table.set(decoder.decode(Uint8Array.of(lead, trail)), [lead, trail]);
      }
    }
  }
  const bytes: number[] = [];
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (code < 0x80) {
      bytes.push(code);
      continue;
    }
    const pair = cp949Table.get(ch);
    if (!pair) throw new Error(`cp949Name: unsupported character ${ch}`);
    bytes.push(...pair);
  }
  return Buffer.from(bytes);
}

// A bundle ZIP: each template becomes an inner ZIP named `name` (verbatim,
// e.g. 'deck.zip'), optionally under one wrapper folder; `extra` entries are
// added to the outer archive as-is.
export function buildBundleZip(
  templates: { name: string; entries: ZipEntryInput[] }[],
  options: { method?: 0 | 8; wrapper?: string; extra?: ZipEntryInput[] } = {},
): Buffer {
  const prefix = options.wrapper ? `${options.wrapper}/` : '';
  return buildZip([
    ...templates.map((t) => ({ name: `${prefix}${t.name}`, body: buildZip(t.entries), method: options.method ?? 8 })),
    ...(options.extra ?? []),
  ]);
}

export const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export const PROMPT_WITH_FRONT_MATTER = [
  '---',
  'name: Quarterly Review',
  'description: Clean quarterly business review deck',
  'cover: cover.html',
  'pages:',
  '  - file: cover.html',
  '    use: Title slide',
  '  - file: two-column.html',
  '    use: Comparison with two columns',
  '---',
  'Use the cover once. PROMPT_BODY_MARKER_481: keep titles under 40 characters.',
  '',
].join('\n');

// Root PROMPT.md + kit/*.html (no single wrapper folder to strip): every HTML,
// including nested ones and .htm, must survive as a page with its kit/ path.
export const KIT_PROMPT = [
  '---',
  'name: Kit Pack',
  'description: Kit pages for an annual report',
  'cover: kit/cover.html',
  'pages:',
  '  - file: kit/report.htm',
  '    use: Body section',
  '---',
  'KIT_PROMPT_MARKER_902: keep the cover sober.',
  '',
].join('\n');

export function kitTemplateEntries(prompt = KIT_PROMPT) {
  return [
    { name: 'PROMPT.md', body: prompt },
    { name: 'kit/cover.html', body: '<!doctype html><link rel="stylesheet" href="assets/shared.css"><h1>Kit cover</h1>' },
    { name: 'kit/report.htm', body: '<!doctype html><link rel="stylesheet" href="assets/shared.css"><h1>Kit report</h1>' },
    { name: 'kit/nested/detail.html', body: '<!doctype html><link rel="stylesheet" href="../assets/shared.css"><h1>Kit detail</h1>' },
    { name: 'kit/assets/shared.css', body: 'h1{color:#0a0a0a}' },
  ];
}

export function validTemplateEntries(prompt = PROMPT_WITH_FRONT_MATTER) {
  return [
    { name: 'PROMPT.md', body: prompt },
    { name: 'two-column.html', body: '<!doctype html><link rel="stylesheet" href="assets/deck.css"><h1>Two</h1>' },
    { name: 'cover.html', body: '<!doctype html><link rel="stylesheet" href="assets/deck.css"><h1>Cover</h1>' },
    { name: 'assets/deck.css', body: 'h1{color:#123456}' },
    { name: 'assets/img/logo.svg', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
  ];
}
