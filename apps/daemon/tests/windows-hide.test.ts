import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const files = execFileSync('fd', [
  '--type', 'f', '--extension', 'ts', '--extension', 'tsx', '--extension', 'mts', '--extension', 'cts',
  '.', 'apps/daemon/src', 'apps/desktop/src', 'tools',
], { cwd: root, encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)
  .map((file) => file.replaceAll('\\', '/'))
  .filter((file) => readFileSync(path.join(root, file), 'utf8').includes('child_process'));

const launchNames = new Set([
  'spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork',
  'execFileAsync', 'execFileP', 'launcher', 'spawnChild',
]);

function isLaunch(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return launchNames.has(callee.text);
  // Also cover inline promisify(execFile)(...) used in the packaging tests.
  return ts.isCallExpression(callee) && ts.isIdentifier(callee.expression)
    && callee.expression.text === 'promisify'
    && callee.arguments.some((arg) => ts.isIdentifier(arg) && launchNames.has(arg.text));
}

function hidesWindow(options: ts.Expression | undefined): boolean {
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  // A later spread could override the flag; require the effective property.
  for (const property of [...options.properties].reverse()) {
    if (ts.isSpreadAssignment(property)) return false;
    if (ts.isPropertyAssignment(property) && property.name.getText() === 'windowsHide') {
      return property.initializer.kind === ts.SyntaxKind.TrueKeyword
        || property.initializer.getText().replaceAll('"', "'") === "process.platform === 'win32'";
    }
  }
  return false;
}

it.each(files)('hides background child-process windows when launched by %s', (file) => {
  // Given the real source, parsed without importing or executing its entrypoint.
  const source = ts.createSourceFile(file, readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isLaunch(node)) {
      const options = node.arguments[2] ?? node.arguments[1];
      // These three platform branches intentionally open an interactive OAuth
      // terminal. Hiding that requested terminal would break the login flow.
      const interactiveTerminal = file === 'apps/daemon/src/runtimes/terminal-launch.ts';
      // These existing seams forward options checked at their construction below.
      const forwarded = (file === 'apps/daemon/src/browser-open.ts' && options?.getText() === 'invocation.options')
        || (file === 'apps/daemon/src/runtimes/hosted-pi-turn.ts' && options?.getText() === 'options');
      if (!interactiveTerminal && !forwarded && !hidesWindow(options)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        violations.push(`${file}:${line + 1} ${node.expression.getText()}`);
      }
    }
    // Browser opening hides the launcher console, not the requested browser.
    if (file === 'apps/daemon/src/browser-open.ts' && ts.isPropertyAssignment(node)
      && node.name.getText() === 'options' && !hidesWindow(node.initializer)) {
      violations.push(`${file}: browser invocation options`);
    }
    ts.forEachChild(node, visit);
  };

  // When all native launches (including promisified and injected seams) are inspected.
  visit(source);

  // Then every background launch explicitly suppresses a Windows console.
  expect(violations).toEqual([]);
});
