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
import { gzipSync } from 'node:zlib';
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
      // status 0: drop the connection so the CLI's fetch rejects.
      if (out.status === 0) return void req.socket.destroy();
      res.statusCode = out.status;
      res.setHeader('content-type', 'application/json');
      // Compress like the daemon does: a hard process.exit() right after
      // several gzip replies aborts Node on Windows (UV_HANDLE_CLOSING).
      if (!/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) return void res.end(JSON.stringify(out.body));
      res.setHeader('content-encoding', 'gzip');
      res.end(gzipSync(JSON.stringify(out.body)));
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

const SESSION = 'a'.repeat(32);
const ANALYSIS = {
  kind: 'single',
  detectedType: 'report',
  detection: { type: 'report', confidence: 'high', ambiguous: false, signals: ['decided:page-vote'] },
  sessionId: SESSION,
  expiresAt: '2026-10-19T01:00:00.000Z',
  originalFileName: 'kit.zip',
  prompt: { file: 'PROMPT.md' },
  suggestedName: 'Kit Pack',
  suggestedCoverPageId: 'page-1',
  pages: [
    { id: 'page-1', file: 'kit/cover.html', previewUrl: `/api/design-template-uploads/${SESSION}/pages/kit/cover.html`, thumbnailUrl: `/api/design-template-uploads/${SESSION}/thumbnails/page-1`, thumbnail: { status: 'pending', source: null, updatedAt: '2026-10-19T00:00:00.000Z' } },
    { id: 'page-2', file: 'kit/report.htm', previewUrl: `/api/design-template-uploads/${SESSION}/pages/kit/report.htm`, thumbnailUrl: `/api/design-template-uploads/${SESSION}/thumbnails/page-2`, thumbnail: { status: 'pending', source: null, updatedAt: '2026-10-19T00:00:00.000Z' } },
  ],
};

describe('readable design-templates upload wizard CLI', () => {
  const uploadResponder: Responder = (req) => {
    if (req.url === '/api/design-template-uploads/analyse') return { status: 201, body: ANALYSIS };
    if (req.url.endsWith('/finalize')) return { status: 201, body: { template: { ...SUMMARY, templateType: 'report' } } };
    if (req.method === 'DELETE') return { status: 200, body: { ok: true } };
    return { status: 200, body: ANALYSIS };
  };
  const writeZip = () => {
    const zipPath = join(tmp, 'kit.zip');
    writeFileSync(zipPath, buildTemplateZip(validTemplateEntries()));
    return zipPath;
  };

  it('help advertises the wizard subcommands and flags', () => {
    for (const token of ['analyse', 'inspect-upload', 'finalize', 'cancel-upload', 'cancel-bundle', '--all', '--type', '--name', '--cover-page', '--cover', '--prompt-file', '{type?,name,coverPageId}']) {
      expect(DESIGN_TEMPLATES_USAGE).toContain(token);
    }
    expect(DESIGN_TEMPLATES_USAGE).not.toContain('website');
  });

  it('analyse prints the detected type; an ambiguous detection hints at --type', async () => {
    responder = uploadResponder;
    const analysed = await runCli(['design-templates', 'analyse', writeZip()]);
    expect(analysed.code).toBe(0);
    expect(analysed.stdout).toContain(`session ${SESSION}`);
    expect(analysed.stdout).toContain('type: report (high)\n');

    responder = () => ({ status: 200, body: { ...ANALYSIS, detectedType: 'deck', detection: { type: 'deck', confidence: 'low', ambiguous: true, signals: [] } } });
    const inspected = await runCli(['design-templates', 'inspect-upload', SESSION]);
    expect(inspected.code).toBe(0);
    expect(inspected.stdout).toContain('type: deck (low, ambiguous: pass --type to override)');
  });

  it('analyse uploads the zip to the analyse endpoint and prints --json', async () => {
    responder = uploadResponder;
    const result = await runCli(['design-templates', 'analyse', writeZip(), '--json']);
    expect(result.code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/api/design-template-uploads/analyse' });
    expect(requests[0]!.body.toString('latin1')).toContain('name="file"; filename="kit.zip"');
    expect(JSON.parse(result.stdout)).toEqual(ANALYSIS);
  });

  it('inspect-upload GETs the session and cancel-upload DELETEs it', async () => {
    responder = uploadResponder;
    const inspect = await runCli(['design-templates', 'inspect-upload', SESSION, '--json']);
    expect(inspect.code).toBe(0);
    expect(requests[0]).toMatchObject({ method: 'GET', url: `/api/design-template-uploads/${SESSION}` });
    expect(JSON.parse(inspect.stdout).pages).toHaveLength(2);
    const cancel = await runCli(['design-templates', 'cancel-upload', SESSION, '--json']);
    expect(cancel.code).toBe(0);
    expect(requests[1]).toMatchObject({ method: 'DELETE', url: `/api/design-template-uploads/${SESSION}` });
    expect(JSON.parse(cancel.stdout)).toEqual({ ok: true });
  });

  it('finalize POSTs {type,name,coverPageId} from flags or --prompt-file', async () => {
    responder = uploadResponder;
    const flags = await runCli(['design-templates', 'finalize', SESSION, '--type', 'report', '--name', 'Kit Report', '--cover-page', 'page-2', '--json']);
    expect(flags.code).toBe(0);
    expect(requests[0]).toMatchObject({ method: 'POST', url: `/api/design-template-uploads/${SESSION}/finalize` });
    expect(JSON.parse(requests[0]!.body.toString('utf8'))).toEqual({ type: 'report', name: 'Kit Report', coverPageId: 'page-2' });
    expect(JSON.parse(flags.stdout).template.templateType).toBe('report');

    const file = join(tmp, 'finalize.json');
    writeFileSync(file, JSON.stringify({ name: 'Kit Site', coverPageId: 'page-1' }));
    const fromFile = await runCli(['design-templates', 'finalize', SESSION, '--prompt-file', file, '--json']);
    expect(fromFile.code).toBe(0);
    expect(JSON.parse(requests[1]!.body.toString('utf8'))).toEqual({ name: 'Kit Site', coverPageId: 'page-1' });
  });

  it('finalize without --type omits type so the daemon uses its detection', async () => {
    responder = uploadResponder;
    const result = await runCli(['design-templates', 'finalize', SESSION, '--name', 'Kit', '--cover-page', 'page-1']);
    expect(result.code).toBe(0);
    expect(JSON.parse(requests[0]!.body.toString('utf8'))).toEqual({ name: 'Kit', coverPageId: 'page-1' });
    expect(result.stdout).toContain('Imported user-quarterly-review');
  });

  it('--type website is rejected for import, finalize and --prompt-file without a request', async () => {
    responder = uploadResponder;
    const file = join(tmp, 'website.json');
    writeFileSync(file, JSON.stringify({ type: 'website', name: 'Kit Site', coverPageId: 'page-1' }));
    for (const args of [
      ['import', writeZip(), '--type', 'website'],
      ['finalize', SESSION, '--type', 'website', '--name', 'A', '--cover-page', 'page-1'],
      ['finalize', SESSION, '--prompt-file', file],
      ['import', writeZip(), '--prompt-file', file],
      ['import', writeZip(), '--all', '--type', 'website'],
    ]) {
      const result = await runCli(['design-templates', ...args]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('--type website: website templates can no longer be uploaded (use deck or report)');
    }
    const other = await runCli(['design-templates', 'import', writeZip(), '--type', 'slides']);
    expect(other.code).toBe(2);
    expect(other.stderr).toContain('--type must be one of deck, report');
    expect(requests).toHaveLength(0);
  });

  it('finalize rejects an invalid type, missing fields and --prompt-file overlap without a request', async () => {
    responder = uploadResponder;
    const file = join(tmp, 'overlap.json');
    writeFileSync(file, JSON.stringify({ type: 'deck', name: 'A', coverPageId: 'page-1' }));
    for (const args of [
      ['finalize', SESSION, '--type', 'slides', '--name', 'A', '--cover-page', 'page-1'],
      ['finalize', SESSION, '--type', 'deck', '--name', 'A'],
      ['finalize', SESSION, '--prompt-file', file, '--name', 'B'],
    ]) {
      const result = await runCli(['design-templates', ...args]);
      expect(result.code).toBe(2);
    }
    expect(requests).toHaveLength(0);
  });

  it('import with --type/--name/--cover analyses then finalizes with the mapped page id', async () => {
    responder = uploadResponder;
    const result = await runCli(['design-templates', 'import', writeZip(), '--type', 'report', '--name', 'Kit Report', '--cover', './kit/report.htm', '--json']);
    expect(result.code).toBe(0);
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST /api/design-template-uploads/analyse',
      `POST /api/design-template-uploads/${SESSION}/finalize`,
    ]);
    expect(JSON.parse(requests[1]!.body.toString('utf8'))).toEqual({ type: 'report', name: 'Kit Report', coverPageId: 'page-2' });
    expect(JSON.parse(result.stdout).template.templateType).toBe('report');
  });

  it('import fills omitted options from the analysis and cancels on an unknown --cover', async () => {
    responder = uploadResponder;
    const typed = await runCli(['design-templates', 'import', writeZip(), '--type', 'deck', '--json']);
    expect(typed.code).toBe(0);
    expect(JSON.parse(requests[1]!.body.toString('utf8'))).toEqual({ type: 'deck', name: 'Kit Pack', coverPageId: 'page-1' });

    // No --type: the body leaves the type to the daemon's detection.
    requests.length = 0;
    const named = await runCli(['design-templates', 'import', writeZip(), '--name', 'Kit Deck', '--json']);
    expect(named.code).toBe(0);
    expect(JSON.parse(requests[1]!.body.toString('utf8'))).toEqual({ name: 'Kit Deck', coverPageId: 'page-1' });

    requests.length = 0;
    const unknown = await runCli(['design-templates', 'import', writeZip(), '--cover', 'kit/missing.html', '--json']);
    expect(unknown.code, unknown.stderr).toBe(2);
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST /api/design-template-uploads/analyse',
      `DELETE /api/design-template-uploads/${SESSION}`,
    ]);
  });

  it('import cancels the session and exits 1 with the daemon message when finalize fails', async () => {
    responder = (req) => (req.url.endsWith('/finalize')
      ? { status: 400, body: { error: { code: 'BAD_REQUEST', message: 'name is too long' } } }
      : uploadResponder(req));
    const result = await runCli(['design-templates', 'import', writeZip(), '--name', 'Kit']);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain('name is too long');
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST /api/design-template-uploads/analyse',
      `POST /api/design-template-uploads/${SESSION}/finalize`,
      `DELETE /api/design-template-uploads/${SESSION}`,
    ]);
  });
});

const BUNDLE_ID = 'b'.repeat(32);
const CHILD_1 = 'c'.repeat(32);
const CHILD_2 = 'd'.repeat(32);
const child = (sessionId: string, suggestedName: string, type: 'deck' | 'report', ambiguous: boolean) => ({
  ...ANALYSIS,
  sessionId,
  bundleId: BUNDLE_ID,
  suggestedName,
  detectedType: type,
  detection: { type, confidence: ambiguous ? 'low' : 'high', ambiguous, signals: [] },
});
const BUNDLE = {
  kind: 'bundle',
  bundleId: BUNDLE_ID,
  expiresAt: '2026-10-19T01:00:00.000Z',
  originalFileName: 'pack.zip',
  templates: [
    { index: 0, entryName: 'alpha.zip', ok: true, analysis: child(CHILD_1, 'Alpha', 'deck', false) },
    { index: 1, entryName: 'broken.zip', ok: false, reason: 'template zip must contain PROMPT.md at its root' },
    { index: 2, entryName: 'beta.zip', ok: true, analysis: child(CHILD_2, 'Beta', 'report', true) },
  ],
};

describe('readable design-templates bundle CLI', () => {
  // CHILD_2's finalize fails so --all reports a partial failure.
  const bundleResponder: Responder = (req) => {
    if (req.url === '/api/design-template-uploads/analyse') return { status: 201, body: BUNDLE };
    if (req.url === `/api/design-template-uploads/${CHILD_1}/finalize`) return { status: 201, body: { template: { ...SUMMARY, id: 'user-alpha' } } };
    if (req.url.endsWith('/finalize')) return { status: 400, body: { error: { code: 'BAD_REQUEST', message: 'name is required' } } };
    if (req.url === `/api/design-template-uploads/bundles/${BUNDLE_ID}`) return { status: 200, body: { ok: true, cancelledSessionIds: [CHILD_1, CHILD_2] } };
    return { status: 200, body: { ok: true } };
  };
  const writeZip = () => {
    const zipPath = join(tmp, 'pack.zip');
    writeFileSync(zipPath, buildTemplateZip(validTemplateEntries()));
    return zipPath;
  };

  it('analyse lists every bundle template (text) and prints the raw response (--json)', async () => {
    responder = bundleResponder;
    const text = await runCli(['design-templates', 'analyse', writeZip()]);
    expect(text.code).toBe(0);
    expect(text.stdout.trim().split(/\r?\n/)).toEqual([
      `bundle ${BUNDLE_ID} (expires 2026-10-19T01:00:00.000Z): 2/3 templates`,
      `[1/3] alpha.zip\tsession ${CHILD_1}\ttype deck (high)\tpages 2\tname: Alpha`,
      '[2/3] broken.zip\tFAILED: template zip must contain PROMPT.md at its root',
      `[3/3] beta.zip\tsession ${CHILD_2}\ttype report (low, ambiguous)\tpages 2\tname: Beta`,
    ]);

    const json = await runCli(['design-templates', 'analyse', writeZip(), '--json']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual(BUNDLE);
  });

  it('import --all finalizes each ok template with its suggestions, reports failures and exits 1', async () => {
    responder = bundleResponder;
    const result = await runCli(['design-templates', 'import', writeZip(), '--all', '--json']);
    expect(result.code).toBe(1);
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST /api/design-template-uploads/analyse',
      `POST /api/design-template-uploads/${CHILD_1}/finalize`,
      `POST /api/design-template-uploads/${CHILD_2}/finalize`,
      `DELETE /api/design-template-uploads/${CHILD_2}`,
      // The bundle itself is released once the loop ends; finalized templates stay.
      `DELETE /api/design-template-uploads/bundles/${BUNDLE_ID}`,
    ]);
    expect(JSON.parse(requests[1]!.body.toString('utf8'))).toEqual({ name: 'Alpha', coverPageId: 'page-1' });
    expect(JSON.parse(result.stdout)).toEqual({
      imported: [{ entry: 'alpha.zip', template: { ...SUMMARY, id: 'user-alpha' } }],
      failed: [
        { entry: 'broken.zip', error: 'template zip must contain PROMPT.md at its root' },
        { entry: 'beta.zip', error: 'name is required' },
      ],
    });

    const text = await runCli(['design-templates', 'import', writeZip(), '--all']);
    expect(text.code).toBe(1);
    expect(text.stdout).toContain('Imported user-alpha');
    expect(text.stderr).toContain('Failed broken.zip: template zip must contain PROMPT.md at its root');
    expect(text.stderr).toContain('Failed beta.zip: name is required');
  });

  it('import --all --type overrides the detected type of every bundle template', async () => {
    responder = bundleResponder;
    const result = await runCli(['design-templates', 'import', writeZip(), '--all', '--type', 'report', '--json']);
    expect(result.code).toBe(1);
    const finalizeBodies = requests.filter((r) => r.url.endsWith('/finalize')).map((r) => JSON.parse(r.body.toString('utf8')));
    expect(finalizeBodies).toEqual([
      { type: 'report', name: 'Alpha', coverPageId: 'page-1' },
      { type: 'report', name: 'Beta', coverPageId: 'page-1' },
    ]);
  });

  it('import --all records a finalize transport failure per item and keeps going', async () => {
    responder = (req) => (req.url === `/api/design-template-uploads/${CHILD_1}/finalize` ? { status: 0, body: null } : bundleResponder(req));
    const result = await runCli(['design-templates', 'import', writeZip(), '--all', '--json']);
    expect(result.code).toBe(1);
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST /api/design-template-uploads/analyse',
      `POST /api/design-template-uploads/${CHILD_1}/finalize`,
      `DELETE /api/design-template-uploads/${CHILD_1}`,
      `POST /api/design-template-uploads/${CHILD_2}/finalize`,
      `DELETE /api/design-template-uploads/${CHILD_2}`,
      `DELETE /api/design-template-uploads/bundles/${BUNDLE_ID}`,
    ]);
    expect(JSON.parse(result.stdout)).toEqual({
      imported: [],
      failed: [
        { entry: 'alpha.zip', error: expect.stringContaining('fetch failed') },
        { entry: 'broken.zip', error: 'template zip must contain PROMPT.md at its root' },
        { entry: 'beta.zip', error: 'name is required' },
      ],
    });
  });

  it('import --all on a failing single-template zip cancels its session and sends no bundle DELETE', async () => {
    responder = (req) => {
      if (req.url === '/api/design-template-uploads/analyse') return { status: 201, body: ANALYSIS };
      if (req.url.endsWith('/finalize')) return { status: 400, body: { error: { code: 'BAD_REQUEST', message: 'name is required' } } };
      return { status: 200, body: { ok: true } };
    };
    const result = await runCli(['design-templates', 'import', writeZip(), '--all', '--json']);
    expect(result.code).toBe(1);
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST /api/design-template-uploads/analyse',
      `POST /api/design-template-uploads/${SESSION}/finalize`,
      `DELETE /api/design-template-uploads/${SESSION}`,
    ]);
    expect(JSON.parse(result.stdout)).toEqual({ imported: [], failed: [{ entry: 'pack.zip', error: 'name is required' }] });
  });

  it('text output escapes control characters in daemon-supplied names and reasons', async () => {
    const bundle = {
      ...BUNDLE,
      templates: [
        { index: 0, entryName: 'alpha.zip', ok: true, analysis: child(CHILD_1, 'Alpha\x1b[2J', 'deck', false) },
        { index: 1, entryName: 'evil\x1b]0;PWNED\x07\r.zip', ok: false, reason: 'unsafe zip path: kit/\x1b]0;PWNED\x07x.html (invalid character)' },
      ],
    };
    responder = (req) => {
      if (req.url === '/api/design-template-uploads/analyse') return { status: 201, body: bundle };
      if (req.url.endsWith('/finalize')) return { status: 201, body: { template: { ...SUMMARY, id: 'user-alpha', name: 'Alpha\x1b[2J' } } };
      return { status: 200, body: { ok: true } };
    };
    const analysed = await runCli(['design-templates', 'analyse', writeZip()]);
    expect(analysed.code).toBe(0);
    const imported = await runCli(['design-templates', 'import', writeZip(), '--all']);
    expect(imported.code).toBe(1);
    for (const out of [analysed.stdout, analysed.stderr, imported.stdout, imported.stderr]) {
      expect(out).not.toMatch(/[\x07\x1b]/);
    }
    expect(analysed.stdout).toContain('name: Alpha\\u001b[2J');
    expect(analysed.stdout).toContain('evil\\u001b]0;PWNED\\u0007\\u000d.zip\tFAILED: unsafe zip path: kit/\\u001b]0;PWNED\\u0007x.html (invalid character)');
    expect(imported.stdout).toContain('Imported user-alpha\tAlpha\\u001b[2J');
    expect(imported.stderr).toContain('Failed evil\\u001b]0;PWNED\\u0007\\u000d.zip: unsafe zip path: kit/\\u001b]0;PWNED\\u0007x.html');
  });

  it('import --all surfaces an analyse failure without finalizing anything', async () => {
    responder = () => ({
      status: 400,
      body: { error: { code: 'BAD_REQUEST', message: 'bundle contains no valid templates: a.zip: x' } },
    });
    const result = await runCli(['design-templates', 'import', writeZip(), '--all', '--json']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('bundle contains no valid templates: a.zip: x');
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual(['POST /api/design-template-uploads/analyse']);
  });

  it('import --all on a single-template zip imports it as one item; --type overrides every template', async () => {
    responder = (req) => {
      if (req.url === '/api/design-template-uploads/analyse') return { status: 201, body: ANALYSIS };
      return { status: 201, body: { template: SUMMARY } };
    };
    const result = await runCli(['design-templates', 'import', writeZip(), '--all', '--type', 'deck', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(requests[1]!.body.toString('utf8'))).toEqual({ type: 'deck', name: 'Kit Pack', coverPageId: 'page-1' });
    expect(JSON.parse(result.stdout)).toEqual({ imported: [{ entry: 'pack.zip', template: SUMMARY }], failed: [] });
  });

  it('import --all rejects the single-template options without a request', async () => {
    const file = join(tmp, 'all.json');
    writeFileSync(file, JSON.stringify({ name: 'A' }));
    for (const extra of [['--name', 'A'], ['--cover', 'kit/cover.html'], ['--prompt-file', file]]) {
      const result = await runCli(['design-templates', 'import', writeZip(), '--all', ...extra]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(`${extra[0]} cannot be combined with --all`);
    }
    expect(requests).toHaveLength(0);
  });

  it('import with single-template options on a bundle cancels the bundle and exits 2', async () => {
    responder = bundleResponder;
    const result = await runCli(['design-templates', 'import', writeZip(), '--name', 'Pack']);
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain('is a bundle of 3 templates; use --all');
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST /api/design-template-uploads/analyse',
      `DELETE /api/design-template-uploads/bundles/${BUNDLE_ID}`,
    ]);
  });

  it('import without options surfaces the daemon rejecting a bundle', async () => {
    responder = () => ({
      status: 400,
      body: { error: { code: 'BAD_REQUEST', message: 'zip is a template bundle (2 templates); use the template upload wizard or "readable design-templates import <zip> --all"' } },
    });
    const result = await runCli(['design-templates', 'import', writeZip()]);
    expect(result.code).not.toBe(0);
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual(['POST /api/design-templates/import']);
    expect(result.stderr).toContain('zip is a template bundle (2 templates)');
  });

  it('cancel-bundle DELETEs the bundle and reports the cancelled count', async () => {
    responder = bundleResponder;
    const text = await runCli(['design-templates', 'cancel-bundle', BUNDLE_ID]);
    expect(text.code).toBe(0);
    expect(requests[0]).toMatchObject({ method: 'DELETE', url: `/api/design-template-uploads/bundles/${BUNDLE_ID}` });
    expect(text.stdout).toContain(`Cancelled 2 unsaved template(s) of bundle ${BUNDLE_ID}`);

    const json = await runCli(['design-templates', 'cancel-bundle', BUNDLE_ID, '--json']);
    expect(JSON.parse(json.stdout)).toEqual({ ok: true, cancelledSessionIds: [CHILD_1, CHILD_2] });

    const missing = await runCli(['design-templates', 'cancel-bundle']);
    expect(missing.code).toBe(2);
    expect(requests).toHaveLength(2);
  });
});

describe('readable design-templates legacy argument errors', () => {
  it('rename without a name still exits 2', async () => {
    const result = await runCli(['design-templates', 'rename', 'user-x']);
    expect(result.code).toBe(2);
    expect(requests).toHaveLength(0);
  });
});
