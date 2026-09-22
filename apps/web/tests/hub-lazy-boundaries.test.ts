import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

describe('Hub module boundaries', () => {
  it.each([
    ['EntryShell', ['./DesignsTab', './DesignSystemsTab', './DesignSystemPreviewModal', './IntegrationsView', './PluginsView', './TasksView']],
    ['NewProjectModal', ['./NewProjectPanel']],
    ['HomeView', ['./PluginDetailsModal']],
  ] as const)('defers unopened surfaces from %s', (entry, deferred) => {
    // Given the real entry module, parse imports rather than pinning prose.
    const source = ts.createSourceFile(entry, readFileSync(new URL(`../src/components/${entry}.tsx`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    // When collecting runtime static edges.
    const edges = source.statements.filter(ts.isImportDeclaration)
      .filter((node) => !node.importClause?.isTypeOnly)
      .map((node) => ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : '');
    // Then deferred surfaces cannot enter the initial graph.
    expect(edges.filter((edge) => deferred.some((path) => path === edge))).toEqual([]);
  });
});
