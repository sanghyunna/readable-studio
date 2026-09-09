import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, test } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const seamNames = new Map([
  ['addStorageInitScript', 1],
  ['evaluateStorageSeed', 1],
  ['storageSeedScript', 0],
]);

function unguardedStorage(source: string, fileName = 'fixture.ts'): number[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const nodes: ts.Node[] = [];
  const collect = (node: ts.Node) => { nodes.push(node); ts.forEachChild(node, collect); };
  collect(file);
  const seams = new Map<string, number>();
  for (const node of nodes) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)
      || !/(?:^|\/)storage-init(?:\.[jt]s)?$/.test(node.moduleSpecifier.text)) continue;
    const bindings = node.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const binding of bindings.elements) {
      const index = seamNames.get((binding.propertyName ?? binding.name).text);
      if (index !== undefined) seams.set(binding.name.text, index);
    }
  }
  const isGuardedArgument = (node: ts.Node): boolean => {
    const parent = node.parent;
    if (!parent || !ts.isCallExpression(parent) || !ts.isIdentifier(parent.expression)) return false;
    const index = seams.get(parent.expression.text);
    return index !== undefined && parent.arguments[index] === node;
  };
  const isGuarded = (node: ts.Node): boolean => {
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
      if (isGuardedArgument(current)) return true;
      // A named callback is safe only when every use passes it to the seam.
      if ((ts.isFunctionDeclaration(current)
        || (ts.isVariableDeclaration(current) && current.initializer
          && (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))))
        && current.name && ts.isIdentifier(current.name)) {
        const name = current.name;
        const references = nodes.filter((candidate): candidate is ts.Identifier =>
          ts.isIdentifier(candidate) && candidate.text === name.text && candidate !== name);
        return references.length > 0 && references.every(isGuardedArgument);
      }
    }
    return false;
  };
  const inInitScript = (node: ts.Node): boolean => {
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
      if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)
        && current.expression.name.text === 'addInitScript') return true;
    }
    return false;
  };
  const violations = new Set<number>();
  for (const node of nodes) {
    // Inspect the storage receiver, not its property-name identifier twice.
    const storage = (ts.isIdentifier(node) && node.text === 'localStorage'
      && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
      && !ts.isGetAccessorDeclaration(node.parent))
      || (ts.isPropertyAccessExpression(node) && node.name.text === 'localStorage')
      || (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
        && node.argumentExpression.text === 'localStorage');
    // Raw eval/addInitScript strings are not an escape hatch around this rule.
    const rawScript = (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node)
      || ts.isTemplateTail(node)) && /\blocalStorage\b/.test(node.text)
      && /\b(?:setItem|removeItem|clear)\b|localStorage\s*(?:\[[^\]]+\]|\.\w+)\s*=/.test(node.text);
    if (!storage && !rawScript) continue;
    if (isGuarded(node)) continue;
    // Post-navigation assertions may read storage; init-script reads need the guard too.
    const parent = node.parent;
    if (storage && !inInitScript(node) && ts.isPropertyAccessExpression(parent)
      && ['getItem', 'key', 'length'].includes(parent.name.text)) continue;
    violations.add(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
  }
  return [...violations];
}

test('all E2E storage seeders use the shared guarded seam', () => {
  // fd is the repository discovery boundary, including in static checks.
  const files = execFileSync('fd', ['--type', 'f', '--extension', 'ts', '--exclude', 'node_modules',
    '--exclude', 'reports', '.', 'lib', 'ui', 'tests', 'specs', 'scripts', 'resources'], { cwd: root, encoding: 'utf8' })
    .trim().split(/\r?\n/).map((file) => file.replaceAll('\\', '/'));
  const failures: string[] = [];
  for (const file of files) {
    // The seam owns the guard; this file contains deliberately invalid parser fixtures.
    if (file === 'lib/playwright/storage-init.ts' || file === 'tests/storage-seeding-policy.test.ts') continue;
    for (const line of unguardedStorage(readFileSync(new URL(file, new URL('../', import.meta.url)), 'utf8'), file)) {
      failures.push(`${file}:${line}`);
    }
  }
  expect(files.length).toBeGreaterThan(0);
  expect(failures).toEqual([]);
});

test.each([
  `page.addInitScript(() => localStorage.setItem('key', 'value'));`,
  `context.addInitScript(() => window.localStorage.clear());`,
  `page.addInitScript(() => window.localStorage.getItem('key'));`,
  `page.evaluate(() => window['localStorage'].removeItem('key'));`,
  `page.evaluate(() => { const storage = localStorage; storage.setItem('key', 'value'); });`,
  `localStorage['key'] = 'value';`,
  `page.addInitScript({ content: "window.localStorage.setItem('key', 'value')" });`,
  `function seed() { localStorage.clear(); } page.addInitScript(seed);`,
  `import { addStorageInitScript } from '@/playwright/storage-init'; function seed() { localStorage.clear(); } addStorageInitScript(page, seed, undefined); page.evaluate(seed);`,
  `function addStorageInitScript(page, seed) { seed(); } addStorageInitScript(page, () => localStorage.clear());`,
])('rejects an unguarded storage access: %s', (source) => {
  expect(unguardedStorage(source).length).toBeGreaterThan(0);
});

test.each([
  `page.evaluate(() => window.localStorage.getItem('key'));`,
  `page.addInitScript(() => document.documentElement.dataset.test = 'true');`,
  `import { addStorageInitScript as seed } from '@/playwright/storage-init'; seed(page, () => localStorage.clear(), undefined);`,
  `import { evaluateStorageSeed } from '@/playwright/storage-init'; evaluateStorageSeed(page, () => localStorage.removeItem('key'), undefined);`,
  `import { storageSeedScript } from '../playwright/storage-init.js'; desktop.eval(storageSeedScript(() => localStorage.setItem('key', 'value'), undefined));`,
  `import { addStorageInitScript, evaluateStorageSeed } from '@/playwright/storage-init'; function seed() { localStorage.clear(); } addStorageInitScript(context, seed, undefined); evaluateStorageSeed(page, seed, undefined);`,
  `import { addStorageInitScript } from '@/playwright/storage-init'; const seed = () => localStorage.clear(); addStorageInitScript(page, seed, undefined);`,
])('accepts guarded seeders and read-only assertions: %s', (source) => {
  expect(unguardedStorage(source)).toEqual([]);
});
