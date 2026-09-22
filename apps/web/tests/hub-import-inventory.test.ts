import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('keeps project-only initializers outside the transitive eager Hub graph', () => {
  // Given fd-discovered sources; follow import edges, not a filesystem walker.
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const sources = execFileSync('fd', [
    '-e', 'ts', '-e', 'tsx', '-e', 'json', '.',
    'apps/web/src', 'apps/web/app', 'packages/contracts/src',
    'packages/host/src', 'packages/components/src',
  ], { cwd: root, encoding: 'utf8', windowsHide: true });
  const files = new Set(sources.trim().split(/\r?\n/).map((path) => resolve(root, path)));
  const pending = [resolve(root, 'apps/web/app/layout.tsx'), resolve(root, 'apps/web/src/App.tsx'), resolve(root, 'apps/web/app/[[...slug]]/client-app.tsx')];
  const visited = new Set<string>();
  const external = new Set<string>();
  const work: string[] = [];
  const edges: string[] = [];
  // When walking only runtime static imports/reexports and top-level initializers.
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || visited.has(path)) continue;
    visited.add(path);
    if (path.endsWith('.json')) {
      work.push(`${relative(root, path)}:1 JSON literal (${readFileSync(path).length} bytes)`);
      continue;
    }
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
        if (ts.isImportDeclaration(statement)) {
          const clause = statement.importClause;
          if (clause?.isTypeOnly) continue;
          if (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.every((node) => node.isTypeOnly)) continue;
        } else if (statement.isTypeOnly) continue;
        const specifier = statement.moduleSpecifier;
        if (!specifier || !ts.isStringLiteral(specifier)) continue;
        const name = specifier.text;
        if (name.endsWith('.css')) continue;
        let base: string;
        if (name.startsWith('.')) base = resolve(dirname(path), name.replace(/\.js$/, ''));
        else if (name.startsWith('@readable-studio/')) {
          const [pkg, ...rest] = name.slice('@readable-studio/'.length).split('/');
          base = resolve(root, `packages/${pkg}/src`, rest.join('/') || 'index');
        } else { external.add(name); continue; }
        const target = [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts'), resolve(base, 'index.tsx')].find((candidate) => files.has(candidate));
        if (target) {
          pending.push(target);
          edges.push(`${relative(root, path)} -> ${relative(root, target)}`);
        } else external.add(name);
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          const initializer = declaration.initializer;
          if (!initializer || ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) continue;
          if (ts.isStringLiteral(initializer) || ts.isNumericLiteral(initializer) || initializer.kind === ts.SyntaxKind.NullKeyword || initializer.kind === ts.SyntaxKind.TrueKeyword || initializer.kind === ts.SyntaxKind.FalseKeyword) continue;
          const line = source.getLineAndCharacterOfPosition(declaration.getStart()).line + 1;
          work.push(`${relative(root, path)}:${line} ${declaration.name.getText(source)} = ${initializer.getText(source).replace(/\s+/g, ' ').slice(0, 160)} [${initializer.getWidth(source)} chars]`);
        }
      } else if (ts.isExpressionStatement(statement) || ts.isIfStatement(statement) || ts.isForStatement(statement) || ts.isForOfStatement(statement) || ts.isClassDeclaration(statement)) {
        if (ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)) continue;
        const line = source.getLineAndCharacterOfPosition(statement.getStart()).line + 1;
        work.push(`${relative(root, path)}:${line} ${statement.getText(source).replace(/\s+/g, ' ').slice(0, 200)}`);
      }
    }
  }
  // Then Hub catalogue helpers are eager, while project-only work stays deferred.
  for (const path of ['i18n/content.ts', 'state/themes.ts', 'components/plugins-home/curatedPriority.ts']) {
    expect(visited.has(resolve(root, 'apps/web/src', path))).toBe(true);
  }
  for (const path of ['components/ProjectView.tsx', 'components/SettingsDialog.tsx', 'runtime/zip.ts', 'runtime/shiki.ts', 'state/maxTokens.ts']) {
    expect(visited.has(resolve(root, 'apps/web/src', path))).toBe(false);
  }
  // Optional static audit artifact; ordinary test runs do not write files.
  const output = process.env.HUB_IMPORT_INVENTORY_PATH;
  if (output) writeFileSync(output, `MODULES ${visited.size}\nWORK\n` + work.sort().join('\n') + '\nEDGES\n' + edges.sort().join('\n') + '\nEXTERNAL\n' + [...external].sort().join('\n'));
});
