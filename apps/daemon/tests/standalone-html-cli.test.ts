import { execFile, spawn } from 'node:child_process';
import { readFile, readdir, rm, mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const cliEntry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tsxImport = import.meta.resolve('tsx');

function execWithStdin(args: string[], input: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(Object.assign(new Error(stderr), { code })));
    child.stdin.end(input);
  });
}

describe('readable export html', () => {
  let server: http.Server;
  let baseUrl: string;
  let requestBody: unknown;
  let root: string;
  let responseStatus = 200;
  let publishRaceOutput: string | undefined;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'readable-export-html-cli-'));
    server = http.createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', async () => {
        requestBody = JSON.parse(body);
        if (responseStatus !== 200) {
          response.writeHead(responseStatus, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { code: 'BUNDLE_FAILED', message: 'fixture failure' } }));
          return;
        }
        if (publishRaceOutput) await writeFile(publishRaceOutput, 'racer');
        const html = '<!doctype html><p>standalone</p>';
        response.writeHead(200, {
          'content-type': 'text/html',
          'x-readable-studio-external-reference-count': '2',
          'x-readable-studio-missing-local-reference-count': '1',
          'x-readable-studio-skipped-system-font-count': '0',
          'content-length': Buffer.byteLength(html),
        });
        response.end(html);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  it('posts the shared request, writes atomically, and prints JSON warnings', async () => {
    const output = path.join(root, 'artifact.html');
    const result = await execFileAsync(process.execPath, [
      '--import', 'tsx', cliEntry, 'export', 'html',
      '--project', 'project-1', '--file', 'pages/index.html',
      '--output', output, '--json', '--daemon-url', baseUrl,
    ]);

    expect(requestBody).toEqual({ source: { kind: 'project', projectId: 'project-1', filePath: 'pages/index.html' } });
    expect(await readFile(output, 'utf8')).toBe('<!doctype html><p>standalone</p>');
    expect(JSON.parse(result.stdout)).toEqual({
      path: output,
      sizeBytes: 32,
      externalReferenceCount: 2,
      missingLocalReferenceCount: 1,
      skippedSystemFontCount: 0,
    });
  });

  it.each([
    {
      label: 'plugin example',
      args: ['--plugin', 'plugin-1', '--example', 'hero'],
      source: { kind: 'plugin', pluginId: 'plugin-1', exampleName: 'hero' },
    },
    {
      label: 'design system',
      args: ['--design-system', 'ds-1', '--view', 'showcase'],
      source: { kind: 'design-system', designSystemId: 'ds-1', view: 'showcase' },
    },
  ])('posts the $label source shape', async ({ args, source }) => {
    const output = path.join(root, `${String(source.kind)}.html`);
    await execFileAsync(process.execPath, [
      '--import', 'tsx', cliEntry, 'export', 'html', ...args,
      '--output', output, '--daemon-url', baseUrl,
    ]);
    expect(requestBody).toEqual({ source });
  });

  it('reads inline HTML from a file', async () => {
    const input = path.join(root, 'source.html');
    const output = path.join(root, 'inline.html');
    await writeFile(input, '<!doctype html><p>inline input</p>');
    await execFileAsync(process.execPath, [
      '--import', 'tsx', cliEntry, 'export', 'html',
      '--input', input, '--output', output, '--daemon-url', baseUrl,
    ]);
    expect(requestBody).toEqual({ source: { kind: 'inline', html: '<!doctype html><p>inline input</p>' } });
  });

  it('reads inline HTML from stdin when an output path is provided', async () => {
    const output = path.join(root, 'stdin.html');
    await execWithStdin([
      '--import', 'tsx', cliEntry, 'export', 'html', '--input', '-', '--output', output,
      '--daemon-url', baseUrl, '--json',
    ], '<!doctype html><p>stdin input</p>');
    expect(requestBody).toEqual({ source: { kind: 'inline', html: '<!doctype html><p>stdin input</p>' } });
    expect(await readFile(output, 'utf8')).toContain('standalone');
  });

  it('uses a safe default output filename and prints warning counts', async () => {
    const result = await execFileAsync(process.execPath, [
      '--import', tsxImport, cliEntry, 'export', 'html', '--plugin', 'default-plugin', '--daemon-url', baseUrl,
    ], { cwd: root });
    expect(await readFile(path.join(root, 'default-plugin-standalone.html'), 'utf8')).toContain('standalone');
    expect(result.stdout).toContain('Saved');
    expect(result.stderr).toContain('2 external, 1 missing local');
  });

  it('does not overwrite without --force and replaces with --force', async () => {
    const output = path.join(root, 'existing.html');
    await writeFile(output, 'original');
    const baseArgs = [
      '--import', 'tsx', cliEntry, 'export', 'html',
      '--plugin', 'plugin-1', '--output', output, '--daemon-url', baseUrl,
    ];
    await expect(execFileAsync(process.execPath, baseArgs)).rejects.toMatchObject({ code: 2 });
    expect(await readFile(output, 'utf8')).toBe('original');
    await execFileAsync(process.execPath, [...baseArgs, '--force']);
    expect(await readFile(output, 'utf8')).toBe('<!doctype html><p>standalone</p>');
  });

  it('rejects repeated and conflicting source selectors', async () => {
    const output = path.join(root, 'invalid.html');
    const repeated = execFileAsync(process.execPath, [
      '--import', 'tsx', cliEntry, 'export', 'html',
      '--project', 'one', '--project', 'two', '--file', 'index.html', '--output', output,
    ]);
    await expect(repeated).rejects.toMatchObject({ code: 2 });
    const conflicting = execFileAsync(process.execPath, [
      '--import', 'tsx', cliEntry, 'export', 'html',
      '--project', 'one', '--file', 'index.html', '--plugin', 'plugin-1', '--output', output,
    ]);
    await expect(conflicting).rejects.toMatchObject({ code: 2 });
    await expect(execFileAsync(process.execPath, [
      '--import', 'tsx', cliEntry, 'export', 'html', '--plugin=', '--output', output,
    ])).rejects.toMatchObject({ code: 2 });
  });

  it('rejects missing companion flags', async () => {
    const base = ['--import', 'tsx', cliEntry, 'export', 'html'];
    await expect(execFileAsync(process.execPath, [...base, '--project', 'one'])).rejects.toMatchObject({ code: 2 });
    await expect(execFileAsync(process.execPath, [...base, '--design-system', 'ds'])).rejects.toMatchObject({ code: 2 });
    await expect(execFileAsync(process.execPath, [...base, '--input', '-'])).rejects.toMatchObject({ code: 2 });
  });

  it('returns non-zero on server failure without leaving output or temp files', async () => {
    const output = path.join(root, 'failed.html');
    responseStatus = 422;
    try {
      await expect(execFileAsync(process.execPath, [
        '--import', 'tsx', cliEntry, 'export', 'html', '--plugin', 'plugin-1', '--output', output,
        '--daemon-url', baseUrl,
      ])).rejects.toMatchObject({ code: 1 });
      await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readdir(root)).filter((name) => name.includes('.tmp'))).toEqual([]);
    } finally {
      responseStatus = 200;
    }
  });

  it('cleans the temp file when a concurrent publisher wins without clobbering it', async () => {
    const output = path.join(root, 'publish-race.html');
    publishRaceOutput = output;
    try {
      await expect(execFileAsync(process.execPath, [
        '--import', 'tsx', cliEntry, 'export', 'html', '--plugin', 'plugin-1', '--output', output,
        '--daemon-url', baseUrl,
      ])).rejects.toMatchObject({ code: 1 });
      expect(await readFile(output, 'utf8')).toBe('racer');
      expect((await readdir(root)).filter((name) => name.includes('publish-race') && name.endsWith('.tmp'))).toEqual([]);
    } finally {
      publishRaceOutput = undefined;
    }
  });
});
