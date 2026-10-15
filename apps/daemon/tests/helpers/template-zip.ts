import { deflateRawSync } from 'node:zlib';

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

export function validTemplateEntries(prompt = PROMPT_WITH_FRONT_MATTER) {
  return [
    { name: 'PROMPT.md', body: prompt },
    { name: 'two-column.html', body: '<!doctype html><link rel="stylesheet" href="assets/deck.css"><h1>Two</h1>' },
    { name: 'cover.html', body: '<!doctype html><link rel="stylesheet" href="assets/deck.css"><h1>Cover</h1>' },
    { name: 'assets/deck.css', body: 'h1{color:#123456}' },
    { name: 'assets/img/logo.svg', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
  ];
}
