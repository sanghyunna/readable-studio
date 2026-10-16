import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { UpdateDownload } from '../src/update-download.js';
import { DatabricksUpdateSource } from '../src/update-source.js';
import type { UpdateCheckResult } from '@readable-studio/contracts';

const bytes = Buffer.from('verified update fixture');
const offer = { current: '1.3.3', latest: '1.3.4', isNewer: true, assetName: 'Readable-Studio-win-x64-portable.zip', assetSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), releaseUrl: 'https://updates.databricksapps.com', notes: '', checkedAt: new Date().toISOString() };
it('R10-01 retains apply failure through same-package checks and reconnect snapshots until retry or invalidation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'update-retained-apply-error-'));
  const download = new UpdateDownload(root);
  try {
    await mkdir(download.directory);
    await writeFile(download.zip, bytes);
    await writeFile(join(download.directory, 'ready.json'), JSON.stringify(offer));
    await download.staged(offer.current);
    download.extracting({ completed: 10, total: 10 });
    download.applyFailed('helper-not-acknowledged');
    for (const result of [offer, { unavailable: 'unreachable' }] satisfies UpdateCheckResult[]) {
      download.checking();
      await download.checked(result);
      await download.staged(offer.current);
      // Reconnecting SSE clients receive this current authoritative snapshot.
      expect(download.status).toMatchObject({ state: 'ready', error: 'helper-not-acknowledged', extraction: undefined });
    }
    download.extracting({ completed: 0, total: 10 });
    expect(download.status.error).toBeNull();
    download.applyFailed('helper-not-acknowledged');
    await download.checked({ ...offer, sha256: 'b'.repeat(64) });
    expect(download.status).toMatchObject({ state: 'available', error: null });
  } finally { await rm(root, { recursive: true, force: true }); }
});
it.each(['1.3.4', '1.3.5'])('drops an installed manifest offer from status at running version %s', async (current) => {
  const root = await mkdtemp(join(tmpdir(), 'update-current-status-'));
  try {
    const download = new UpdateDownload(root);
    await download.checked(offer);
    expect(download.status.state).toBe('available');
    download.checking();
    await download.checked({ ...offer, current, isNewer: false });
    expect(download.status).toMatchObject({ state: 'idle', version: null, received: 0, total: 0 });
    expect(download.status.releaseUrl).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('keeps whole-download emitter progress monotonic through checks, recovery, verifying and ready', async () => {
  const root = await mkdtemp(join(tmpdir(), 'update-whole-events-'));
  const download = new UpdateDownload(root);
  const statuses: import('@readable-studio/contracts').UpdateStatus[] = [];
  download.on('status', (status) => statuses.push(status));
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let opened!: () => void;
  const streamOpened = new Promise<void>((resolve) => { opened = resolve; });
  const source = new DatabricksUpdateSource(offer.releaseUrl, async () => ({ token: 'test', host: 'workspace' }),
    async () => new Response(new ReadableStream<Uint8Array>({ start(next) { controller = next; opened(); } })));
  const progress = (received: number) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { download.off('status', listener); reject(new Error('progress deadline')); }, 5000);
    const listener = () => {
      if (download.status.received !== received) return;
      clearTimeout(timer); download.off('status', listener); resolve();
    };
    download.on('status', listener);
  });
  try {
    await download.checked(offer);
    const done = settle(download);
    download.start(offer, source);
    await streamOpened;
    // Subscribe before pushing each chunk; checks and status recovery share the real emitter.
    for (const [start, end] of [[0, 5], [5, 12], [12, bytes.length]]) {
      const advanced = progress(end!);
      controller.enqueue(bytes.subarray(start, end));
      await advanced;
      download.checking();
      await download.checked(offer);
      await download.staged(offer.current);
    }
    controller.close();
    await done;
    expect(download.status.state).toBe('ready');
    expect(statuses.map((status) => status.state)).toEqual(expect.arrayContaining(['available', 'downloading', 'verifying', 'ready']));
    expect(statuses.map((status) => status.received)).toEqual([...statuses.map((status) => status.received)].sort((a, b) => a - b));
    expect(download.status.received).toBe(bytes.length);
  } finally { await download.cancel(); await rm(root, { recursive: true, force: true }); }
});

it.each([undefined, true])('never revives failed bytes after interrupted rollback invalidation, pending=%s', async (invalidationPending) => {
  const root = await mkdtemp(join(tmpdir(), 'update-interrupted-rollback-'));
  try {
    const download = new UpdateDownload(root);
    await mkdir(download.directory);
    await writeFile(download.zip, bytes);
    await writeFile(join(download.directory, 'ready.json'), JSON.stringify(offer));
    await writeFile(join(root, 'update-journal.json'), JSON.stringify({ id: 'failed-attempt', step: 'rolled-back', done: true, target: offer.current }));
    const event = { id: 'failure-event', version: offer.latest, sha256: offer.sha256, releaseUrl: offer.releaseUrl };
    await writeFile(join(root, '.update-failed-apply.json'), JSON.stringify({ journal: 'failed-attempt', event, invalidationPending }));
    expect(await download.staged(offer.current)).toBeNull();
    expect(download.status).toMatchObject({ state: 'failed', version: null, failedApply: event });
    await expect(access(download.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await new UpdateDownload(root).staged(offer.current)).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('retires a rollback event after the failed version is successfully installed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'update-retry-installed-'));
  try {
    const event = { id: 'old-failure', version: offer.latest, sha256: offer.sha256, releaseUrl: offer.releaseUrl };
    await writeFile(join(root, '.update-failed-apply.json'), JSON.stringify({ journal: 'old-rollback', event, invalidationPending: false }));
    const download = new UpdateDownload(root);
    await download.staged(offer.latest);
    expect(download.status.failedApply).toBeUndefined();
    await download.checked({ ...offer, current: offer.latest, isNewer: false });
    expect(download.status).toMatchObject({ state: 'idle', error: null });
    await expect(access(join(root, '.update-failed-apply.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const restarted = new UpdateDownload(root);
    await restarted.staged(offer.latest);
    expect(restarted.status.failedApply).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('discards a rolled-back package durably, preserves its identity, and downloads a deliberate retry again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'update-rollback-'));
  try {
    const download = new UpdateDownload(root);
    await mkdir(download.directory);
    await writeFile(download.zip, bytes);
    await writeFile(join(download.directory, 'ready.json'), JSON.stringify(offer));
    await writeFile(join(root, 'update-journal.json'), JSON.stringify({ step: 'rolled-back', done: true, target: offer.current }));
    expect(await download.staged(offer.current)).toBeNull();
    expect(download.status).toMatchObject({ state: 'failed', version: null, received: 0, error: 'apply-rolled-back',
      failedApply: { id: expect.any(String), version: offer.latest, sha256: offer.sha256, releaseUrl: offer.releaseUrl } });
    await expect(access(download.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    const recovered = new UpdateDownload(root);
    await recovered.staged(offer.current);
    expect(recovered.status).toEqual(download.status);
    const event = download.status.failedApply;
    await recovered.checked(offer);
    expect(recovered.status).toMatchObject({ state: 'failed', failedApply: event });
    await recovered.checked({ ...offer, releaseUrl: 'https://other.databricksapps.com' });
    expect(recovered.status.state).toBe('failed');
    for (const replacement of [{ ...offer, latest: '1.3.5' }, { ...offer, sha256: 'b'.repeat(64) }]) {
      await recovered.checked(replacement);
      expect(recovered.status.state).toBe('available');
    }
    const source = new DatabricksUpdateSource(offer.releaseUrl, async () => ({ token: 'test', host: 'workspace' }), async (_url, init) => {
      expect(new Headers(init?.headers).has('Range')).toBe(false);
      return new Response(bytes);
    });
    const done = settle(recovered);
    recovered.start(offer, source);
    await done;
    expect(await readFile(recovered.zip)).toEqual(bytes);
    expect(await recovered.staged(offer.current)).toMatchObject({ latest: offer.latest });
    expect(await new UpdateDownload(root).staged(offer.current)).toMatchObject({ latest: offer.latest });
    await writeFile(join(root, 'update-journal.json'), JSON.stringify({ id: 'retry-rollback', step: 'rolled-back', done: true, target: offer.current }));
    expect(await recovered.staged(offer.current)).toBeNull();
    expect(recovered.status.failedApply?.id).not.toBe(event?.id);
    expect(recovered.status.failedApply).toMatchObject({ version: offer.latest, sha256: offer.sha256 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
it.each([false, true])('reconciles changed manifests against durable staging, ready=%s', async (ready) => {
  for (const result of [
    { unavailable: 'no-release' },
    { ...offer, latest: '1.3.5' },
    { ...offer, sha256: 'b'.repeat(64) },
    { ...offer, assetSize: bytes.length + 1 },
  ] satisfies UpdateCheckResult[]) {
    const root = await mkdtemp(join(tmpdir(), 'update-reconcile-'));
    const download = new UpdateDownload(root);
    try {
      await mkdir(download.directory);
      await writeFile(download.zip, ready ? bytes : bytes.subarray(0, 5));
      await writeFile(join(download.directory, ready ? 'ready.json' : 'offer.json'), JSON.stringify(offer));
      await download.staged();
      download.checking();
      await download.checked(result);
      await expect(access(download.directory)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(download.status).toMatchObject({ state: 'unavailable' in result ? 'idle' : 'available', received: 0, error: null });
      expect(download.status).toMatchObject({ discardedDownload: { id: expect.any(String), version: offer.latest } });
      const notice = download.status.discardedDownload;
      await download.checked(result);
      expect(download.status.discardedDownload).toEqual(notice);
      expect(await new UpdateDownload(root).staged()).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
it('does not report a discarded download when no staged bytes existed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'update-no-staging-'));
  try {
    const download = new UpdateDownload(root);
    await download.checked({ unavailable: 'no-release' });
    expect(download.status).not.toHaveProperty('discardedDownload');
  } finally { await rm(root, { recursive: true, force: true }); }
});
it.each([false, true])('preserves an unchanged or unreachable offer, ready=%s', async (ready) => {
  const root = await mkdtemp(join(tmpdir(), 'update-preserve-'));
  const download = new UpdateDownload(root);
  try {
    await mkdir(download.directory);
    await writeFile(download.zip, ready ? bytes : bytes.subarray(0, 5));
    await writeFile(join(download.directory, ready ? 'ready.json' : 'offer.json'), JSON.stringify(offer));
    await download.staged();
    for (const result of [offer, { unavailable: 'unreachable' }, { unavailable: 'timeout' }] satisfies UpdateCheckResult[]) {
      download.checking();
      await download.checked(result);
      expect(await readFile(download.zip)).toEqual(ready ? bytes : bytes.subarray(0, 5));
      expect(download.status.received).toBe(ready ? bytes.length : 5);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
function settle(download: UpdateDownload): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { download.off('status', listener); reject(new Error('download deadline')); }, 5000);
    const listener = () => { if (['ready', 'failed'].includes(download.status.state)) { clearTimeout(timer); download.off('status', listener); resolve(); } };
    download.on('status', listener);
  });
}
it('resumes a partial ZIP with Range, reports progress and persists verified state without MOTW', async () => {
  const root = await mkdtemp(join(tmpdir(), 'update-download-'));
  const download = new UpdateDownload(root);
  const seen: string[] = [];
  const server = createServer((req, res) => {
    expect(req.headers.authorization).toBe('Bearer test');
    seen.push(req.headers.range ?? '');
    const offset = Number(req.headers.range?.match(/\d+/)?.[0] ?? 0);
    res.statusCode = offset ? 206 : 200;
    if (offset) res.setHeader('content-range', `bytes ${offset}-${bytes.length - 1}/${bytes.length}`);
    res.setHeader('content-length', bytes.length - offset);
    res.end(bytes.subarray(offset));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await mkdir(download.directory);
    await writeFile(join(download.directory, 'offer.json'), JSON.stringify(offer));
    await writeFile(download.zip, bytes.subarray(0, 5));
    const states: string[] = [];
    download.on('status', () => states.push(download.status.state));
    const done = settle(download);
    download.start(offer, new DatabricksUpdateSource(`http://127.0.0.1:${(server.address() as { port: number }).port}`, async () => ({ token: 'test', host: 'workspace' })));
    await done;
    expect(download.status).toMatchObject({ state: 'ready', received: bytes.length });
    expect(states).toContain('verifying');
    expect(seen).toEqual(['bytes=5-']);
    expect(await readFile(download.zip)).toEqual(bytes);
    if (process.platform === 'win32') await expect(readFile(`${download.zip}:Zone.Identifier`)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await new UpdateDownload(root).staged()).toMatchObject({ latest: '1.3.4' });
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
it.each(['checksum-mismatch', 'size-mismatch'])('fails closed for %s and can restart', async (reason) => {
  const root = await mkdtemp(join(tmpdir(), 'update-download-'));
  const download = new UpdateDownload(root);
  try {
    const bad = reason === 'checksum-mismatch' ? { ...offer, sha256: 'a'.repeat(64) } : { ...offer, assetSize: bytes.length + 1 };
    let done = settle(download);
    download.start(bad, new DatabricksUpdateSource(offer.releaseUrl, async () => ({ token: 'test', host: 'workspace' }), async () => new Response(bytes)));
    await done;
    expect(download.status).toMatchObject({ state: 'failed', error: reason });
    await download.cancel();
    done = settle(download);
    download.start(offer, new DatabricksUpdateSource(offer.releaseUrl, async () => ({ token: 'test', host: 'workspace' }), async () => new Response(bytes)));
    await done;
    expect(download.status.state).toBe('ready');
  } finally { await download.cancel(); await rm(root, { recursive: true, force: true }); }
});

it('cancels an active stream and restarts cleanly when the server ignores Range', async () => {
  const root = await mkdtemp(join(tmpdir(), 'update-cancel-'));
  const download = new UpdateDownload(root);
  let firstResponse: import('node:http').ServerResponse | undefined;
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.range ?? '');
    res.setHeader('Content-Length', bytes.length);
    if (seen.length === 2) res.end(bytes);
    else { firstResponse = res; res.write(bytes.subarray(0, 5)); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const source = new DatabricksUpdateSource(`http://127.0.0.1:${(server.address() as { port: number }).port}`, async () => ({ token: 'test', host: 'workspace' }));
  try {
    const progress = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { download.off('status', listener); reject(new Error('progress deadline')); }, 5000);
      const listener = () => { if (download.status.received === 5) { clearTimeout(timer); download.off('status', listener); resolve(); } };
      download.on('status', listener);
    });
    download.start(offer, source);
    await progress;
    await download.cancel();
    firstResponse?.destroy();
    expect(download.status.state).toBe('idle');
    const done = settle(download);
    download.start(offer, source);
    await done;
    expect(download.status.state).toBe('ready');
    expect(await readFile(download.zip)).toEqual(bytes);
    expect(seen).toHaveLength(2);
  } finally {
    await download.cancel();
    firstResponse?.destroy();
    const closed = new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); await closed;
    await rm(root, { recursive: true, force: true });
  }
});

it.each([false, true])('renews truncated responses without another click or progress reset, Range ignored=%s', async (ignoreRange) => {
  const root = await mkdtemp(join(tmpdir(), 'update-cutoff-'));
  const download = new UpdateDownload(root);
  const payload = Buffer.alloc(2 * 1024 * 1024, 42);
  const release = { ...offer, assetSize: payload.length, sha256: createHash('sha256').update(payload).digest('hex') };
  const offsets: number[] = [];
  const progress: number[] = [];
  const source = new DatabricksUpdateSource(offer.releaseUrl, async () => ({ token: 'test', host: 'workspace' }), async (_url, init) => {
    const offset = Number(new Headers(init?.headers).get('Range')?.match(/\d+/)?.[0] ?? 0);
    offsets.push(offset);
    let position = ignoreRange ? 0 : offset;
    const cutoff = Math.min(position + 512 * 1024, payload.length);
    return new Response(new ReadableStream({
      pull(controller) {
        if (position === payload.length) { controller.close(); return; }
        if (position === cutoff) { controller.error(new TypeError('terminated')); return; }
        const end = Math.min(position + 64 * 1024, cutoff);
        controller.enqueue(payload.subarray(position, end));
        position = end;
      },
    }), { status: offset && !ignoreRange ? 206 : 200, headers: {
      'Content-Length': String(payload.length - (ignoreRange ? 0 : offset)),
      ...(offset && !ignoreRange ? { 'Content-Range': `bytes ${offset}-${payload.length - 1}/${payload.length}` } : {}),
    } });
  });
  download.on('status', () => progress.push(download.status.received));
  try {
    const done = settle(download);
    download.start(release, source);
    await done;
    expect(progress.every((value, index) => index === 0 || value >= progress[index - 1]!)).toBe(true);
    if (ignoreRange) {
      expect(download.status).toMatchObject({ state: 'failed', error: 'download-failed' });
      expect(offsets.length).toBeGreaterThanOrEqual(2);
      expect(offsets.length).toBeLessThanOrEqual(10);
      return;
    }
    expect(download.status).toMatchObject({ state: 'ready', received: payload.length, error: null });
    expect(offsets.length).toBeGreaterThan(3);
    expect(offsets[0]).toBe(0);
    expect(offsets.slice(1).every((offset, index) => offset > offsets[index]!)).toBe(true);
    expect(await readFile(download.zip)).toEqual(payload);
    expect(await new UpdateDownload(root).staged()).toMatchObject({ sha256: release.sha256 });
  } finally { await download.cancel(); await rm(root, { recursive: true, force: true }); }
});

it('fails a truncated response that makes no durable progress instead of spinning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'update-no-progress-'));
  const download = new UpdateDownload(root);
  let requests = 0;
  const source = new DatabricksUpdateSource(offer.releaseUrl, async () => ({ token: 'test', host: 'workspace' }), async () => {
    requests++;
    return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('terminated')); } }));
  });
  try {
    const done = settle(download);
    download.start(offer, source);
    await done;
    expect(download.status).toMatchObject({ state: 'failed', error: 'download-failed' });
    expect(requests).toBe(1);
  } finally { await download.cancel(); await rm(root, { recursive: true, force: true }); }
});

it('recovers ready version and source without another manifest check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'update-recovery-'));
  const download = new UpdateDownload(root);
  try {
    await mkdir(download.directory);
    await writeFile(download.zip, bytes);
    await writeFile(join(download.directory, 'ready.json'), JSON.stringify(offer));
    await download.staged();
    expect(download.status).toMatchObject({ state: 'ready', version: offer.latest, releaseUrl: offer.releaseUrl });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(['1.3.4', '1.3.5'])('cleans an applied staged offer at running version %s', async (current) => {
  const root = await mkdtemp(join(tmpdir(), 'update-applied-'));
  const download = new UpdateDownload(root);
  try {
    await mkdir(download.directory);
    await writeFile(download.zip, bytes);
    await writeFile(join(download.directory, 'ready.json'), JSON.stringify(offer));
    await writeFile(join(download.directory, 'offer.json'), JSON.stringify(offer));
    expect(await download.staged(current)).toBeNull();
    expect(download.status).toMatchObject({ state: 'idle', version: null, received: 0 });
    await expect(access(download.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('recovers partial bytes and never publishes zero on resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'update-partial-'));
  const download = new UpdateDownload(root);
  try {
    await mkdir(download.directory);
    await writeFile(download.zip, bytes.subarray(0, 5));
    await writeFile(join(download.directory, 'offer.json'), JSON.stringify(offer));
    await download.staged('1.3.3');
    expect(download.status).toMatchObject({ state: 'idle', received: 5, total: bytes.length, version: offer.latest });
    const progress: number[] = [];
    download.on('status', () => progress.push(download.status.received));
    const done = settle(download);
    download.start(offer, new DatabricksUpdateSource(offer.releaseUrl, async () => ({ token: 'test', host: 'workspace' }), async () => new Response(bytes.subarray(5), { status: 206, headers: { 'content-range': `bytes 5-${bytes.length - 1}/${bytes.length}` } })));
    await done;
    expect(progress.length).toBeGreaterThan(0);
    expect(Math.min(...progress)).toBe(5);
  } finally { await download.cancel(); await rm(root, { recursive: true, force: true }); }
});

it('removes foreign bytes before persisting a replacement offer and opening its request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'update-identity-'));
  const download = new UpdateDownload(root);
  try {
    await mkdir(download.directory);
    await writeFile(download.zip, 'foreign prefix');
    await writeFile(join(download.directory, 'offer.json'), JSON.stringify({ ...offer, latest: '1.3.2' }));
    let oldBytesRemain = false;
    const source = new DatabricksUpdateSource(offer.releaseUrl, async () => ({ token: 'test', host: 'workspace' }), async () => {
      oldBytesRemain = await readFile(download.zip).then((value) => value.length > 0, () => false);
      expect(JSON.parse(await readFile(join(download.directory, 'offer.json'), 'utf8')).latest).toBe(offer.latest);
      return new Response(bytes);
    });
    const done = settle(download);
    download.start(offer, source);
    await done;
    expect(oldBytesRemain).toBe(false);
    expect(download.status.state).toBe('ready');
  } finally { await download.cancel(); await rm(root, { recursive: true, force: true }); }
});
