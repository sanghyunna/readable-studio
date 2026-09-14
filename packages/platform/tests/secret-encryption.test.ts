import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { requestSecretEncryption, secretEncryptionPipe, serveSecretEncryption, type SecretEncryption } from '../src/secret-encryption.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(available = true) {
  const root = await mkdtemp(join(tmpdir(), 'secret-encryption-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const key = randomBytes(32);
  // Actual authenticated encryption stands in for DPAPI; no Electron process is launched.
  const encryption: SecretEncryption = {
    isEncryptionAvailable: () => available,
    encryptString(value) {
      const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value) {
      const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
  const host = await serveSecretEncryption(root, encryption);
  cleanup.push(() => host.close());
  return { root, encryption };
}

it('round-trips only ciphertext over the encrypt response through a real Windows pipe', async () => {
  const { root } = await fixture();
  const token = 'dapi_PIPE_PRIVATE_TOKEN';
  const payload = await requestSecretEncryption(root, 'encrypt', token);
  expect(Buffer.from(payload, 'base64').includes(Buffer.from(token))).toBe(false);
  expect(await requestSecretEncryption(root, 'decrypt', payload)).toBe(token);
  expect(secretEncryptionPipe(root.toUpperCase())).toBe(secretEncryptionPipe(root));
});

it('serves a separate Node process, not an in-process substitute for IPC', async () => {
  const { root } = await fixture();
  const script = `import { requestSecretEncryption } from '@readable-studio/platform';
    const encrypted = await requestSecretEncryption(process.argv[1], 'encrypt', 'private-child-token');
    const decrypted = await requestSecretEncryption(process.argv[1], 'decrypt', encrypted);
    if (decrypted !== 'private-child-token') process.exit(1);
    process.stdout.write('recovered');`;
  const child = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script, root], { timeout: 10_000, windowsHide: true });
  expect(child.stdout).toBe('recovered');
  expect(child.stderr).toBe('');
});

it('reports unavailable encryption without invoking encrypt or decrypt', async () => {
  const { root, encryption } = await fixture(false);
  const encrypt = vi.spyOn(encryption, 'encryptString');
  const decrypt = vi.spyOn(encryption, 'decryptString');
  await expect(requestSecretEncryption(root, 'encrypt', 'private')).rejects.toThrow('OS secret encryption unavailable');
  await expect(requestSecretEncryption(root, 'decrypt', 'invalid')).rejects.toThrow('OS secret encryption unavailable');
  expect(encrypt).not.toHaveBeenCalled(); expect(decrypt).not.toHaveBeenCalled();
});

it('sanitizes decryption failures and absent hosts', async () => {
  const { root, encryption } = await fixture();
  vi.spyOn(encryption, 'decryptString').mockImplementation(() => { throw new Error('secret-bearing-native-error'); });
  await expect(requestSecretEncryption(root, 'decrypt', 'invalid')).rejects.toThrow('OS secret encryption unavailable');
  await expect(requestSecretEncryption(`${root}-absent`, 'encrypt', 'private')).rejects.toThrow('OS secret encryption unavailable');
});
