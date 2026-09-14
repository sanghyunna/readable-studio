import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { requestSecretEncryption } from '@readable-studio/platform';

const safeStorage = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((_value: string) => Buffer.from('os-ciphertext')),
  decryptString: vi.fn((_value: Buffer) => 'private-token'),
}));
vi.mock('electron', () => ({ safeStorage }));
import { desktopCredentialDataRoot, startDesktopSecretStorage } from '../src/main/secret-storage.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.clearAllMocks();
  safeStorage.isEncryptionAvailable.mockReturnValue(true);
});
async function start() {
  const root = await mkdtemp(join(tmpdir(), 'desktop-secrets-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const host = await startDesktopSecretStorage(root);
  expect(host).not.toBeNull();
  cleanup.push(() => host!.close());
  return root;
}

it('provides main-process safeStorage over the daemon pipe, without renderer IPC', async () => {
  const root = await start();
  const encrypted = await requestSecretEncryption(root, 'encrypt', 'private-token');
  expect(safeStorage.encryptString).toHaveBeenCalledWith('private-token');
  expect(Buffer.from(encrypted, 'base64')).toEqual(Buffer.from('os-ciphertext'));
  expect(await requestSecretEncryption(root, 'decrypt', encrypted)).toBe('private-token');
  expect(safeStorage.decryptString).toHaveBeenCalledWith(Buffer.from('os-ciphertext'));
});

it('never calls safeStorage encryption when the OS reports it unavailable', async () => {
  safeStorage.isEncryptionAvailable.mockReturnValue(false);
  const root = await start();
  await expect(requestSecretEncryption(root, 'encrypt', 'private-token')).rejects.toThrow('OS secret encryption unavailable');
  expect(safeStorage.encryptString).not.toHaveBeenCalled();
});

it('resolves the same dev data-root overrides as the daemon', () => {
  const project = resolve('test-workspace');
  expect(desktopCredentialDataRoot({}, project)).toBe(join(project, '.readable-studio'));
  expect(desktopCredentialDataRoot({ READABLE_DATA_DIR: 'private-data' }, project)).toBe(join(project, 'private-data'));
  for (const prefix of ['~', '$HOME', '${HOME}']) {
    expect(desktopCredentialDataRoot({ READABLE_DATA_DIR: `${prefix}/private-data` }, project)).toBe(join(homedir(), 'private-data'));
  }
});
