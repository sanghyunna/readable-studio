import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { compareUpdateVersions, type UpdateCheckAvailable, type UpdateCheckResult, type UpdateStatus } from '@readable-studio/contracts';
import { DatabricksUpdateSource, UpdateSourceError } from './update-source.js';

/** Node creates ordinary NTFS data streams; ZIP extraction rejects colon/ADS paths. */
export class UpdateDownload extends EventEmitter {
  readonly directory: string;
  readonly zip: string;
  status: UpdateStatus = { state: 'idle', received: 0, total: 0, version: null, error: null };
  private controller: AbortController | undefined;
  private running: Promise<void> | undefined;
  private rollbackJournal?: string;
  private rollbackInvalidationPending = false;
  generation = 0;
  constructor(root: string) {
    super();
    this.directory = join(root, '.update-download');
    this.zip = join(this.directory, 'update.zip');
  }
  private publish(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.status);
  }
  checking(): void {
    if (['idle', 'available', 'failed'].includes(this.status.state)) this.publish({ state: 'checking', error: null });
  }
  extracting(extraction: UpdateStatus['extraction']): void {
    this.publish({ extraction, ...(extraction ? { error: null } : {}) });
  }
  applyFailed(error: string): void {
    // Keep verified bytes retryable, but make termination visible to every SSE/status consumer.
    this.publish({ extraction: undefined, error });
  }
  async checked(result: UpdateCheckResult): Promise<void> {
    await this.staged('current' in result ? result.current : undefined);
    if ('isNewer' in result && !result.isNewer) {
      // A manifest at or below the running version is not an offer, even without staged files.
      await this.invalidate();
      return;
    }
    const generation = this.generation;
    let saved: UpdateCheckAvailable | undefined;
    try { saved = JSON.parse(await readFile(join(this.directory, 'offer.json'), 'utf8')) as UpdateCheckAvailable; }
    catch {
      try { saved = JSON.parse(await readFile(join(this.directory, 'ready.json'), 'utf8')) as UpdateCheckAvailable; }
      catch { /* No durable offer to reconcile. */ }
    }
    const received = saved ? await stat(this.zip).then((file) => file.size, () => 0) : 0;
    if (generation !== this.generation) return;
    const discard = async () => {
      await this.invalidate();
      if (saved && received > 0) this.publish({ discardedDownload: { id: randomUUID(), version: saved.latest } });
    };
    if ('unavailable' in result) {
      if (result.unavailable === 'no-release') { await discard(); return; }
      if (saved) {
        if (this.status.state === 'checking') await this.staged();
        return;
      }
    } else if (saved && (saved.latest !== result.latest || saved.sha256 !== result.sha256 || saved.assetSize !== result.assetSize || saved.releaseUrl !== result.releaseUrl)) {
      await discard();
    } else if (saved && this.status.state !== 'checking') return;
    if (['downloading', 'verifying', 'ready'].includes(this.status.state)) return;
    if ('unavailable' in result) this.publish({ state: result.unavailable === 'disabled' ? 'idle' : 'failed', error: result.unavailable, ...(result.host ? { host: result.host } : {}) });
    else if (result.isNewer && this.status.failedApply?.version === result.latest && this.status.failedApply.sha256 === result.sha256) {
      this.publish({ state: 'failed', version: null, received: 0, total: 0, error: 'apply-rolled-back' });
    } else this.publish({ state: result.isNewer ? 'available' : 'idle', version: result.latest, total: result.assetSize, received: this.status.version === result.latest && this.status.releaseUrl === result.releaseUrl ? this.status.received : 0, error: null, host: undefined, releaseUrl: result.releaseUrl, notes: result.notes });
  }
  async staged(current?: string): Promise<UpdateCheckAvailable | null> {
    if (this.running) return null;
    const failurePath = join(this.directory, '..', '.update-failed-apply.json');
    if (!this.rollbackJournal) {
      try {
        const saved = JSON.parse(await readFile(failurePath, 'utf8')) as { journal: string; event: NonNullable<UpdateStatus['failedApply']>; invalidationPending?: boolean };
        this.rollbackJournal = saved.journal;
        this.rollbackInvalidationPending = saved.invalidationPending !== false;
        this.publish({ failedApply: saved.event });
        if (!this.status.version) this.publish({ state: 'failed', error: 'apply-rolled-back' });
      } catch { /* No previous failed apply. */ }
    }
    if (this.rollbackInvalidationPending) {
      try { await this.finishRollbackInvalidation(failurePath); }
      catch { return null; } // Keep the durable pending state and never publish the failed bytes.
    }
    const failedPrecedence = current && this.status.failedApply ? compareUpdateVersions(this.status.failedApply.version, current) : null;
    if (failedPrecedence === 0 || failedPrecedence === -1) {
      // The running payload proves the failed release has since been installed or superseded.
      await rm(failurePath, { force: true });
      delete this.status.failedApply;
      if (this.status.error === 'apply-rolled-back') this.publish({ state: 'idle', error: null });
      else this.publish({});
    }
    const generation = this.generation;
    let offer: UpdateCheckAvailable;
    let ready = true;
    try {
      try { offer = JSON.parse(await readFile(join(this.directory, 'ready.json'), 'utf8')) as UpdateCheckAvailable; }
      catch { ready = false; offer = JSON.parse(await readFile(join(this.directory, 'offer.json'), 'utf8')) as UpdateCheckAvailable; }
      if (ready) {
        let rollback: string | undefined;
        try {
          const path = join(this.directory, '..', 'update-journal.json');
          const raw = await readFile(path, 'utf8');
          const journal = JSON.parse(raw) as { id?: string; step?: string; done?: boolean; target?: string };
          const identity = journal.id ?? createHash('sha256').update(raw).digest('hex');
          if (journal.step === 'rolled-back' && journal.done === true && journal.target === (current ?? offer.current)
            && identity !== this.rollbackJournal && (await stat(path)).mtimeMs >= (await stat(join(this.directory, 'ready.json'))).mtimeMs) rollback = identity;
        } catch { /* An absent or incomplete journal is not proof of rollback. */ }
        if (rollback) {
          const event = { id: randomUUID(), version: offer.latest, sha256: offer.sha256, releaseUrl: offer.releaseUrl };
          // A consumed identity is not proof that removal completed.
          await writeFile(failurePath, JSON.stringify({ journal: rollback, event, invalidationPending: true }));
          this.rollbackJournal = rollback;
          this.rollbackInvalidationPending = true;
          this.publish({ failedApply: event });
          await this.finishRollbackInvalidation(failurePath);
          delete this.status.discardedDownload;
          this.publish({ state: 'failed', error: 'apply-rolled-back', failedApply: event });
          return null;
        }
      }
      if (current && compareUpdateVersions(offer.latest, current) !== 1) {
        await this.invalidate();
        return null;
      }
      if (!ready) {
        const received = await stat(this.zip).then(file => file.size, () => 0);
        let failure: { offer: UpdateCheckAvailable; error: string; host?: string } | undefined;
        try { failure = JSON.parse(await readFile(join(this.directory, 'failure.json'), 'utf8')) as typeof failure; }
        catch { /* A cancelled or interrupted download has no failure record. */ }
        const failed = failure?.offer.latest === offer.latest && failure.offer.sha256 === offer.sha256
          && failure.offer.assetSize === offer.assetSize && failure.offer.releaseUrl === offer.releaseUrl;
        if ((received > 0 || failed) && received <= offer.assetSize && generation === this.generation && !this.running) {
          this.publish({ state: failed ? 'failed' : 'idle', version: offer.latest, received, total: offer.assetSize,
            error: failed ? failure!.error : null, host: failed ? failure!.host : undefined, releaseUrl: offer.releaseUrl, notes: offer.notes });
        }
        return null;
      }
      if (!await this.verify(offer) || generation !== this.generation || this.running) return null;
      // Recovery/checking is not a new apply attempt. Retain its failure while
      // these verified bytes remain staged; extraction or invalidation clears it.
      const error = this.status.state === 'ready' && this.status.version === offer.latest && this.status.releaseUrl === offer.releaseUrl ? this.status.error : null;
      this.publish({ state: 'ready', version: offer.latest, received: offer.assetSize, total: offer.assetSize, error, host: undefined, releaseUrl: offer.releaseUrl, notes: offer.notes });
      return offer;
    } catch { return null; }
  }
  private async finishRollbackInvalidation(failurePath: string): Promise<void> {
    await this.invalidate();
    await writeFile(failurePath, JSON.stringify({ journal: this.rollbackJournal, event: this.status.failedApply, invalidationPending: false }));
    this.rollbackInvalidationPending = false;
    this.publish({ state: 'failed', error: 'apply-rolled-back' });
  }
  private async verify(offer: UpdateCheckAvailable): Promise<boolean> {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(this.zip)) { hash.update(chunk); size += (chunk as Buffer).length; }
    return size === offer.assetSize && hash.digest('hex') === offer.sha256;
  }
  start(offer: UpdateCheckAvailable, source: DatabricksUpdateSource): void {
    if (this.running) return;
    this.controller = new AbortController();
    this.running = this.download(offer, source, this.controller.signal).finally(() => { this.running = undefined; this.controller = undefined; });
    this.publish({ state: 'downloading', error: null, host: undefined, version: offer.latest, total: offer.assetSize,
      received: this.status.version === offer.latest && this.status.releaseUrl === offer.releaseUrl ? this.status.received : 0,
      releaseUrl: offer.releaseUrl, notes: offer.notes });
  }
  async cancel(): Promise<void> {
    if (this.status.state === 'ready') { await this.invalidate(); return; }
    await this.stop();
  }
  private async stop(): Promise<void> {
    this.generation++;
    this.controller?.abort();
    await this.running;
    await rm(join(this.directory, 'failure.json'), { force: true });
    if (this.status.version) {
      const received = await stat(this.zip).then((file) => file.size, () => 0);
      this.publish({ received });
    }
    this.publish({ state: 'idle', error: null });
  }
  async invalidate(): Promise<void> {
    await this.stop();
    await rm(this.directory, { recursive: true, force: true });
    this.publish({ version: null, releaseUrl: undefined, host: undefined, notes: undefined, received: 0, total: 0 });
  }
  private async download(offer: UpdateCheckAvailable, source: DatabricksUpdateSource, signal: AbortSignal): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true });
      let offset = 0;
      try {
        const saved = JSON.parse(await readFile(join(this.directory, 'offer.json'), 'utf8')) as UpdateCheckAvailable;
        if (saved.latest === offer.latest && saved.sha256 === offer.sha256 && saved.assetSize === offer.assetSize && saved.releaseUrl === offer.releaseUrl) offset = (await stat(this.zip)).size;
      } catch { /* A new offer starts a new file. */ }
      if (offset >= offer.assetSize) offset = 0;
      await rm(join(this.directory, 'ready.json'), { force: true });
      await rm(join(this.directory, 'failure.json'), { force: true });
      // Remove foreign bytes before the metadata can identify them as this offer.
      if (!offset) await rm(this.zip, { force: true });
      await writeFile(join(this.directory, 'offer.json'), JSON.stringify(offer));
      let received = offset;
      if (signal.aborted) return;
      this.publish({ state: 'downloading', received, total: offer.assetSize, version: offer.latest, error: null, host: undefined, releaseUrl: offer.releaseUrl, notes: offer.notes });
      while (offset < offer.assetSize) {
        const previousOffset = offset;
        const response = await source.request(`download/${encodeURIComponent(offer.latest)}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]),
          headers: offset ? { Range: `bytes=${offset}-` } : {} });
        if (!response.body) throw new UpdateSourceError('invalid-response');
        if (offset && response.status === 206) {
          const range = response.headers.get('content-range');
          if (!range?.startsWith(`bytes ${offset}-`)) { await response.body.cancel(); throw new UpdateSourceError('invalid-response'); }
        } else offset = 0;
        received = offset;
        try {
          await pipeline(Readable.fromWeb(response.body as never), new Transform({
            transform: (chunk: Buffer, _encoding, callback) => {
              received += chunk.length;
              this.publish({ received: Math.max(this.status.received, received) });
              callback(received > offer.assetSize ? new Error('size-mismatch') : null, chunk);
            },
          }), createWriteStream(this.zip, { flags: offset ? 'a' : 'w' }), { signal });
          break;
        } catch (error) {
          if (signal.aborted || (error instanceof Error && (error.message === 'size-mismatch' || 'code' in error && ['ENOSPC', 'EACCES', 'EPERM', 'EIO'].includes(String(error.code))))) throw error;
          // Apps can close a live response after roughly five minutes. Resume from
          // flushed bytes, not Transform progress (which can be ahead of the file).
          const persisted = (await stat(this.zip)).size;
          if (persisted <= previousOffset || persisted > offer.assetSize) throw error;
          offset = received = persisted;
        }
      }
      this.publish({ state: 'verifying' });
      if (received !== offer.assetSize) throw new Error('size-mismatch');
      if (!await this.verify(offer)) { await rm(this.zip, { force: true }); throw new Error('checksum-mismatch'); }
      await writeFile(join(this.directory, 'ready.json'), JSON.stringify(offer));
      this.publish({ state: 'ready', error: null });
    } catch (error) {
      if (signal.aborted) return;
      const reason = error instanceof UpdateSourceError ? error.reason
        : error instanceof Error && 'code' in error && ['ENOSPC', 'EACCES', 'EPERM', 'EIO'].includes(String(error.code)) ? 'disk-extract-failed'
        : error instanceof Error && ['checksum-mismatch', 'size-mismatch'].includes(error.message) ? error.message : 'download-failed';
      if (reason === 'size-mismatch') await rm(this.zip, { force: true });
      try {
      try {
        await writeFile(join(this.directory, 'failure.json'), JSON.stringify({ offer, error: reason,
          ...(error instanceof UpdateSourceError && error.host ? { host: error.host } : {}) }));
      } catch { /* A full or unwritable disk must still publish the original failure. */ }
      } catch { /* A full or unwritable disk must still publish the original failure. */ }
      this.publish({ state: 'failed', error: reason, ...(error instanceof UpdateSourceError && error.host ? { host: error.host } : {}) });
    }
  }
}
const downloads = new Map<string, UpdateDownload>();
export function updateDownload(root: string): UpdateDownload {
  let download = downloads.get(root);
  if (!download) { download = new UpdateDownload(root); downloads.set(root, download); }
  return download;
}
export async function invalidateUpdateSource(serverUrl: string | null): Promise<void> {
  await Promise.all([...downloads.values()].filter((download) => download.status.releaseUrl !== serverUrl).map((download) => download.invalidate()));
}
