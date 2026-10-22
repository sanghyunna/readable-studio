import { expect, test } from 'vitest';
import { signDesktopImportToken, verifyDesktopImportToken } from '../src/desktop-auth.js';

test('accepts a fifteen-minute folder token without relaxing binding, replay or expiry checks', () => {
  const secret = Buffer.alloc(32, 7);
  const now = Date.now();
  const exp = new Date(now + 15 * 60_000).toISOString();
  const token = signDesktopImportToken(secret, 'D:\\project', { nonce: 'slow-import', exp });
  const consumed = new Map<string, number>();
  expect(verifyDesktopImportToken(secret, 'D:\\project', token, now + 5 * 60_000, consumed).ok).toBe(true);
  expect(verifyDesktopImportToken(secret, 'D:\\other', token, now, consumed).ok).toBe(false);
  expect(verifyDesktopImportToken(secret, 'D:\\project', token, now + 15 * 60_000, consumed).ok).toBe(false);
  consumed.set('slow-import', Date.parse(exp));
  expect(verifyDesktopImportToken(secret, 'D:\\project', token, now, consumed).ok).toBe(false);
  const excessive = signDesktopImportToken(secret, 'D:\\project', { nonce: 'future', exp: new Date(now + 31 * 60_000).toISOString() });
  expect(verifyDesktopImportToken(secret, 'D:\\project', excessive, now, new Map()).ok).toBe(false);
});
