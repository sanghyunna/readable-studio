// Contract test for the `readable design-templates` CLI (user-imported deck
// templates). The CLI must drive the same /api/design-templates endpoints the
// Hub UI uses, with --json output, and surface daemon errors as a non-zero
// exit carrying the daemon's message. A stub HTTP server captures requests.

import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DESIGN_TEMPLATES_USAGE, isDesignTemplatesHelpArg } from '../src/design-templates-cli-help.js';
import { buildTemplateZip, validTemplateEntries } from './helpers/template-zip.js';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = pathResolve(__dirname, '..');
const REPO_ROOT = pathResolve(__dirname, '../../..');
const CLI_SRC = pathResolve(__dirname, '../src/cli.ts');
const TSX_CLI = pathResolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

interface Captured {
  method: string;
  url: string;
  contentType: string;
  body: Buffer;
}

type Responder = (req: Captured) => { status: number; body: unknown };

const SUMMARY = {
  id: 'user-quarterly-review',
  name: 'Quarterly Review',
  source: 'user',
  userImported: true,
  thumbnail: { status: 'pending', source: null, updatedAt: '2026-10-14T00:00:00.000Z' },
};

let server: http.Server;
let baseUrl = '';
const requests: Captured[] = [];
let responder: Responder = () => ({ status: 200, body: { ok: true } });
let tmp = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const captured: Captured = {
        method: req.method ?? '',
        url: req.url ?? '',
        contentType: String(req.headers['content-type'] ?? ''),
        body: Buffer.concat(chunks),
      };
      requests.push(captured);
      const out = responder(captured);
      res.statusCode = out.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  tmp = mkdtempSync(join(tmpdir(), 'udt-cli-'));
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  requests.length = 0;
  responder = () => ({ status: 200, body: { ok: true } });
});

async function runCli(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [TSX_CLI, CLI_SRC, ...args, '--daemon-url', baseUrl], {
      cwd: DAEMON_ROOT,
      env,
      windowsHide: true,
      timeout: 20_000,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const failed = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failed.stdout ?? '', stderr: failed.stderr ?? '', code: failed.code ?? 1 };
  }
}

describe('readable design-templates help surface', () => {
  it('advertises every subcommand and routes help flags', () => {
    for (const sub of ['import', 'list', '--user', 'rename', 'remove', 'thumbnails', '--json']) {
      expect(DESIGN_TEMPLATES_USAGE).toContain(sub);
    }
    expect(isDesignTemplatesHelpArg('--help')).toBe(true);
    expect(isDesignTemplatesHelpArg('-h')).toBe(true);
    expect(isDesignTemplatesHelpArg('list')).toBe(false);
  });
});

describe('readable design-templates CLI', () => {
  it('import uploads the zip as multipart field "file" and prints --json', async () => {
    const zipPath = join(tmp, 'Quarterly Review.zip');
    writeFileSync(zipPath, buildTemplateZip(validTemplateEntries()));
    responder = () => ({ status: 201, body: { template: SUMMARY } });

    const result = await runCli(['design-templates', 'import', zipPath, '--json']);

    expect(result.code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.url).toBe('/api/design-templates/import');
    expect(requests[0]!.contentType).toMatch(/^multipart\/form-data; boundary=/);
    const raw = requests[0]!.body.toString('latin1');
    expect(raw).toContain('name="file"; filename="Quarterly Review.zip"');
    expect(raw).toContain('PK\u0003\u0004');
    expect(JSON.parse(result.stdout)).toEqual({ template: SUMMARY });
  });

  it('import prints a human line without --json', async () => {
    const zipPath = join(tmp, 'deck.zip');
    writeFileSync(zipPath, buildTemplateZip(validTemplateEntries()));
    responder = () => ({ status: 201, body: { template: SUMMARY } });
    const result = await runCli(['design-templates', 'import', zipPath]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('user-quarterly-review');
    expect(result.stdout).toContain('pending');
  });

  it('import of a missing file exits 2 without contacting the daemon', async () => {
    const result = await runCli(['design-templates', 'import', join(tmp, 'nope.zip')]);
    expect(result.code).toBe(2);
    expect(requests).toHaveLength(0);
  });

  it('list --user filters to user-imported templates', async () => {
    responder = () => ({
      status: 200,
      body: { designTemplates: [{ id: 'builtin-deck', name: 'Built-in', source: 'built-in' }, SUMMARY] },
    });
    const json = await runCli(['design-templates', 'list', '--user', '--json']);
    expect(json.code).toBe(0);
    expect(requests[0]).toMatchObject({ method: 'GET', url: '/api/design-templates' });
    expect(JSON.parse(json.stdout)).toEqual({ designTemplates: [SUMMARY] });

    const all = await runCli(['design-templates', 'list', '--json']);
    expect(JSON.parse(all.stdout).designTemplates).toHaveLength(2);

    const text = await runCli(['design-templates', 'list']);
    expect(text.stdout).toContain('builtin-deck');
    expect(text.stdout).toMatch(/user-quarterly-review\tQuarterly Review/);
  });

  it('rename PATCHes {name} joining the remaining words', async () => {
    responder = () => ({ status: 200, body: { template: { ...SUMMARY, name: 'Board Pack' } } });
    const result = await runCli(['design-templates', 'rename', 'user-quarterly-review', 'Board', 'Pack', '--json']);
    expect(result.code).toBe(0);
    expect(requests[0]).toMatchObject({ method: 'PATCH', url: '/api/design-templates/user-quarterly-review' });
    expect(JSON.parse(requests[0]!.body.toString('utf8'))).toEqual({ name: 'Board Pack' });
    expect(JSON.parse(result.stdout).template.name).toBe('Board Pack');
  });

  it('remove DELETEs the template and prints --json', async () => {
    responder = () => ({ status: 200, body: { ok: true, id: 'user-quarterly-review' } });
    const result = await runCli(['design-templates', 'remove', 'user-quarterly-review', '--json']);
    expect(result.code).toBe(0);
    expect(requests[0]).toMatchObject({ method: 'DELETE', url: '/api/design-templates/user-quarterly-review' });
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, id: 'user-quarterly-review' });
  });

  it('thumbnails POSTs the regenerate endpoint', async () => {
    responder = () => ({ status: 200, body: { template: SUMMARY } });
    const result = await runCli(['design-templates', 'thumbnails', 'user-quarterly-review', '--json']);
    expect(result.code).toBe(0);
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/api/design-templates/user-quarterly-review/thumbnails' });
    expect(JSON.parse(result.stdout).template.thumbnail.status).toBe('pending');
  });

  it('non-2xx exits non-zero with the daemon message', async () => {
    responder = () => ({
      status: 403,
      body: { error: { code: 'FORBIDDEN', message: 'built-in design templates are read-only' } },
    });
    const result = await runCli(['design-templates', 'remove', 'builtin-deck', '--json']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('built-in design templates are read-only');
  });

  it('missing id prints usage and exits 2', async () => {
    const result = await runCli(['design-templates', 'rename', 'user-x']);
    expect(result.code).toBe(2);
    expect(requests).toHaveLength(0);
  });
});
