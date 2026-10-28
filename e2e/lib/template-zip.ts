import { crc32 } from 'node:zlib';

/** Stored (method 0) ZIP builder with real CRC32. Independent of daemon-private ZIP code. */
export type ZipFile = { name: string | Buffer; body: string | Buffer; utf8Flag?: boolean };

export function buildZip(files: ZipFile[]): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = typeof file.name === 'string' ? Buffer.from(file.name) : file.name;
    const body = Buffer.from(file.body);
    const crc = crc32(body);
    const flags = (file.utf8Flag ?? typeof file.name === 'string') ? 0x800 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, central, end]);
}

/** Bundle = outer ZIP whose entries are inner template ZIPs (or any extra loose file). */
export function buildBundle(items: Array<{ name: string | Buffer; zip: Buffer }>, extra: ZipFile[] = []): Buffer {
  return buildZip([...items.map(({ name, zip }) => ({ name, body: zip })), ...extra]);
}

let cp949Table: Map<string, [number, number]> | undefined;

/** Raw CP949 bytes for ASCII + KS X 1001 Hangul, derived from the WHATWG euc-kr decoder. */
export function cp949Name(name: string): Buffer {
  if (!cp949Table) {
    cp949Table = new Map();
    const decoder = new TextDecoder('euc-kr');
    for (let lead = 0xb0; lead <= 0xc8; lead++) {
      for (let trail = 0xa1; trail <= 0xfe; trail++) cp949Table.set(decoder.decode(Uint8Array.of(lead, trail)), [lead, trail]);
    }
  }
  const bytes: number[] = [];
  for (const ch of name) {
    const pair = ch.charCodeAt(0) < 0x80 ? undefined : cp949Table.get(ch);
    if (ch.charCodeAt(0) >= 0x80 && !pair) throw new Error(`cp949Name: unsupported character ${ch}`);
    bytes.push(...(pair ?? [ch.charCodeAt(0)]));
  }
  return Buffer.from(bytes);
}
