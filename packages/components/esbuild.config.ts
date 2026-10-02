import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

// esbuild emits the bundled CSS Modules as a sibling `index.css` but never
// references it from `index.mjs`, so a consumer resolving the `default`
// export condition (every production `next build`) gets the class names with
// no stylesheet behind them. Prepend the import so the bundle carries its own
// styles; `transpilePackages` in the web app processes it like app CSS.
export const STYLESHEET_IMPORT = "import './index.css';\n";

export async function buildComponents(outdir = './dist'): Promise<void> {
  rmSync(outdir, { force: true, recursive: true });

  await build({
    bundle: true,
    entryPoints: ['./src/index.ts'],
    format: 'esm',
    outbase: './src',
    outdir,
    outExtension: { '.js': '.mjs' },
    packages: 'external',
    platform: 'browser',
    target: 'es2022',
  });

  const entry = join(outdir, 'index.mjs');
  writeFileSync(entry, STYLESHEET_IMPORT + readFileSync(entry, 'utf8'));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildComponents();
}
