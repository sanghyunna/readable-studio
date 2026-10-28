import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  assertUniqueZipPath,
  assertWindowsSafeZipPath,
  importClaudeDesignZip,
  normalizeZipPath,
  readCentralDirectory,
  readEntryBody,
  sanitizeZipPath,
} from '../src/claude-design-import.js';
import { buildZip as buildRawZip, centralOffsets, cp949Name } from './helpers/template-zip.js';

function buildZip(
  entries: { name: string; body: Buffer; method?: 0 | 8; falsifyCentralUncompressed?: boolean }[],
): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const method = entry.method ?? 8;
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const compressed = method === 0 ? entry.body : deflateRawSync(entry.body);
    const crcBuf = Buffer.alloc(4);
    // CRC isn't validated by the importer; zero is fine for this test fixture.
    crcBuf.writeUInt32LE(0, 0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    crcBuf.copy(local, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    localChunks.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    crcBuf.copy(central, 16);
    central.writeUInt32LE(compressed.length, 20);
    // The central directory may legitimately advertise uncompressedSize=0 even when
    // the local header has the real length (streaming zips with data descriptors).
    // Reproduce that case explicitly when requested.
    central.writeUInt32LE(
      entry.falsifyCentralUncompressed ? 0 : entry.body.length,
      24,
    );
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const localBlob = Buffer.concat(localChunks);
  const centralBlob = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBlob.length, 12);
  eocd.writeUInt32LE(localBlob.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localBlob, centralBlob, eocd]);
}

describe('importClaudeDesignZip', () => {
  it('imports zips that contain a zero-byte deflate entry without crashing on Node 24', async () => {
    // Regression: inflateRawSync rejects { maxOutputLength: 0 } on Node 24.
    const zip = buildZip([
      { name: 'index.html', body: Buffer.from('<html></html>') },
      { name: 'docs/empty.md', body: Buffer.alloc(0) },
    ]);
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'cd-import-'));
    const zipPath = path.join(tmp, 'in.zip');
    const projectDir = path.join(tmp, 'proj');
    writeFileSync(zipPath, zip);
    try {
      const result = await importClaudeDesignZip(zipPath, projectDir);
      expect(result.entryFile).toBe('index.html');
      expect(result.files.sort()).toEqual(['docs/empty.md', 'index.html']);
      const empty = readFileSync(path.join(projectDir, 'docs/empty.md'));
      expect(empty.length).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('preserves the real payload when the central directory under-reports size to 0', async () => {
    // Streaming zips (data descriptor, flag bit 3) legitimately leave central
    // uncompressedSize = 0 while the payload carries real bytes. Earlier
    // attempts to "fast-path" those entries silently truncated valid files;
    // verify the actual deflated content is decoded and written through.
    const realBody = Buffer.from(
      '# streamed entry\n\n' + 'x'.repeat(4096) + '\n',
      'utf8',
    );
    const zip = buildZip([
      { name: 'index.html', body: Buffer.from('<html></html>') },
      {
        name: 'docs/streamed.md',
        body: realBody,
        falsifyCentralUncompressed: true,
      },
    ]);
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'cd-import-'));
    const zipPath = path.join(tmp, 'in.zip');
    const projectDir = path.join(tmp, 'proj');
    writeFileSync(zipPath, zip);
    try {
      const result = await importClaudeDesignZip(zipPath, projectDir);
      expect(result.files).toContain('docs/streamed.md');
      const written = readFileSync(path.join(projectDir, 'docs/streamed.md'));
      expect(written.equals(realBody)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects entries that decode larger than MAX_FILE_BYTES even when central size is 0', async () => {
    // The central directory cannot be trusted to enforce the per-file ceiling
    // for streaming zips. Build a fixture whose decoded payload is just barely
    // beyond the limit and confirm we still fail closed.
    const oversized = Buffer.alloc(25 * 1024 * 1024 + 1, 0x61);
    const zip = buildZip([
      { name: 'index.html', body: Buffer.from('<html></html>') },
      {
        name: 'docs/oversize.bin',
        body: oversized,
        falsifyCentralUncompressed: true,
      },
    ]);
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'cd-import-'));
    const zipPath = path.join(tmp, 'in.zip');
    const projectDir = path.join(tmp, 'proj');
    writeFileSync(zipPath, zip);
    try {
      await expect(importClaudeDesignZip(zipPath, projectDir)).rejects.toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('accepts zips with more than the previous 500-file ceiling', async () => {
    // Regression: design-system exports commonly exceed 500 files.
    const entries = [{ name: 'index.html', body: Buffer.from('<html></html>') }];
    for (let i = 0; i < 600; i += 1) {
      entries.push({ name: `assets/icon-${i}.svg`, body: Buffer.from(`<svg>${i}</svg>`) });
    }
    const zip = buildZip(entries);
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'cd-import-'));
    const zipPath = path.join(tmp, 'in.zip');
    const projectDir = path.join(tmp, 'proj');
    writeFileSync(zipPath, zip);
    try {
      const result = await importClaudeDesignZip(zipPath, projectDir);
      expect(result.entryFile).toBe('index.html');
      expect(readdirSync(path.join(projectDir, 'assets')).length).toBe(600);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('normalizes Claude Design canvas wheel handling so vertical scroll does not zoom', async () => {
    const designCanvas = `
function DCViewport() {
  const tf = { current: { x: 0, y: 0, scale: 1 } };
  const apply = () => {};
  const zoomAt = () => {};
  React.useEffect(() => {
    // Mouse-wheel vs trackpad-scroll heuristic. A physical wheel sends
    // line-mode deltas (Firefox) or large integer pixel deltas with no X
    // component (Chrome/Safari, typically multiples of 100/120). Trackpad
    // two-finger scroll sends small/fractional pixel deltas, often with
    // non-zero deltaX. ctrlKey is set by the browser for trackpad pinch.
    const isMouseWheel = (e) =>
      e.deltaMode !== 0 ||
      (e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40);

    const onWheel = (e) => {
      e.preventDefault();
      if (isGesturing) return; // Safari: gesture* owns the pinch — discard concurrent wheels
      if ((e.ctrlKey || e.metaKey) && !isMouseWheel(e)) {
        // trackpad pinch, or ctrl/cmd + smooth-scroll mouse. Notched
        // wheels fall through to the fixed-step branch below.
        zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01));
      } else if (isMouseWheel(e)) {
        // notched mouse wheel — fixed-ratio step per click
        zoomAt(e.clientX, e.clientY, Math.exp(-Math.sign(e.deltaY) * 0.18));
      } else {
        // trackpad two-finger scroll — pan
        tf.current.x -= e.deltaX;
        tf.current.y -= e.deltaY;
        apply();
      }
    };

    // Safari sends native gesture* events for trackpad pinch with a smooth
    // e.scale; preferring these over the ctrl+wheel fallback gives a much
    // better feel there. No-ops on other browsers. Safari also fires
    // ctrlKey wheel events during the same pinch — isGesturing makes
    // onWheel drop those entirely so they neither zoom nor pan.
    let gsBase = 1;
    let isGesturing = false;
    const onGestureStart = (e) => { e.preventDefault(); isGesturing = true; gsBase = tf.current.scale; };
    const onGestureChange = (e) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, (gsBase * e.scale) / tf.current.scale);
    };
    const onGestureEnd = (e) => { e.preventDefault(); isGesturing = false; };
  });
}
`;
    const zip = buildZip([
      { name: 'index.html', body: Buffer.from('<html><script src="design-canvas.jsx"></script></html>') },
      { name: 'design-canvas.jsx', body: Buffer.from(designCanvas) },
    ]);
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'cd-import-'));
    const zipPath = path.join(tmp, 'in.zip');
    const projectDir = path.join(tmp, 'proj');
    writeFileSync(zipPath, zip);
    try {
      const result = await importClaudeDesignZip(zipPath, projectDir);
      expect(result.files).toContain('design-canvas.jsx');
      const written = readFileSync(path.join(projectDir, 'design-canvas.jsx'), 'utf8');
      expect(written).not.toContain('const isMouseWheel');
      expect(written).not.toContain('(gsBase * e.scale) / tf.current.scale');
      expect(written).toContain('const panByWheel = (e) =>');
      // The Cmd-zoom gate accepts ctrlKey too because Chromium/Firefox
      // synthesize wheel events with `ctrlKey: true` during a trackpad
      // pinch; without that, smooth pinch would fall through to
      // `panByWheel(e)` instead of zooming.
      expect(written).toContain('if (e.ctrlKey || e.metaKey)');
      // The rewritten Cmd-zoom path now keeps both ratios so a physical mouse
      // wheel does not shrink the canvas by ~63% per notch: the notched
      // detector matches deltaMode!==0 or large integer pixel deltas, and the
      // notched factor (Math.sign * 0.18) gives ~17% per click while trackpad
      // smooth scrolls keep the original deltaY * 0.01 ratio.
      expect(written).toContain('const isNotchedWheel = (e) =>');
      expect(written).toContain('Math.exp(-Math.sign(e.deltaY) * 0.18)');
      expect(written).toContain('Math.exp(-e.deltaY * 0.01)');
      expect(written).toContain("const limit = axis === 'y' ? 72 : 160;");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('warns and preserves source when the design-canvas wheel-handler shape drifts', async () => {
    // Same general layout as a real Claude Design canvas export, but with
    // tab indentation and a rephrased comment so neither rewrite regex
    // matches. The importer should leave the source untouched and emit a
    // console.warn that operators can grep when the zoom-on-scroll bug
    // reappears with a future canvas template.
    const driftedCanvas = `
function DCViewport() {
\tReact.useEffect(() => {
\t\t// Wheel routing: distinguish trackpad pan from notched mouse wheel zoom.
\t\tconst onWheel = (e) => {
\t\t\te.preventDefault();
\t\t};
\t});
}
`;
    const zip = buildZip([
      { name: 'index.html', body: Buffer.from('<html><script src="design-canvas.jsx"></script></html>') },
      { name: 'design-canvas.jsx', body: Buffer.from(driftedCanvas) },
    ]);
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'cd-import-drift-'));
    const zipPath = path.join(tmp, 'in.zip');
    const projectDir = path.join(tmp, 'proj');
    writeFileSync(zipPath, zip);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await importClaudeDesignZip(zipPath, projectDir);
      expect(result.files).toContain('design-canvas.jsx');
      const written = readFileSync(path.join(projectDir, 'design-canvas.jsx'), 'utf8');
      // Source must be preserved verbatim — no partial rewrite, no crash.
      expect(written).toBe(driftedCanvas);
      // And the importer must have logged so the regression is greppable.
      expect(warn).toHaveBeenCalledTimes(1);
      const firstCall = warn.mock.calls[0]?.[0];
      expect(typeof firstCall).toBe('string');
      expect(firstCall).toContain('[claude-design-import]');
      expect(firstCall).toContain('design-canvas.jsx');
    } finally {
      warn.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('warns when only the gesture-handler regex drifts', async () => {
    // Real-world drift case: Anthropic ships a fresh wheel-handler block
    // (so `wheelBlock` still matches and gets normalized) but rewords the
    // Safari `gesture*` comment so `gestureBlock` misses. Without per-regex
    // tracking the previous warn() only fired when neither block matched,
    // which let this half-rewrite ship silently with the old Safari pinch
    // handlers still active over a normalized wheel path. Verify the warn
    // still fires and identifies the gesture handler as the missing one.
    const partialDriftCanvas = `
function DCViewport() {
  React.useEffect(() => {
    // Mouse-wheel vs trackpad-scroll heuristic. Keep this on the host so
    // an embedded export still routes Cmd+wheel through host zoom.
    const onWheel = (e) => {
      e.preventDefault();
    };

    // (Reworded) Safari trackpad pinch via native gesture* events.
    let isGesturing = false;
    const onGestureStart = (e) => { e.preventDefault(); isGesturing = true; };
    const onGestureChange = (e) => { e.preventDefault(); };
    const onGestureEnd = (e) => { e.preventDefault(); isGesturing = false; };
  });
}
`;
    const zip = buildZip([
      { name: 'index.html', body: Buffer.from('<html><script src="design-canvas.jsx"></script></html>') },
      { name: 'design-canvas.jsx', body: Buffer.from(partialDriftCanvas) },
    ]);
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'cd-import-gesture-drift-'));
    const zipPath = path.join(tmp, 'in.zip');
    const projectDir = path.join(tmp, 'proj');
    writeFileSync(zipPath, zip);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await importClaudeDesignZip(zipPath, projectDir);
      expect(result.files).toContain('design-canvas.jsx');
      const written = readFileSync(path.join(projectDir, 'design-canvas.jsx'), 'utf8');
      // Wheel block still matched, so the new pan/zoom handler is in place.
      expect(written).toContain('const panByWheel = (e) =>');
      expect(written).toContain('if (e.ctrlKey || e.metaKey)');
      // Gesture block missed, so the original (reworded) gesture handlers
      // are still present verbatim.
      expect(written).toContain('(Reworded) Safari trackpad pinch');
      // And the importer logged a warning naming the gesture handler as
      // the missing one, so future regex tweaks have to confront the drift.
      expect(warn).toHaveBeenCalled();
      const warnedLines = warn.mock.calls
        .map((args) => args[0])
        .filter((s): s is string => typeof s === 'string');
      const gestureWarn = warnedLines.find((line) =>
        line.includes('[claude-design-import]') && line.includes('gesture-handler'),
      );
      expect(gestureWarn).toBeDefined();
    } finally {
      warn.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

const page = (name: string | Buffer, extra: Partial<Parameters<typeof buildRawZip>[0][number]> = {}) =>
  ({ name, body: '<html></html>', ...extra });

async function importToTemp(zip: Buffer, check: (projectDir: string) => void = () => {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'cd-import-hardening-'));
  const zipPath = path.join(tmp, 'in.zip');
  const projectDir = path.join(tmp, 'proj');
  writeFileSync(zipPath, zip);
  try {
    const result = await importClaudeDesignZip(zipPath, projectDir);
    check(projectDir);
    return result;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('zip parser hardening', () => {
  describe('entry name decoding', () => {
    it('decodes a CP949 name when flag 0x800 is cleared', () => {
      const [entry] = readCentralDirectory(buildRawZip([page(cp949Name('한글/가나.html'))]));
      expect(entry!.name).toBe('한글/가나.html');
    });

    it('decodes UTF-8 names with and without flag 0x800', () => {
      const entries = readCentralDirectory(buildRawZip([
        page('보고서.html', { utf8Flag: true }),
        page('표지.html'),
      ]));
      expect(entries.map((e) => e.name)).toEqual(['보고서.html', '표지.html']);
    });

    it('rejects a flag-0x800 name that is not valid UTF-8 without echoing the bytes', () => {
      const zip = buildRawZip([page('index.html'), page(cp949Name('가나.html'), { utf8Flag: true })]);
      expect(() => readCentralDirectory(zip)).toThrow(/^zip entry #2 has an undecodable file name$/);
    });

    it('prefers the Info-ZIP Unicode Path extra field when its name CRC matches', () => {
      const [entry] = readCentralDirectory(buildRawZip([
        page(Buffer.from('legacy.html'), { unicodePathExtra: '발표/표지.html' }),
      ]));
      expect(entry!.name).toBe('발표/표지.html');
    });

    it('lets flag 0x800 win over a matching Unicode Path extra field', () => {
      const [entry] = readCentralDirectory(buildRawZip([
        page('보고서.html', { utf8Flag: true, unicodePathExtra: '다른.html' }),
      ]));
      expect(entry!.name).toBe('보고서.html');
    });

    it('ignores a Unicode Path extra field whose CRC no longer matches the raw name', () => {
      const zip = buildRawZip([page(Buffer.from('legacy.html'), { unicodePathExtra: '표지.html' })]);
      // Corrupt the stored name CRC in the central directory copy of the field.
      const central = centralOffsets(zip)[0]!;
      const extraStart = central + 46 + zip.readUInt16LE(central + 28);
      zip.writeUInt32LE((zip.readUInt32LE(extraStart + 5) ^ 1) >>> 0, extraStart + 5);
      expect(readCentralDirectory(zip)[0]!.name).toBe('legacy.html');
    });

    it('ignores a Unicode Path extra field with an unknown version, even when its CRC matches', () => {
      const zip = buildRawZip([page(Buffer.from('legacy.html'), { unicodePathExtra: '표지.html' })]);
      const central = centralOffsets(zip)[0]!;
      const extraStart = central + 46 + zip.readUInt16LE(central + 28);
      expect(zip.readUInt16LE(extraStart)).toBe(0x7075);
      zip.writeUInt8(2, extraStart + 4);
      expect(readCentralDirectory(zip)[0]!.name).toBe('legacy.html');
    });

    it('rejects names that still decode to U+FFFD', () => {
      expect(() => readCentralDirectory(buildRawZip([page('bad�.html')]))).toThrow(/zip entry #1 has an undecodable file name/);
      // 0xFF is neither UTF-8 nor CP949.
      expect(() => readCentralDirectory(buildRawZip([page(Buffer.from([0x61, 0xff, 0x2e, 0x68]))])))
        .toThrow(/zip entry #1 has an undecodable file name/);
    });
  });

  describe('ZIP64', () => {
    const zip64 = /ZIP64 archives are not supported/;

    it.each([
      ['entry count', 8, 'u16'],
      ['total entry count', 10, 'u16'],
      ['central size', 12, 'u32'],
      ['central offset', 16, 'u32'],
    ] as const)('rejects an EOCD whose %s is saturated', (_label, field, width) => {
      const zip = buildRawZip([page('index.html')]);
      const eocd = zip.length - 22;
      if (width === 'u16') zip.writeUInt16LE(0xffff, eocd + field);
      else zip.writeUInt32LE(0xffffffff, eocd + field);
      expect(() => readCentralDirectory(zip)).toThrow(zip64);
    });

    it('rejects a ZIP64 end-of-central-directory locator', () => {
      const plain = buildRawZip([page('index.html')]);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      const zip = Buffer.concat([plain.subarray(0, plain.length - 22), locator, plain.subarray(plain.length - 22)]);
      expect(() => readCentralDirectory(zip)).toThrow(zip64);
    });

    it.each([['compressed size', 20], ['uncompressed size', 24], ['local offset', 42]] as const)(
      'rejects a central entry whose %s is saturated',
      (_label, field) => {
        const zip = buildRawZip([page('index.html')]);
        zip.writeUInt32LE(0xffffffff, centralOffsets(zip)[0]! + field);
        expect(() => readCentralDirectory(zip)).toThrow(zip64);
      },
    );

    it('rejects a central entry carrying a ZIP64 extra field', () => {
      const extra = Buffer.alloc(4 + 8);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(8, 2);
      expect(() => readCentralDirectory(buildRawZip([page('index.html', { extra })]))).toThrow(zip64);
    });
  });

  describe('Windows path checks', () => {
    it.each([
      // `x:y.html` is caught earlier as a drive-qualified path.
      ['x:y.html', 'absolute zip paths are not allowed'],
      ['page.html:stream', "':' is not allowed"],
      ['dir/a:b/c.html', "':' is not allowed"],
      ['con.html', 'reserved Windows name'],
      ['CON', 'reserved Windows name'],
      ['assets/Lpt1.txt.css', 'reserved Windows name'],
      ['nul/x.html', 'reserved Windows name'],
      ['com9.js', 'reserved Windows name'],
      ['con .html', 'reserved Windows name'],
      ['pages/nul  .txt', 'reserved Windows name'],
      ['assets/com¹.css', 'reserved Windows name'],
      ['CONOUT$.txt', 'reserved Windows name'],
      ['CONIN$', 'reserved Windows name'],
      ['lpt³', 'reserved Windows name'],
      ['a./b.html', 'trailing dot or space'],
      ['a /b.html', 'trailing dot or space'],
      ['page.html.', 'trailing dot or space'],
      ['a?.html', 'invalid character'],
      ['a*.html', 'invalid character'],
      ['a<b>.html', 'invalid character'],
      ['a"b.html', 'invalid character'],
      ['a|b.html', 'invalid character'],
      ['tab\there.html', 'invalid character'],
      [`${'s'.repeat(121)}.html`, 'path segment longer than 120 characters'],
      [`${'d'.repeat(100)}/${'e'.repeat(95)}.html`, 'path longer than 200 characters'],
    ])('rejects %j (%s)', (name, reason) => {
      expect(() => sanitizeZipPath(name)).toThrow(reason);
    });

    it.each([
      'console.html', 'contents.html', 'com10.html', 'lpt.css', 'com⁴.css', 'auxiliary/nulls.html', 'a.b/c.html', '한글/표지.html',
      `${'s'.repeat(115)}.html`, `${'d'.repeat(100)}/${'e'.repeat(94)}.html`,
    ])('keeps %j', (name) => {
      expect(sanitizeZipPath(name)).toBe(name);
    });

    it('still normalises backslashes and rejects traversal', () => {
      expect(sanitizeZipPath('assets\\deck.css')).toBe('assets/deck.css');
      expect(() => sanitizeZipPath('../evil.html')).toThrow();
    });

    it('Claude Design import rejects Windows-unsafe names, naming the file', async () => {
      await expect(importToTemp(buildRawZip([page('index.html'), page('aux.html')])))
        .rejects.toThrow('unsafe zip path: aux.html (reserved Windows name)');
    });

    it('splits into a traversal part and a Windows part that sanitizeZipPath composes', () => {
      const long = `__MACOSX/${'d'.repeat(100)}/._${'e'.repeat(90)}.html`;
      expect(normalizeZipPath(long)).toBe(long);
      expect(() => normalizeZipPath('../evil.html')).toThrow();
      expect(() => assertWindowsSafeZipPath(long)).toThrow('path longer than 200 characters');
      expect(() => sanitizeZipPath(long)).toThrow('path longer than 200 characters');
    });
  });

  describe('duplicates', () => {
    it('rejects exact and case-colliding paths, naming both', () => {
      const seen = new Map<string, string>();
      assertUniqueZipPath(seen, 'Pages/A.html');
      assertUniqueZipPath(seen, 'pages/b.html');
      expect(() => assertUniqueZipPath(seen, 'pages/a.html'))
        .toThrow('zip contains duplicate or case-colliding entries: Pages/A.html and pages/a.html');
      expect(() => assertUniqueZipPath(seen, 'pages/b.html')).toThrow(/duplicate or case-colliding/);
    });

    it('Claude Design import rejects case-colliding entries', async () => {
      await expect(importToTemp(buildRawZip([page('index.html'), page('A.html'), page('a.html')])))
        .rejects.toThrow(/duplicate or case-colliding/);
    });
  });

  it('Claude Design import writes CP949-named files under their Hangul names', async () => {
    const zip = buildRawZip([page('index.html'), { name: cp949Name('자료/한글.css'), body: 'h1{}' }]);
    const result = await importToTemp(zip, (projectDir) => {
      expect(readFileSync(path.join(projectDir, '자료', '한글.css'), 'utf8')).toBe('h1{}');
    });
    expect(result.files).toContain('자료/한글.css');
  });

  describe('readEntryBody cap', () => {
    it('uses maxBytes as the inflate ceiling when the central size is 0', () => {
      const zip = buildRawZip([{ name: 'big.bin', body: Buffer.alloc(4096, 0x61) }]);
      const [entry] = readCentralDirectory(zip);
      const streamed = { ...entry!, uncompressedSize: 0 };
      expect(readEntryBody(zip, streamed).length).toBe(4096);
      expect(() => readEntryBody(zip, streamed, 1024)).toThrow(/larger than 1024 bytes/);
    });

    it('reads stored entries', () => {
      const zip = buildRawZip([{ name: 'a.txt', body: 'stored body', method: 0 }]);
      expect(readEntryBody(zip, readCentralDirectory(zip)[0]!).toString('utf8')).toBe('stored body');
    });
  });
});
