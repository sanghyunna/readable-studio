import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { extractUpdatePayload } from '../src/update-apply-routes.js';

it('Q11-01 reports bytes within a large entry before its file count advances', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extract-bytes-'));
  const zip = join(root, 'update.zip');
  const stage = join(root, 'stage');
  try {
    await mkdir(stage);
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem
$a = [IO.Compression.ZipFile]::Open($env:TEST_ZIP, [IO.Compression.ZipArchiveMode]::Create)
try {
  $e = $a.CreateEntry('app/Readable Studio.exe', [IO.Compression.CompressionLevel]::NoCompression)
  $s = $e.Open(); $b = New-Object byte[] 1048576
  try { foreach ($i in 1..32) { $s.Write($b, 0, $b.Length) } } finally { $s.Dispose() }
  foreach ($name in @('app/resources/readable-studio-config.json','app/resources/update-helper/common.ps1','app/resources/update-helper/update-helper.ps1','app/resources/update-helper/update-broker.ps1')) {
    $s = $a.CreateEntry($name).Open(); $s.Dispose()
  }
} finally { $a.Dispose() }
`;
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, env: { ...process.env, TEST_ZIP: zip } });
    const samples: { completed: number; bytes: number | undefined; totalBytes: number | undefined }[] = [];
    await extractUpdatePayload(zip, stage, (...args: [number, number, number?, number?]) => {
      samples.push({ completed: args[0], bytes: args[2], totalBytes: args[3] });
    });
    expect(samples.some(s => s.completed === 0 && s.bytes! > 0 && s.bytes! < s.totalBytes!)).toBe(true);
    expect(samples.at(-1)).toMatchObject({ completed: 5, bytes: 32 * 1048576, totalBytes: 32 * 1048576 });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60000);

it('R8-01 preserves ZIP last-write times like ExtractToFile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extract-times-'));
  const zip = join(root, 'update.zip');
  const stage = join(root, 'stage');
  const files = ['Readable Studio.exe', 'resources/readable-studio-config.json',
    ...['common.ps1', 'update-helper.ps1', 'update-broker.ps1'].map(name => `resources/update-helper/${name}`)];
  try {
    await mkdir(stage);
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem
$a = [IO.Compression.ZipFile]::Open($env:TEST_ZIP, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($name in ($env:TEST_FILES | ConvertFrom-Json)) {
    $e = $a.CreateEntry('app/' + $name)
    $e.LastWriteTime = [DateTimeOffset]::new(2020, 2, 4, 6, 8, 10, [TimeSpan]::Zero)
    $s = $e.Open(); try { $s.WriteByte(42) } finally { $s.Dispose() }
  }
} finally { $a.Dispose() }
$a = [IO.Compression.ZipFile]::OpenRead($env:TEST_ZIP)
try {
  [IO.Compression.ZipFileExtensions]::ExtractToFile($a.Entries[0], $env:TEST_REFERENCE, $false)
} finally { $a.Dispose() }
`;
    const reference = join(root, 'reference');
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, env: { ...process.env, TEST_ZIP: zip, TEST_FILES: JSON.stringify(files), TEST_REFERENCE: reference },
    });
    await extractUpdatePayload(zip, stage);
    const expected = (await stat(reference)).mtimeMs;
    for (const file of files) expect((await stat(join(stage, file))).mtimeMs).toBe(expected);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60000);

it('closes archive and entry streams after CreateNew failure without overwriting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extract-handles-'));
  const zip = join(root, 'update.zip');
  const stage = join(root, 'stage');
  try {
    await mkdir(stage);
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression,System.IO.Compression.FileSystem
$a = [IO.Compression.ZipFile]::Open($env:TEST_ZIP, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($name in @('app/file.bin', 'app/file.bin')) {
    $s = $a.CreateEntry($name).Open()
    try { $s.WriteByte(42) } finally { $s.Dispose() }
  }
} finally { $a.Dispose() }
`;
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, env: { ...process.env, TEST_ZIP: zip },
    });
    await expect(extractUpdatePayload(zip, stage)).rejects.toThrow();
    expect(await readFile(join(stage, 'file.bin'))).toEqual(Buffer.from([42]));
    // FileShare.None proves neither the archive nor output is still held on Windows.
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
foreach ($path in @($env:TEST_ZIP, $env:TEST_OUTPUT)) {
  $s = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  $s.Dispose()
}
`], { windowsHide: true, env: { ...process.env, TEST_ZIP: zip, TEST_OUTPUT: join(stage, 'file.bin') } });
    await rm(stage, { recursive: true });
    await rm(zip);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60000);
