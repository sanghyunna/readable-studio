import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isPortableAppLayout, resolvePortableTopFolder } from './config.js';

/** A receipt is written only after daemon/web and the desktop readiness callback succeed. */
export async function writeUpdateReadyReceipt(version: string | null, env: NodeJS.ProcessEnv = process.env, exePath = process.execPath, pid = process.pid): Promise<void> {
  const id = env.READABLE_UPDATE_TRANSACTION;
  const target = env.READABLE_UPDATE_TARGET;
  if (!id && !target) return;
  if (!id || !target || version !== target) throw new Error('Update startup version does not match launcher transaction');
  // Only the launcher stub of the app\ layout consumes this receipt; a legacy
  // flat extraction has no launcher, so there is nothing to confirm to.
  if (!isPortableAppLayout(exePath)) {
    console.warn('Update transaction env present outside the launcher layout; receipt not written');
    return;
  }
  const root = resolvePortableTopFolder(exePath);
  const temp = join(root, `update-ready.${pid}.tmp`);
  await writeFile(temp, JSON.stringify({ id, version, pid }), 'utf8');
  await rename(temp, join(root, 'update-ready.json'));
}
