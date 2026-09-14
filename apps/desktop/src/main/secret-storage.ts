import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { safeStorage } from 'electron';
import { serveSecretEncryption } from '@readable-studio/platform';

/** tools-dev launches desktop and daemon from the workspace root with the same env. */
export function desktopCredentialDataRoot(env: NodeJS.ProcessEnv = process.env, projectRoot = process.cwd()): string {
  const raw = env.READABLE_DATA_DIR?.trim() || '.readable-studio';
  const expanded = raw.replace(/^(?:~|\$HOME|\$\{HOME\})(?=$|[/\\])/, () => homedir());
  return resolve(projectRoot, expanded);
}

/** Called after app.whenReady by BOTH desktop and packaged (via runDesktopMain). */
export async function startDesktopSecretStorage(dataRoot: string): Promise<{ close(): Promise<void> } | null> {
  if (process.platform !== 'win32') return null;
  try {
    // Windows safeStorage uses DPAPI, bound to the signed-in Windows account.
    // No provider, file path, or decrypted secret is exposed to preload/renderer IPC.
    return await serveSecretEncryption(dataRoot, safeStorage);
  } catch {
    console.warn('Credential encryption host unavailable: workspace tokens are memory-only and must be re-entered after restart.');
    return null;
  }
}
