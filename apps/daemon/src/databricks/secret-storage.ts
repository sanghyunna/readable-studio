import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requestSecretEncryption } from '@readable-studio/platform';
import { DatabricksServiceError } from './client.js';

export type SecretLoad = { state: 'loaded'; secret: string } | { state: 'missing' | 'unavailable' };

/** Daemon-owned, private credential persistence boundary. Never exposed through HTTP or the web. */
export interface ConnectionSecretStorage {
  store(reference: string, secret: string): Promise<'stored' | 'unavailable'>;
  load(reference: string): Promise<SecretLoad>;
  clear(reference: string): Promise<void>;
}

/** Only Electron-produced OS ciphertext reaches disk. clear needs no running encryption host. */
export class EncryptedConnectionSecretStorage implements ConnectionSecretStorage {
  private readonly root: string;
  constructor(private readonly dataRoot: string) { this.root = join(dataRoot, 'databricks', 'credentials'); }
  private path(reference: string): string {
    return join(this.root, `${createHash('sha256').update(reference).digest('hex')}.bin`);
  }

  async store(reference: string, secret: string): Promise<'stored' | 'unavailable'> {
    // Never restore a superseded token if replacement encryption/writing fails.
    await this.clear(reference);
    let ciphertext: Buffer;
    try { ciphertext = Buffer.from(await requestSecretEncryption(this.dataRoot, 'encrypt', secret), 'base64'); }
    catch { return 'unavailable'; }
    const destination = this.path(reference);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.root, { recursive: true });
      await writeFile(temporary, ciphertext, { flag: 'wx', mode: 0o600 });
      await rename(temporary, destination);
      return 'stored';
    } catch {
      // Failure is surfaced as memory-only; never use a plaintext fallback.
      await rm(temporary, { force: true });
      return 'unavailable';
    }
  }

  async load(reference: string): Promise<SecretLoad> {
    let ciphertext: Buffer;
    try { ciphertext = await readFile(this.path(reference)); }
    catch (error) { return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable' }; }
    try { return { state: 'loaded', secret: await requestSecretEncryption(this.dataRoot, 'decrypt', ciphertext.toString('base64')) }; }
    catch { return { state: 'unavailable' }; }
  }

  async clear(reference: string): Promise<void> {
    try { await rm(this.path(reference), { force: true }); }
    catch { throw new DatabricksServiceError('DATABRICKS_KEYRING_UNAVAILABLE', true); }
  }
}
