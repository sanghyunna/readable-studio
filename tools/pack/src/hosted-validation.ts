import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveHostedValidationCommands(
  manifest: Record<string, unknown>,
  boundary: string,
): string[] {
  if (!/^pr\d{2}$/u.test(boundary)) throw new Error('hosted validation boundary is invalid');
  const commands: string[] = [];
  const active = new Set<string>();
  const visit = (name: string): void => {
    if (active.has(name)) throw new Error(`hosted validation boundary cycle: ${name}`);
    const entries = manifest[name];
    if (
      !Array.isArray(entries)
      || entries.length === 0
      || !entries.every((value) => typeof value === 'string')
    ) throw new Error(`hosted validation boundary is missing: ${name}`);
    active.add(name);
    for (const entry of entries) {
      if (/^@pr\d{2}$/u.test(entry)) visit(entry.slice(1));
      else commands.push(entry);
    }
    active.delete(name);
  };
  visit(boundary);
  const unique = new Map<string, true>();
  for (const command of commands) {
    unique.delete(command);
    unique.set(command, true);
  }
  return [...unique.keys()];
}

function main(): void {
  const boundary = process.argv[2];
  if (boundary == null) throw new Error('usage: hosted-validation.ts <prNN>');
  const manifest = JSON.parse(
    readFileSync(new URL('../../../.github/hosted-validation.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
  for (const command of resolveHostedValidationCommands(manifest, boundary)) {
    const result = spawnSync(command, { shell: true, stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

if (process.argv[1] != null && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
