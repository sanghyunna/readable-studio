import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabricksRuntimeError } from '../databricks/failure.js';

/** Only daemon-owned local asset paths cross the public error boundary. */
export class PiShellAssetError extends DatabricksRuntimeError {
  constructor(readonly paths: readonly string[]) {
    super('runtime-unavailable');
    this.name = 'PiShellAssetError';
    this.detail.message += ` Missing Pi PowerShell runtime asset. Checked: ${paths.join('; ')}`;
    this.message = this.detail.message;
  }
}

/** Prebundles stage both files beside daemon chunks; source/tsc keep them in runtimes. */
export function resolvePiShellExtension(moduleUrl: string): string {
  const candidates = ['.js', '.ts'].map(suffix => ({
    extension: fileURLToPath(new URL(`./pi-powershell-extension${suffix}`, moduleUrl)),
    resolver: fileURLToPath(new URL(`./pi-powershell${suffix}`, moduleUrl)),
  }));
  const selected = candidates.find(candidate => existsSync(candidate.extension));
  if (!selected) throw new PiShellAssetError(candidates.map(candidate => candidate.extension));
  if (!existsSync(selected.resolver)) throw new PiShellAssetError([selected.resolver]);
  return selected.extension;
}
