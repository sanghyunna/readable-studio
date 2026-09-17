import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('keeps shared layout dependencies React-free when they run on the server', () => {
  // Given the actual server layout and its runtime imports.
  const layoutPath = fileURLToPath(new URL('../../app/layout.tsx', import.meta.url));
  const layout = ts.createSourceFile(layoutPath, readFileSync(layoutPath, 'utf8'), ts.ScriptTarget.Latest, true);
  const imports = layout.statements.filter(ts.isImportDeclaration).filter((statement) =>
    !statement.importClause?.isTypeOnly && ts.isStringLiteral(statement.moduleSpecifier)
    && statement.moduleSpecifier.text.startsWith('.') && !statement.moduleSpecifier.text.endsWith('.css'),
  );

  // When each shared dependency is inspected (client entry points are separate bundles).
  const offenders = imports.flatMap((statement) => {
    if (!ts.isStringLiteral(statement.moduleSpecifier)) return [];
    const specifier = statement.moduleSpecifier.text;
    const resolved = ts.resolveModuleName(specifier, layoutPath, {
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.Preserve,
    }, ts.sys).resolvedModule;
    expect(resolved, specifier).toBeDefined();
    if (!resolved) return [];
    const source = ts.createSourceFile(resolved.resolvedFileName,
      readFileSync(resolved.resolvedFileName, 'utf8'), ts.ScriptTarget.Latest, true);
    const isClient = source.statements.some((node) => ts.isExpressionStatement(node)
      && ts.isStringLiteral(node.expression) && node.expression.text === 'use client');
    if (isClient) return [];
    return source.statements.filter(ts.isImportDeclaration).filter((node) => {
      if (!ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== 'react') return false;
      const clause = node.importClause;
      if (!clause) return true;
      if (clause.isTypeOnly) return false;
      if (clause.name) return true;
      const bindings = clause.namedBindings;
      return bindings !== undefined && (ts.isNamespaceImport(bindings)
        || bindings.elements.some((element) => !element.isTypeOnly));
    }).map(() => specifier);
  });

  // Then shared constants/readers cannot pull React hooks into the server bundle.
  expect(offenders).toEqual([]);
});
