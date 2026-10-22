import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('node:net', async original => ({ ...await original<typeof import('node:net')>(), createConnection: connect }));
import { requestSecretEncryption } from '../src/secret-encryption.js';

const originalPlatform = process.platform;
afterEach(() => {
  vi.useRealTimers(); connect.mockReset();
  Object.defineProperty(process, 'platform', { value: originalPlatform });
});
it('waits for the encryption host when its event loop is busy beyond five seconds', async () => {
  vi.useFakeTimers(); Object.defineProperty(process, 'platform', { value: 'win32' });
  let idle: ReturnType<typeof setTimeout>;
  const socket = Object.assign(new EventEmitter(), {
    setEncoding: vi.fn(), write: vi.fn(),
    setTimeout(ms: number, expired: () => void) { idle = setTimeout(expired, ms); },
    destroy: vi.fn(() => { clearTimeout(idle); socket.emit('close'); }),
  });
  connect.mockReturnValue(socket);
  const result = requestSecretEncryption('C:\\test-data', 'encrypt', 'private').then(value => ({ value }), error => ({ error }));
  socket.emit('connect');
  await vi.advanceTimersByTimeAsync(31_000);
  expect(socket.destroy).not.toHaveBeenCalled();
  socket.emit('data', '{"ok":true,"value":"ciphertext"}\n');
  expect(await result).toEqual({ value: 'ciphertext' });
  expect(vi.getTimerCount()).toBe(0);
});
