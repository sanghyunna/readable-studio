import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const daemonRoot = fileURLToPath(new URL('../', import.meta.url));

export function sourceStamp(root = daemonRoot): string {
  const files = readdirSync(path.join(root, 'src'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
  files.push('tsconfig.json', 'package.json');
  const entries = files.sort().map((file) => [
    file,
    createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex'),
  ]);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(path.join(daemonRoot, 'dist', '.source-stamp.json'), `${JSON.stringify({ sha256: sourceStamp() })}\n`);
}
