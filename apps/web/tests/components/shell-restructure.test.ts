/**
 * App-chrome restructure contract.
 *
 * Source/AST contracts cover desktop chrome and the surviving ownership and
 * callback graph, not whether retired names or files still exist.
 * App.project-rail-persistence.test.tsx owns real DOM identity, search, menus,
 * collapse/resize, palette and Peek behavior across routes. Do not duplicate
 * those render tests here. App.new-project-modal.test.tsx exercises creation,
 * imports and the entry/workspace launch paths; HubRailFooter.chrome.test.tsx
 * exercises the footer settings and workspace-folder controls.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../../../..');

function readSource(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

const appSource = readSource('apps/web/src/App.tsx');
const entryShellSource = readSource('apps/web/src/components/EntryShell.tsx');
const hubRailSource = readSource('apps/web/src/components/hub/HubRail.tsx');
const runtimeSource = readSource('apps/desktop/src/main/runtime.ts');
const preloadSource = readSource('apps/desktop/src/main/preload.cts');
const shellCssSource = readSource('apps/web/src/styles/shell.css');
function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('contract.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

const appAst = parse(appSource);
// The composition boundary: App -> EntryView -> EntryShell -> HubHome, plus
// the persistent provider, rail and overlays. Count actual mounts/calls across
// these owners; comments, type imports and compatibility files are irrelevant.
const shellAsts = [
  appAst,
  parse(readSource('apps/web/src/components/EntryView.tsx')),
  parse(entryShellSource),
  parse(readSource('apps/web/src/components/hub/HubHome.tsx')),
  parse(hubRailSource),
  parse(readSource('apps/web/src/components/hub/HubRailContext.tsx')),
  parse(readSource('apps/web/src/components/hub/HubRailOverlays.tsx')),
];

function nodes<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const result: T[] = [];
  const visit = (node: ts.Node) => {
    if (predicate(node)) result.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return result;
}

function calls(root: ts.Node, name: string): ts.CallExpression[] {
  return nodes(root, ts.isCallExpression).filter((node) => node.expression.getText() === name);
}

function owner(node: ts.Node): string | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent)) return parent.name?.text;
  }
  return undefined;
}

function one<T>(values: T[]): T {
  expect(values).toHaveLength(1);
  return values[0]!;
}

type JsxOpening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function jsxOpenings(name: string, root: ts.Node = appAst): JsxOpening[] {
  const openings: JsxOpening[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText() === name
    ) {
      openings.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return openings;
}

function jsxAttributeNameText(name: ts.JsxAttributeName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isJsxNamespacedName(name)) return `${name.namespace.text}:${name.name.text}`;
  return undefined;
}

function hasExpressionAttribute(node: JsxOpening, name: string, expression: string): boolean {
  return node.attributes.properties.some((attribute) =>
    ts.isJsxAttribute(attribute) &&
    jsxAttributeNameText(attribute.name) === name &&
    attribute.initializer !== undefined &&
    ts.isJsxExpression(attribute.initializer) &&
    attribute.initializer.expression?.getText() === expression,
  );
}

function hasAncestorOpening(node: ts.Node, name: string): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isJsxElement(parent) && parent.openingElement.tagName.getText() === name) {
      return true;
    }
  }
  return false;
}

function jsxChildrenParent(node: JsxOpening): ts.Node | undefined {
  // A self-closing JSX node is itself a child. An opening tag belongs to its
  // JSX element, whose parent is the children list that contains that element.
  return ts.isJsxSelfClosingElement(node) ? node.parent : node.parent.parent;
}

describe('1. no native title bar', () => {
  it('creates the main desktop window without a native frame', () => {
    // macOS keeps `hiddenInset` (its own traffic lights stay in the inset bar);
    // every other platform is fully frameless.
    expect(runtimeSource).toContain('titleBarStyle: "hiddenInset"');
    expect(runtimeSource).toContain('frame: false as const');
  });

  it('keeps an intentional drag region with non-draggable controls inside it', () => {
    expect(appSource).toContain('app-window-chrome__drag');
    expect(shellCssSource).toMatch(/\.app-window-chrome\s*\{[^}]*-webkit-app-region:\s*drag/s);
    expect(shellCssSource).toMatch(/\.window-controls\s*\{[^}]*-webkit-app-region:\s*no-drag/s);
  });
});

describe('2. traffic-light window controls', () => {
  it('exposes real window IPC from the main process', () => {
    for (const channel of [
      'window:minimize',
      'window:toggle-maximize',
      'window:close',
      'window:get-state',
    ]) {
      expect(runtimeSource).toContain(`ipcMain.handle("${channel}"`);
    }
    // State changes originating outside the renderer must be pushed back.
    expect(runtimeSource).toContain('window:state');
    expect(runtimeSource).toContain('window.on("maximize"');
    expect(runtimeSource).toContain('window.on("unmaximize"');
  });

  it('bridges those channels through the sandboxed preload', () => {
    expect(preloadSource).toContain("ipcRenderer.invoke('window:minimize')");
    expect(preloadSource).toContain("ipcRenderer.invoke('window:toggle-maximize')");
    expect(preloadSource).toContain("ipcRenderer.invoke('window:close')");
    expect(preloadSource).toContain("ipcRenderer.on('window:state'");
  });

  it('mounts the traffic lights in the app chrome', () => {
    expect(appSource).toContain('<WindowControls />');
    expect(appSource).toContain('app-window-chrome');
  });
});

describe('3. surviving chrome capabilities', () => {
  it('connects the rail footer gear to the App-owned settings surface', () => {
    const footer = parse(readSource('apps/web/src/components/hub/HubRailFooter.tsx'));
    const gear = one(jsxOpenings('button', footer).filter((node) =>
      node.attributes.properties.some((attribute) => ts.isJsxAttribute(attribute) &&
        attribute.name.getText() === 'data-testid' &&
        attribute.initializer && ts.isStringLiteral(attribute.initializer) &&
        attribute.initializer.text === 'hub-footer-settings'),
    ));
    expect(hasExpressionAttribute(gear, 'onClick', 'onOpenSettings')).toBe(true);
    expect(hasExpressionAttribute(one(jsxOpenings('HubRailFooter', shellAsts[4]!)), 'onOpenSettings', 'onOpenSettings')).toBe(true);
    expect(hasExpressionAttribute(one(jsxOpenings('HubRail')), 'onOpenSettings', '() => openSettings()')).toBe(true);
    const opener = one(nodes(appAst, ts.isVariableDeclaration).filter((node) => node.name.getText() === 'openSettings'));
    expect(owner(opener)).toBe('AppInner');
    expect(one(calls(opener, 'setSettingsOpen')).arguments[0]?.kind).toBe(ts.SyntaxKind.TrueKeyword);
    const dialog = one(jsxOpenings('SettingsDialog'));
    expect(owner(dialog)).toBe('AppInner');
    expect(hasExpressionAttribute(dialog, 'onPersist', 'handleConfigPersist')).toBe(true);
    const settingsBranch = one(nodes(appAst, ts.isConditionalExpression).filter((node) =>
      node.condition.getText() === 'settingsOpen',
    ));
    expect(jsxOpenings('SettingsDialog', settingsBranch.whenTrue)).toEqual([dialog]);
  });
});

function assertRailOwnership(asts: ts.SourceFile[]) {
  const mounts = (name: string) => asts.flatMap((ast) => jsxOpenings(name, ast));
  const provider = one(mounts('HubRailProvider'));
  const rail = one(mounts('HubRail'));
  const overlays = one(mounts('HubRailOverlays'));
  const surface = one(mounts('div').filter((node) => hasExpressionAttribute(node, 'key', 'surfaceId')));
  for (const node of [provider, rail, overlays, surface]) expect(owner(node)).toBe('AppInner');
  expect(hasExpressionAttribute(provider, 'value', 'rail')).toBe(true);
  for (const node of [rail, overlays, surface]) {
    expect(hasAncestorOpening(node, 'HubRailProvider')).toBe(true);
  }
  expect(jsxChildrenParent(rail)).toBe(jsxChildrenParent(surface));
  expect(jsxChildrenParent(overlays)).toBe(jsxChildrenParent(surface));
  // A key above the siblings would still remount everything together.
  for (let parent = rail.parent; parent; parent = parent.parent) {
    if (ts.isJsxElement(parent)) {
      expect(parent.openingElement.attributes.properties.filter((attribute) =>
        ts.isJsxAttribute(attribute) && attribute.name.getText() === 'key',
      )).toHaveLength(0);
    }
  }
  const controller = one(asts.flatMap((ast) => calls(ast, 'useHubRailController')));
  expect(owner(controller)).toBe('AppInner');
  expect(ts.isVariableDeclaration(controller.parent)).toBe(true);
  expect((controller.parent as ts.VariableDeclaration).name.getText()).toBe('rail');
  expect(asts.flatMap((ast) => calls(ast, 'useHubRail')).map(owner).sort()).toEqual([
    'HubHome', 'HubRail', 'HubRailOverlays',
  ]);
  for (const consumer of ['HubHome', 'HubRail', 'HubRailOverlays']) {
    const declaration = one(asts.flatMap((ast) => nodes(ast, ts.isFunctionDeclaration))
      .filter((node) => node.name?.text === consumer));
    const binding = one(nodes(declaration, ts.isVariableDeclaration).filter((node) => node.name.getText() === 'rail'));
    expect(binding.initializer).toBe(one(calls(declaration, 'useHubRail')));
  }
  const context = asts[5]!;
  expect(hasExpressionAttribute(one(jsxOpenings('HubRailContext.Provider', context)), 'value', 'value')).toBe(true);
  expect(one(calls(context, 'useContext')).arguments.map((node) => node.getText())).toEqual(['HubRailContext']);
  // The mounted entry chain reaches the context consumer, rather than a
  // disconnected useHubRail call elsewhere satisfying the count.
  expect(owner(one(mounts('EntryView')))).toBe('AppInner');
  expect(owner(one(mounts('EntryShell')))).toBe('EntryView');
  expect(owner(one(mounts('HubHome')))).toBe('EntryShell');
  expect(hasExpressionAttribute(surface, 'className', 'workspaceTransition.surface')).toBe(true);
  expect(hasExpressionAttribute(surface, 'data-transition', 'surfaceTransition')).toBe(true);
  expect(hasExpressionAttribute(surface, 'ref', 'setSurfaceInertRef')).toBe(true);
  expect(nodes(jsxChildrenParent(surface)!, ts.isJsxExpression)
    .filter((node) => node.expression?.getText() === 'appMain').map((node) => node.parent))
    .toEqual([surface.parent]);
}

function assertModalOwnership(asts: ts.SourceFile[]) {
  const modal = one(asts.flatMap((ast) => jsxOpenings('NewProjectModal', ast)));
  expect(owner(modal)).toBe('AppInner');
  // Direct provider child: route keys and hidden entry views cannot own it.
  expect(ts.isJsxElement(jsxChildrenParent(modal)!)).toBe(true);
  expect((jsxChildrenParent(modal) as ts.JsxElement).openingElement.tagName.getText()).toBe('HubRailProvider');
  expect(hasExpressionAttribute(modal, 'open', 'newProjectTab !== null')).toBe(true);
  expect(hasExpressionAttribute(modal, 'initialTab', "newProjectTab ?? 'prototype'")).toBe(true);
  expect(hasExpressionAttribute(modal, 'onClose', '() => setNewProjectTab(null)')).toBe(true);
  expect(hasExpressionAttribute(modal, 'onCreate', 'handleCreateFromModal')).toBe(true);
  const state = one(asts.flatMap((ast) => nodes(ast, ts.isVariableDeclaration)).filter((node) =>
    ts.isArrayBindingPattern(node.name) && node.name.elements.some((element) =>
      ts.isBindingElement(element) && element.name.getText() === 'newProjectTab'),
  ));
  expect(owner(state)).toBe('AppInner');
  expect(state.name.getText()).toBe('[newProjectTab, setNewProjectTab]');
  expect(one(calls(state, 'useState')).arguments[0]?.kind).toBe(ts.SyntaxKind.NullKeyword);
  const app = asts[0]!;
  const opener = one(nodes(app, ts.isVariableDeclaration).filter((node) => node.name.getText() === 'openNewProject'));
  expect(one(calls(opener, 'setNewProjectTab')).arguments.map((node) => node.getText())).toEqual(['tab']);
  const railOpener = one(nodes(app, ts.isVariableDeclaration).filter((node) => node.name.getText() === 'newRailProject'));
  expect(one(calls(railOpener, 'openNewProject')).arguments.map((node) => node.getText())).toEqual(["'prototype'"]);
  const controller = one(calls(app, 'useHubRailController'));
  expect(one(nodes(controller.arguments[0]!, ts.isPropertyAssignment).filter((node) => node.name.getText() === 'onNewProject'))
    .initializer.getText()).toBe('newRailProject');
  expect(hasExpressionAttribute(one(jsxOpenings('EntryView', app)), 'onOpenNewProject', 'openNewProject')).toBe(true);
  expect(hasExpressionAttribute(one(jsxOpenings('EntryShell', asts[1]!)), 'onOpenNewProject', 'onOpenNewProject')).toBe(true);
  const entryOpener = one(nodes(asts[2]!, ts.isFunctionDeclaration).filter((node) => node.name?.text === 'openNewProject'));
  expect(one(calls(entryOpener, 'onOpenNewProject')).arguments.map((node) => node.getText())).toEqual(['tab']);
  expect(hasExpressionAttribute(one(jsxOpenings('HubHome', asts[2]!)), 'onOpenNewProject', '(tab) => openNewProject(tab)')).toBe(true);
  expect(hasExpressionAttribute(one(jsxOpenings('DesignsTab', asts[2]!)), 'onNewProject', '() => openNewProject()')).toBe(true);
  expect(hasExpressionAttribute(one(jsxOpenings('HomeView', asts[3]!)), 'onOpenNewProject', 'onOpenNewProject')).toBe(true);
}

describe('4. unified shell ownership', () => {
  it('owns one controller, rail and overlay host outside the keyed routed surface', () => {
    assertRailOwnership(shellAsts);
    const frame = one(jsxOpenings('ProjectRail', shellAsts[4]!));
    expect(hasExpressionAttribute(frame, 'expanded', '!railCollapsed')).toBe(true);
    expect(hasExpressionAttribute(frame, 'onToggle', 'rail.toggleRail')).toBe(true);
    expect(hasExpressionAttribute(one(jsxOpenings('HubSessionTree', shellAsts[4]!)), 'projects', 'rail.tree')).toBe(true);
  });

  it('routes rail, Home and Projects launchers to one AppInner modal state and callback path', () => {
    assertModalOwnership(shellAsts);
  });

  // In-memory negative controls exercise the same contract as production.
  // No source mutation, deletion sentinel or copied render harness is needed.
  it.each([
    ['duplicate rail', '<HubRailOverlays />', '<HubRailOverlays /><HubRail />'],
    ['keyed shell ancestor', '<HubRailProvider value={rail}>', '<HubRailProvider key={surfaceId} value={rail}>'],
    ['duplicate controller', 'const rail = useHubRailController({', 'useHubRailController({}); const rail = useHubRailController({'],
  ])('rejects %s', (_name, before, after) => {
    const mutated = parse(appSource.replace(before, after));
    expect(() => assertRailOwnership([mutated, ...shellAsts.slice(1)])).toThrow();
  });

  it.each(['HubRail', 'HubRailOverlays'])('rejects moving the single %s inside the keyed surface', (name) => {
    const mount = one(jsxOpenings(name)).getText();
    const mutated = parse(appSource.replace(mount, '').replace('{appMain}', `{appMain}${mount}`));
    expect(jsxOpenings(name, mutated)).toHaveLength(1);
    expect(() => assertRailOwnership([mutated, ...shellAsts.slice(1)])).toThrow();
  });

  it('rejects Home creating its own controller instead of consuming the ancestor', () => {
    const asts = shellAsts.map((ast, index) => index === 3
      ? parse(ast.text.replace('const rail = useHubRail();', 'const rail = useHubRailController({});'))
      : ast);
    expect(() => assertRailOwnership(asts)).toThrow();
  });

  it.each([
    ['duplicate modal', '<TooltipLayer />', '<NewProjectModal /><TooltipLayer />'],
    ['disconnected entry opener', 'onOpenNewProject={openNewProject}', 'onOpenNewProject={() => undefined}'],
    ['disconnected rail opener', 'onNewProject: newRailProject', 'onNewProject: () => undefined'],
  ])('rejects %s', (_name, before, after) => {
    const mutated = parse(appSource.replace(before, after));
    expect(() => assertModalOwnership([mutated, ...shellAsts.slice(1)])).toThrow();
  });
});

describe('non-file workspace surfaces retain their own hosts', () => {
  const workspace = parse(readSource('apps/web/src/components/FileWorkspace.tsx'));

  it.each([
    ['QuestionsPanel', 'onSubmit', '(text) => onSubmitQuestionForm?.(text)'],
    ['SideChatTab', 'conversationId', 'conversationIdFromSideChatTabId(activeTab)'],
    ['TerminalViewer', 'terminalId', 'terminalIdFromTabId(activeTab)'],
  ])('mounts %s with its live workspace callback or identity', (name, prop, expression) => {
    const host = one(jsxOpenings(name, workspace));
    expect(owner(host)).toBe('FileWorkspace');
    expect(hasExpressionAttribute(host, 'projectId', 'projectId')).toBe(true);
    expect(hasExpressionAttribute(host, prop, expression)).toBe(true);
  });

  it('wires the mounted tab launcher to workspace focus and file opening', () => {
    const launcher = one(jsxOpenings('TabLauncherMenu', workspace));
    expect(owner(launcher)).toBe('FileWorkspace');
    expect(hasExpressionAttribute(launcher, 'onOpenFile', 'openFile')).toBe(true);
    expect(hasExpressionAttribute(launcher, 'onOpenTab', 'focusWorkspaceTab')).toBe(true);
    expect(hasExpressionAttribute(launcher, 'actions', 'launcherActions')).toBe(true);
  });
});
