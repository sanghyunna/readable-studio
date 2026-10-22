import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { createQaNamespaces, parseOptions, PortableQaError, runCommand, sha256File, validateEvidenceRoot, verifyZipReceipt, workspaceRoot } from '../scripts/portable-qa-support.ts';
import { assertPortableBoundaries, assertPristinePortableRoot, copySealedPortableTree, extractPortable, launchEnvironment, portableAppRoot, preparePortableQaRoot, waitForLauncherReady, type AppCapture } from '../scripts/portable-qa-runtime.ts';
import { setNativeState } from '../lib/portable-qa-footer-geometry.ts';
import { T } from '../lib/timeouts.ts';

test('concurrent QA invocations have distinct namespaces even with the same coordinator run id', async () => {
  const runs = await Promise.all(['tree-precheck', 'zip-gate', 'tree-precheck'].map(async (mode) =>
    createQaNamespaces(mode as 'tree-precheck' | 'zip-gate')));
  const namespaces = runs.flatMap(Object.values);
  assert.equal(new Set(namespaces).size, namespaces.length);
  runs.forEach((run, index) => {
    for (const namespace of Object.values(run)) {
      assert.ok(namespace.startsWith(`qa-${index === 1 ? 'zip-gate' : 'tree-precheck'}-`));
      assert.match(namespace, /^[a-z0-9-]+$/);
    }
  });
});

test('offline launches use private profiles and system-only PATH without host CLI overrides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'readable-qa-env-'));
  try {
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATH',
      'READABLE_AGENT_HOME', 'OPENCODE_BIN', 'NODE_OPTIONS']) vi.stubEnv(key, 'C:\\host-agent-fixture');
    const trap = { proxyUrl: 'http://127.0.0.1:1234', attempts: [], close: async () => {} };
    const env = await launchEnvironment('qa-private', trap, true, root);
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) {
      assert.ok(env[key]!.startsWith(root));
      assert.ok((await stat(env[key]!)).isDirectory());
    }
    const windows = process.env.SystemRoot!;
    assert.deepEqual(env.PATH!.split(';'), [
      join(windows, 'System32'), windows, join(windows, 'System32', 'Wbem'),
      join(windows, 'System32', 'WindowsPowerShell', 'v1.0'),
    ]);
    assert.equal(Object.keys(env).filter((key) => key.toLowerCase() === 'path').length, 1);
    assert.equal(Object.values(env).some((value) => value.includes('host-agent-fixture')), false);
    assert.equal(env.HTTP_PROXY, trap.proxyUrl);
    assert.equal(env.HTTPS_PROXY, trap.proxyUrl);
    assert.equal(env.ALL_PROXY, trap.proxyUrl);
    assert.equal(env.NO_PROXY, '127.0.0.1,localhost');
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});

test('portable boundary excludes external agent payloads using bundled Node but rejects runtime fallback', () => {
  const root = resolve('D:/portable-fixture');
  const namespace = 'boundary-test';
  const namespaceRoot = join(root, 'ReadableStudioData', 'namespaces', namespace);
  const executablePath = join(root, 'app', 'Readable Studio.exe');
  const processes = ['', '--type=gpu-process', '--type=utility --utility-sub-type=network.mojom.NetworkService']
    .map((flags, index) => ({
      pid: index + 1, parentPid: 0, name: 'Readable Studio.exe', executablePath,
      commandLine: `"${executablePath}" ${flags} --user-data-dir="${namespaceRoot}"`,
    }));
  const external = {
    pid: 4, parentPid: 1, name: 'node.exe',
    executablePath: join(root, 'app', 'resources', 'readable-studio', 'bin', 'node.exe'),
    commandLine: '"node" "C:\\Users\\qa\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\dist\\index.js" --help',
  };
  const capture = { namespace, networkRequests: [] } as unknown as AppCapture;
  const trap = { proxyUrl: '', attempts: [], close: async () => {} };
  assert.doesNotThrow(() => assertPortableBoundaries(root, capture, { processes: [...processes, external], connections: [] }, trap));
  const fallback = { ...external, commandLine: `"${external.executablePath}" "${root}\\app\\runtime.mjs" --fallback=C:\\Users\\qa\\AppData\\runtime` };
  assert.throws(() => assertPortableBoundaries(root, capture, { processes: [...processes, fallback], connections: [] }, trap), /AppData fallback leak/);
});

test('native compact sizing compensates a Windows non-client frame and restores content size', () => {
  let width = 1200;
  let height = 800;
  let zoom = 1;
  const window = {
    webContents: {
      getZoomFactor: () => zoom,
      setZoomFactor: (value: number) => { zoom = value; },
      capturePage: async () => { throw new Error('capture not expected'); },
    },
    getBounds: () => ({ x: 0, y: 0, width, height }),
    getContentBounds: () => ({ x: 0, y: 0, width: width - 6, height: height - 3 }),
    getContentSize: () => [width - 6, height - 3],
    // Reproduce the observed frameless Windows behavior: the requested content
    // size becomes the outer bounds, leaving the non-client frame unaccounted.
    setContentSize: (w: number, h: number) => { width = w; height = h; },
    setSize: (w: number, h: number) => { width = w; height = h; },
  };
  assert.deepEqual(setNativeState(window, { contentWidth: 900, contentHeight: 680, zoomFactor: 2 }),
    { contentWidth: 900, contentHeight: 680, zoomFactor: 2 });
  assert.deepEqual(setNativeState(window, { contentWidth: 1194, contentHeight: 797, zoomFactor: 1 }),
    { contentWidth: 1194, contentHeight: 797, zoomFactor: 1 });
});

test('portable executable and CLI resources resolve the app payload rather than the launcher', async () => {
  const root = await mkdtemp(join(tmpdir(), 'readable-qa-layout-'));
  try {
    await writeFile(join(root, 'Readable Studio.exe'), 'launcher');
    assert.equal(portableAppRoot(root), root);
    await mkdir(join(root, 'app'));
    await writeFile(join(root, 'app', 'Readable Studio.exe'), 'electron');
    assert.equal(portableAppRoot(root), join(root, 'app'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('launcher smoke subscribes before startup and requires both readiness events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'readable-qa-ready-'));
  try {
    const logPath = join(root, 'latest.log');
    let writes: Promise<void> | undefined;
    const ready = waitForLauncherReady(root, logPath, () => {
      writes = writeFile(logPath, 'daemon-status-ready\nmain window revealed\n');
    });
    assert.match(await ready, /main window revealed/);
    await writes;
    await assert.rejects(waitForLauncherReady(root, logPath, () => { throw new Error('launch failed'); }), /launch failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('launcher smoke fails at its bounded readiness deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'readable-qa-deadline-'));
  vi.useFakeTimers();
  try {
    const ready = waitForLauncherReady(root, join(root, 'latest.log'), () => {}, 180_000);
    const rejected = assert.rejects(ready, /launcher readiness timed out/);
    await vi.advanceTimersByTimeAsync(180_000);
    await rejected;
  } finally {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});

const rejectionMessage = /evidence root .* is not inside the dedicated evidence directory .*; refusing to delete workspace, git, or ancestor paths/;

test('portable QA validates every evidence-root allow and deny case', () => {
  const evidenceRoot = resolve(workspaceRoot, '.omo', 'evidence');
  const cases = [
    ['workspace root', workspaceRoot, false],
    ['repository root', workspaceRoot, false],
    ['repository ancestor', resolve(workspaceRoot, '..'), false],
    ['git directory', resolve(workspaceRoot, '.git'), false],
    ['inside git directory', resolve(workspaceRoot, '.git', 'objects'), false],
    ['unrelated absolute path', resolve(tmpdir(), '..', 'foreign-evidence-root'), false],
    ['escaped traversal', resolve(evidenceRoot, '..', '..', 'escaped'), false],
    ['dedicated evidence subdirectory', resolve(evidenceRoot, 'portable-qa'), true],
    ['dedicated temp subdirectory', resolve(tmpdir(), 'portable-qa'), true],
  ] as const;

  for (const [label, path, accepted] of cases) {
    if (accepted) {
      assert.doesNotThrow(() => validateEvidenceRoot(path), label);
    } else {
      assert.throws(
        () => validateEvidenceRoot(path),
        (error: unknown) => error instanceof PortableQaError && rejectionMessage.test(error.message),
        label,
      );
    }
  }
});

test('portable QA preserves legacy options and requires complete sealed mode inputs', () => {
  assert.equal(parseOptions(['--zip', 'portable.zip', '--case', 'full', '--evidence', 'report']).mode, undefined);
  const tree = parseOptions(['--mode', 'tree-precheck', '--tree', 'tree', '--sealed-manifest', 'seal.txt', '--case', 'full', '--evidence', 'report']);
  assert.equal(tree.mode, 'tree-precheck');
  assert.equal(tree.treePath, resolve(workspaceRoot, 'tree'));
  assert.throws(() => parseOptions(['--mode', 'zip-gate', '--zip', 'a.zip', '--case', 'full', '--evidence', 'report']));
  assert.throws(() => parseOptions(['--mode', 'tree-precheck', '--tree', 'tree', '--sealed-manifest', 'seal.txt', '--case', 'bad-root', '--evidence', 'report']));
});

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function writeZipReceipt(zip: string, root: string): Promise<string> {
  const files = [{ path: basename(zip), size: (await stat(zip)).size, sha256: await sha256File(zip) }];
  const receipt = join(root, 'zip-receipt.txt');
  await writeFile(receipt, JSON.stringify({
    v: 1, runId: 'qa-test', node: 'zip', inputHash: 'sealed-tree-hash', outputRoot: root,
    files, manifestHash: digest(JSON.stringify(files)),
  }));
  return receipt;
}

test('ZIP receipt rejects stale identity, missing receipts and ZIP mutation after sealing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'readable-zip-receipt-'));
  try {
    const zip = join(root, 'portable.zip');
    await writeFile(zip, 'sealed archive');
    const receipt = await writeZipReceipt(zip, root);
    assert.equal(await verifyZipReceipt(zip, receipt, 'qa-test'), digest('sealed archive'));
    await assert.rejects(verifyZipReceipt(zip, receipt, 'another-run'), /identity/);
    await assert.rejects(verifyZipReceipt(zip, join(root, 'missing.txt'), 'qa-test'), /ENOENT/);
    await writeFile(zip, 'changed archiv');
    await assert.rejects(verifyZipReceipt(zip, receipt, 'qa-test'), /modified after receipt/);
    const value = JSON.parse(await readFile(receipt, 'utf8'));
    value.manifestHash = 'bad';
    await writeFile(receipt, JSON.stringify(value));
    await assert.rejects(verifyZipReceipt(zip, receipt, 'qa-test'), /manifest hash/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tree precheck copies sealed files privately, drops excluded locales and rejects preexisting user data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'readable-tree-copy-'));
  let privateRoot: string | undefined;
  try {
    const tree = join(root, 'tree');
    await mkdir(join(tree, 'app', 'locales'), { recursive: true });
    await mkdir(join(root, 'evidence'));
    const files = [
      { path: 'Readable Studio.exe', text: 'fake launcher, never executed' },
      { path: 'app/locales/en-US.pak', text: 'locale' },
    ];
    for (const file of files) await writeFile(join(tree, file.path), file.text);
    await writeFile(join(tree, 'app', 'locales', 'fr.pak'), 'excluded');
    await chmod(join(tree, 'Readable Studio.exe'), 0o444);
    const manifest = join(root, 'seal.txt');
    await writeFile(manifest, JSON.stringify({ v: 1, files: files.map(({ path, text }) => ({ path, size: Buffer.byteLength(text), sha256: digest(text) })) }));
    privateRoot = await preparePortableQaRoot({
      mode: 'tree-precheck', treePath: tree, sealedManifestPath: manifest,
      evidenceRoot: join(root, 'evidence'), case: 'full', offline: true, zipPath: '',
    });
    assert.notEqual((await stat(join(privateRoot, 'Readable Studio.exe'))).ino, (await stat(join(tree, 'Readable Studio.exe'))).ino);
    await writeFile(join(privateRoot, 'Readable Studio.exe'), 'private mutation');
    assert.equal(await readFile(join(tree, 'Readable Studio.exe'), 'utf8'), files[0]!.text);
    await assert.rejects(stat(join(privateRoot, 'app', 'locales', 'fr.pak')), /ENOENT/);
    await mkdir(join(tree, 'ReadableStudioData'));
    await assert.rejects(copySealedPortableTree(tree, manifest), /must not exist before launch/);
  } finally {
    await chmod(join(root, 'tree', 'Readable Studio.exe'), 0o666);
    await rm(root, { recursive: true, force: true });
    if (privateRoot != null) await rm(privateRoot, { recursive: true, force: true });
  }
});

test('7-Zip extraction rejects corrupt archives, CRC failures and missing top-level launchers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'readable-extract-gate-'));
  const extracted: string[] = [];
  const command: typeof runCommand = async (executable, args, input, options) => {
    const target = args.find((arg) => arg.startsWith('-o'));
    if (target != null) extracted.push(target.slice(2));
    return runCommand(executable, args, input, options);
  };
  try {
    const invalid = join(root, 'invalid.zip');
    await writeFile(invalid, 'not a ZIP');
    await assert.rejects(extractPortable(invalid, command));
    const source = join(root, 'Readable Studio.exe');
    const payload = Buffer.from('UNIQUE_STORED_LAUNCHER_PAYLOAD_CRC_CHECK');
    await writeFile(source, payload);
    const zip = join(root, 'portable.zip');
    const sevenZip = join(workspaceRoot, 'tools', 'pack', 'resources', 'win', '7zip', '7z.exe');
    const result = await runCommand(sevenZip, ['a', '-tzip', '-mx=0', zip, source]);
    assert.equal(result.exitCode, 0, result.stderr);
    const validRoot = await extractPortable(zip, command);
    await assertPristinePortableRoot(validRoot);
    const bytes = await readFile(zip);
    const offset = bytes.indexOf(payload);
    assert.ok(offset > 0);
    bytes[offset] = bytes[offset]! ^ 0xff;
    await writeFile(zip, bytes);
    await assert.rejects(extractPortable(zip, command));
    await rm(zip);
    const nested = join(root, 'wrong-root');
    await mkdir(nested);
    await writeFile(join(nested, 'Readable Studio.exe'), payload);
    assert.equal((await runCommand(sevenZip, ['a', '-tzip', zip, nested])).exitCode, 0);
    await assert.rejects(extractPortable(zip, command), /ENOENT|missing/);
  } finally {
    for (const directory of extracted) await rm(directory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}, T.medium);
