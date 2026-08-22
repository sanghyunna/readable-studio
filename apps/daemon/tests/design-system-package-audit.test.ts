import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { auditDesignSystemPackage, runDesignSystemPackageAuditCli } from '../src/design-system-package-audit.js';




const AUDIT_DESIGN_MD = `# Cherry Studio Design System

## Product Context

Cherry Studio is a desktop AI chat workspace with a dense shell, assistant navigation, model selection, and composer-first workflows. The design system should preserve the compact app frame, clear message hierarchy, and source-backed assets.

## Color Foundations

Use the captured primary green, dark theme surfaces, muted dividers, and neutral text colors from source evidence. Color rules must document backgrounds, elevated panels, borders, text, primary actions, and status states.

## Typography

Ubuntu is the core sans family. Use clear size steps for navigation, message content, titles, dense metadata, and button labels. Keep mono text for code-like paths, IDs, and technical details.

## Spacing And Layout

Use compact spacing, slim gutters, and split-pane app layout rules. Preserve sidebar density, toolbar rhythm, composer placement, and scrollable content regions.

## Components

Define buttons, inputs, assistant rows, message bubbles, model selectors, icon actions, settings controls, and status surfaces with concrete states and usage notes.

## Motion And Interaction

Use quick hover/focus feedback, subtle panel transitions, predictable loading states, and reduced-motion fallbacks for desktop productivity.

## Voice And Brand

Use direct product language. Keep labels calm, technical, and concise while preserving Cherry Studio naming and app terminology.

## Anti-patterns

Avoid generic marketing pages, oversized cards, invented palettes, missing source assets, and preview pages that do not show real product modules.
`;

const AUDIT_README = `# Cherry Studio Design System

This package captures a source-backed Readable Studio design system for a desktop AI chat workspace. It includes reusable rules, token CSS, focused review previews, preserved assets, preserved fonts, and an applied UI kit.

## Product Overview

Cherry Studio is a desktop AI chat workspace for multi-model assistant workflows. The source product provides assistant navigation, topic and message review, model selection, file-aware composer controls, settings panels, and compact cross-platform app chrome for Windows, macOS, and Linux. Use this package to preserve that dense productivity surface rather than turning the system into a generic landing page.

## Package Contents

- DESIGN.md is the canonical Readable Studio rules document.
- colors_and_type.css contains reusable variables for color, type, spacing, radius, and states.
- preview/ contains focused HTML cards for color, typography, spacing, components, and brand assets.
- ui_kits/app/ contains an applied interface example for future project reuse.
- assets/, build/, and fonts/ preserve source-backed brand, runtime icons, and typography evidence.

## Preview Manifest

- preview/colors-primary.html reviews the captured primary palette and semantic color roles.
- preview/colors-theme-light.html reviews light surfaces, borders, and text hierarchy.
- preview/typography-specimens.html reviews Ubuntu typography specimens and dense UI text.
- preview/spacing-tokens.html reviews compact layout rhythm, radius, and spacing rules.
- preview/components-buttons.html reviews core controls and component states.
- preview/brand-assets.html reviews preserved source assets, runtime icons, and fonts.

## Review Workflow

Start with DESIGN.md, compare the preview cards, then inspect the applied UI kit. Reuse assets and fonts directly when building product surfaces.
`;

const README_WITHOUT_PREVIEW_MANIFEST = AUDIT_README.replace(
  /\n## Preview Manifest\n\n[\s\S]*?\n## Review Workflow/u,
  '\n## Review Workflow',
);

const README_WITHOUT_PRODUCT_OVERVIEW = `# Cherry Studio Design System

https://github.com/cherryhq/cherry-studio

## Overview

- Category: Custom
- Surface: web
- Primary accent: #00b96b
- Background: #ffffff
- Foreground: #202124

## Generated Files

- DESIGN.md: canonical design system source.
- colors_and_type.css: reusable CSS variables for color and type.
- preview/: HTML review cards for type, color, spacing, components, and brand.
- assets/: logo and brand asset references.
- context/: structured source context captured during setup.
- ui_kits/app/: interactive interface preview.
- SKILL.md: agent-facing usage instructions.

## Source Context

Company/product context: https://github.com/cherryhq/cherry-studio
GitHub/code links: https://github.com/cherryhq/cherry-studio
`;

const README_WITHOUT_PACKAGE_REUSE_GUIDE = `# Cherry Studio Design System

## Product Overview

Cherry Studio is a desktop AI chat workspace for multi-model assistant workflows. The source product provides assistant navigation, topic and message review, model selection, file-aware composer controls, settings panels, and compact cross-platform app chrome for Windows, macOS, and Linux. Use this package to preserve that dense productivity surface rather than turning the system into a generic landing page.

## Visual Direction

The system uses compact app-shell layouts, source-backed green accents, neutral surfaces, preserved typography, and workflow-oriented copy. Keep future outputs dense, product-like, and grounded in captured evidence.
`;

const MARKDOWN_ONLY_AUDIT_SKILL = `# Cherry Studio Design System

Use this skill when creating Readable Studio artifacts that should match the Cherry Studio desktop AI chat workspace.

## Workflow

1. Read README.md, then DESIGN.md, and treat them as the source of truth.
2. Load colors_and_type.css for concrete tokens.
3. Inspect preview/ for focused review cards before inventing new styling.
4. Use ui_kits/app/ as the applied interface pattern for chat, assistant navigation, model controls, and composer surfaces.
5. Preserve source-backed assets and fonts from assets/ and fonts/.

## Output Rules

Keep layouts compact, app-like, and productivity-focused. Use real component states, avoid generic landing pages, and keep typography and spacing grounded in the captured evidence.
`;

const AUDIT_SKILL = `---
name: cherry-studio-design
description: Use this skill when creating Readable Studio artifacts that should match the Cherry Studio desktop AI chat workspace.
user-invocable: true
---

Read README.md, DESIGN.md, colors_and_type.css, the preview cards, preserved assets, build icons, fonts, source examples, and the modular UI kit before generating any new interface.

**What's inside:**
- Source-backed visual foundations, token CSS, assets, build icons, fonts, preview cards, source examples, and UI kit components.
- DESIGN.md as canonical rules and README.md as the package manifest.

**Source context:**
This design system is based on Cherry Studio source evidence captured from its repository and package assets. The source product is a desktop AI chat workspace with assistant navigation, model controls, chat surfaces, composer flows, and compact cross-platform app chrome.

**When to use this skill:**
- Creating source-backed Cherry Studio mockups, prototypes, or review artifacts.
- Designing new UI modules that need to match the extracted desktop app visual language.
- Building production-adjacent interfaces that should reuse preserved assets, fonts, and token CSS.

**How to use:**
Load colors_and_type.css, inspect preview/, reuse ui_kits/app/, and preserve compact app-like layouts grounded in the captured evidence instead of inventing a marketing page.

**Design system highlights:**
- Primary color: #00b96b with muted neutral surfaces.
- Typography: Ubuntu-backed sans family with compact app hierarchy.
- Layout: persistent sidebar, assistant rail, chat workspace, and composer.
- Interaction: subtle hover, active, focus, and disabled states for dense productivity UI.
`;

const SKILL_WITHOUT_REUSE_SECTIONS = `---
name: cherry-studio-design
description: Use this skill when creating Readable Studio artifacts that should match the Cherry Studio desktop AI chat workspace.
user-invocable: true
---

Read README.md, DESIGN.md, colors_and_type.css, the preview cards, preserved assets, fonts, and the modular UI kit before generating any new interface.

This package is intended for reusable Readable Studio work, so future agents should keep the output grounded in captured evidence, use preserved assets instead of redrawing brand marks, keep app surfaces compact, and inspect preview cards before introducing any new component pattern. Treat it as a focused product design kit, not a generic style summary.

**How to use:**
Load colors_and_type.css and inspect preview/ before creating new artifacts. Reuse ui_kits/app when composing product-like screens and check README.md plus DESIGN.md before making visual decisions.
`;

const AUDIT_UI_KIT_README = `# Cherry Studio UI Kit

This UI kit contains source-backed recreations of the Cherry Studio desktop AI chat workspace. Use it as the applied interface reference when composing future prototypes or review surfaces.

## Structure

- \`index.html\` - Complete applied chat workspace demo that loads token CSS and component modules.
- \`components/\` - Reusable React components:
  - \`App.jsx\` - Composes the whole product-like surface.
  - \`Sidebar.jsx\` - Left navigation/sidebar shell.
  - \`AssistantsList.jsx\` - Assistant or thread list rail.
  - \`ChatArea.jsx\` - Main conversation workspace.
  - \`InputBar.jsx\` - Message composer surface.
  - \`MessageBubble.jsx\` - Message and feedback card pattern.

## Usage

Open \`index.html\` to review the composed interface. Copy component JSX files into new prototypes, import \`../../colors_and_type.css\`, and compose the role components rather than rebuilding a generic static mock.

## Design Notes

Keep the layout compact and app-like: persistent sidebar, assistant rail, scrollable chat area, and composer. Colors, typography, spacing, radius, and states come from \`colors_and_type.css\`.

## Source

Based on the captured Cherry Studio source evidence and preserved package assets.
`;

const REFERENCE_AUDIT_SKILL = `---
name: cherry-studio-design
description: Use this skill to generate well-branded interfaces and assets for Cherry Studio prototypes and production-adjacent UI.
user-invocable: true
---

Read README.md, colors_and_type.css, the preview cards, preserved fonts, and the modular UI kit before generating any new interface. This frontmatter-first shape matches Claude Design exported packages, which may not include a top-level Markdown heading.

**What's inside:**
- Visual foundations for colors, typography, spacing, radius, shadows, and interaction states.
- CSS design tokens in colors_and_type.css.
- Preserved brand assets and fonts.
- Preview cards showing the complete design-system review surface.
- UI kit with modular components for shell, sidebar, chat surfaces, and composer flows.

**Source context:**
This design system is based on Cherry Studio source evidence and package assets. The product is a desktop AI chat application with assistant navigation, multi-model conversations, settings surfaces, and app-shell layouts.

**When to use this skill:**
- Generating Cherry Studio-aligned prototypes, mockups, and reviewable HTML artifacts.
- Building production-adjacent UI that should reuse the extracted visual language.
- Creating app-like surfaces that need the source-backed assets, fonts, and layout conventions.

**How to use:**
Copy assets, load the token CSS, inspect the preview cards, then compose new HTML or app UI from the modular kit. Keep generated surfaces compact, workspace-oriented, and grounded in the captured evidence instead of inventing a marketing page.

**Design system highlights:**
- Colors: source-backed green accent with light and dark theme surfaces.
- Typography: Ubuntu family with compact desktop app sizing.
- Spacing and radius: dense sidebar, list, chat, and composer rhythm.
- Icons and assets: preserved brand and runtime assets instead of redrawn placeholders.
`;

const UNBOUND_FONT_AUDIT_TOKENS_CSS = `:root {
  --cherry-bg: #f7f8fa;
  --cherry-surface: #ffffff;
  --cherry-surface-muted: #f1f3f5;
  --cherry-fg: #202124;
  --cherry-muted: #73777f;
  --cherry-border: #dfe3e8;
  --cherry-primary: #00b96b;
  --cherry-primary-hover: #00a862;
  --cherry-danger: #ef4444;
  --cherry-font-sans: Ubuntu, Inter, ui-sans-serif, system-ui, sans-serif;
  --cherry-font-mono: SFMono-Regular, ui-monospace, monospace;
  --cherry-radius-sm: 6px;
  --cherry-radius-md: 10px;
  --cherry-space-1: 4px;
  --cherry-space-2: 8px;
  --cherry-space-3: 12px;
  --cherry-space-4: 16px;
}
`;

const AUDIT_TOKENS_CSS = `@font-face {
  font-family: 'Ubuntu';
  src: url('./fonts/ubuntu/Ubuntu-Regular.ttf') format('truetype');
  font-weight: 400;
  font-style: normal;
}

${UNBOUND_FONT_AUDIT_TOKENS_CSS}`;

const AUDIT_COMPONENT_FILES = [
  'App.jsx',
  'Sidebar.jsx',
  'AssistantsList.jsx',
  'ChatArea.jsx',
  'InputBar.jsx',
  'MessageBubble.jsx',
];

function auditHtml(title: string): string {
  const cards = Array.from({ length: 8 }, (_, index) => `<article><h2>${title} ${index + 1}</h2><p>Source-backed review content for compact desktop app surfaces, component states, spacing, typography, and reusable product modules.</p><button>Review state</button></article>`).join('');
  const brandAssets = title === 'brand-assets.html'
    ? `
    <section class="brand-assets">
      <img src="../assets/logo.png" alt="Cherry Studio logo" />
      <img src="../build/icon.png" alt="Cherry Studio app icon" />
    </section>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { margin: 0; font-family: Ubuntu, Inter, sans-serif; background: #f7f8fa; color: #202124; }
    main { width: min(960px, calc(100vw - 48px)); margin: 40px auto; display: grid; gap: 16px; }
    article { border: 1px solid #dfe3e8; border-radius: 10px; background: #fff; padding: 16px; }
    .brand-assets { display: flex; gap: 16px; align-items: center; padding: 18px; background: #fff; border: 1px solid #dfe3e8; border-radius: 10px; }
    .brand-assets img { width: 72px; height: 72px; object-fit: contain; }
    button { border: 1px solid #00b96b; background: #00b96b; color: #fff; border-radius: 8px; padding: 8px 12px; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>A focused review card that preserves product density, component rhythm, and real source-backed design evidence.</p>
    ${brandAssets}
    ${cards}
  </main>
</body>
</html>
`;
}

function auditUiKitIndex(componentFiles: string[] = AUDIT_COMPONENT_FILES): string {
  const scripts = componentFiles
    .map((fileName) => `  <script type="text/babel" src="components/${fileName}"></script>`)
    .join('\n');
  const componentNames = componentFiles.map((fileName) => fileName.replace(/\.(jsx|tsx|js|ts|html)$/u, ''));
  const componentCards = componentNames
    .map((componentName) => `<article><h2>${componentName}</h2><p>${componentName} is loaded from ui_kits/app/components/${componentName}.jsx and composed into this applied interface kit.</p></article>`)
    .join('\n      ');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cherry Studio UI kit</title>
  <script src="https://unpkg.com/react@18.3.1/umd/react.development.js"></script>
  <script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js"></script>
  <script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js"></script>
  <link rel="stylesheet" href="../../colors_and_type.css" />
  <style>
    body { margin: 0; min-height: 100vh; font-family: var(--cherry-font-sans); background: var(--cherry-bg); color: var(--cherry-fg); }
    main { width: min(1120px, calc(100vw - 48px)); margin: 32px auto; display: grid; gap: 16px; grid-template-columns: 240px 1fr; }
    aside, section { border: 1px solid var(--cherry-border); border-radius: var(--cherry-radius-md); background: var(--cherry-surface); padding: var(--cherry-space-4); }
    article { border: 1px solid var(--cherry-border); border-radius: var(--cherry-radius-sm); background: var(--cherry-surface-muted); padding: var(--cherry-space-3); }
  </style>
</head>
<body>
  <div id="root"></div>
${scripts}
  <script type="text/babel">
    const { ${componentNames[0] ?? 'App'} } = window;
    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(<${componentNames[0] ?? 'App'} />);
  </script>
  <main>
    <aside><strong>Cherry Studio</strong><p>Loaded modular components: ${componentFiles.join(', ')}</p></aside>
    <section>
      <h1>Applied modular UI kit</h1>
      <p>This entry page loads the extracted token CSS and composes reusable component modules instead of standing alone as a generic mock.</p>
      ${componentCards}
    </section>
  </main>
</body>
</html>
`;
}

function auditComponent(componentName: string): string {
  return `const ${componentName}Items = [
  { id: 'primary', label: '${componentName} primary state', detail: 'Source-backed density, spacing, and active state.' },
  { id: 'secondary', label: '${componentName} secondary state', detail: 'Muted state with compact metadata and clear affordance.' },
  { id: 'review', label: '${componentName} review state', detail: 'Reusable review surface for future Readable Studio projects.' },
];

const ${componentName}Styles = {
  shell: { display: 'grid', gap: 12, padding: 16, border: '1px solid var(--cherry-border)', borderRadius: 12, background: 'var(--cherry-surface)' },
  header: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' },
  row: { display: 'grid', gap: 4, padding: '10px 12px', borderRadius: 10, background: 'var(--cherry-surface-muted)' },
  label: { fontWeight: 700, color: 'var(--cherry-fg)' },
  detail: { color: 'var(--cherry-muted)', fontSize: 13 },
  action: { border: '1px solid var(--cherry-primary)', background: 'var(--cherry-primary)', color: '#fff', borderRadius: 8, padding: '8px 10px' },
};

function ${componentName}({ title = '${componentName}', items = ${componentName}Items }) {
  return (
    <section style={${componentName}Styles.shell}>
      <header style={${componentName}Styles.header}>
        <strong>{title}</strong>
        <button type="button" style={${componentName}Styles.action}>Review</button>
      </header>
      {items.map((item) => (
        <article key={item.id} style={${componentName}Styles.row}>
          <span style={${componentName}Styles.label}>{item.label}</span>
          <span style={${componentName}Styles.detail}>{item.detail}</span>
        </article>
      ))}
    </section>
  );
}

window.${componentName} = ${componentName};
`;
}

function auditAppComponent(): string {
  return `const { Sidebar, AssistantsList, ChatArea } = window;

const appStyles = {
  container: {
    display: 'flex',
    width: '100%',
    minHeight: '720px',
    background: 'var(--cherry-bg)',
    color: 'var(--cherry-fg)'
  }
};

function App() {
  return (
    <div style={appStyles.container}>
      <Sidebar />
      <AssistantsList />
      <ChatArea />
    </div>
  );
}

window.App = App;
`;
}

function auditUiKitComponent(componentName: string): string {
  const baseName = componentName.replace(/\.(jsx|tsx|js|ts)$/u, '');
  return baseName === 'App' ? auditAppComponent() : auditComponent(baseName);
}

describe('design-system package audit', () => {
  let stdoutWrite: { mockRestore: () => void };
  let stderrWrite: { mockRestore: () => void };
  let stdoutOutput: string[];
  let stderrOutput: string[];
  let cwd: string;

  beforeEach(() => {
    cwd = process.cwd();
    stdoutOutput = [];
    stderrOutput = [];
    stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutOutput.push(String(chunk));
      return true;
    });
    stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrOutput.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
    process.chdir(cwd);
  });

  async function cleanupTempDir(tmpDir: string): Promise<void> {
    process.chdir(cwd);
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  it('passes a Claude Design-style design-system package audit', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'readable-package-audit-pass-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app'), { recursive: true });
    await mkdir(path.join(tmpDir, 'assets'), { recursive: true });
    await mkdir(path.join(tmpDir, 'build'), { recursive: true });
    await mkdir(path.join(tmpDir, 'fonts/ubuntu'), { recursive: true });
    await mkdir(path.join(tmpDir, 'context/local-code/cherry/files/src/components'), { recursive: true });
    await mkdir(path.join(tmpDir, 'context/local-code/cherry/files/src/pages/home'), { recursive: true });
    await mkdir(path.join(tmpDir, 'context/local-code/cherry/files/build'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), AUDIT_DESIGN_MD);
    await writeFile(path.join(tmpDir, 'README.md'), AUDIT_README);
    await writeFile(path.join(tmpDir, 'SKILL.md'), AUDIT_SKILL);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'typography-specimens.html',
      'spacing-tokens.html',
      'components-buttons.html',
      'brand-assets.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), auditUiKitIndex());
    await writeFile(path.join(tmpDir, 'ui_kits/app/README.md'), AUDIT_UI_KIT_README);
    await mkdir(path.join(tmpDir, 'ui_kits/app/components'), { recursive: true });
    for (const componentName of AUDIT_COMPONENT_FILES) {
      await writeFile(
        path.join(tmpDir, 'ui_kits/app/components', componentName),
        auditUiKitComponent(componentName),
      );
    }
    await writeFile(path.join(tmpDir, 'assets/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(tmpDir, 'build/icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(tmpDir, 'fonts/ubuntu/Ubuntu-Regular.ttf'), Buffer.from('font-data'));
    await writeFile(path.join(tmpDir, 'context/source-context.md'), [
      '# Design System Source Context',
      '',
      '## GitHub Repositories',
      '',
      '- None linked.',
      '',
      '## Local Code',
      '',
      'Linked folders readable by the local agent:',
      '- /tmp/cherry',
    ].join('\n'));
    await writeFile(path.join(tmpDir, 'context/local-code/cherry.md'), [
      '# Local Design Evidence: cherry',
      '',
      'Snapshot files written: 4',
      '',
      '### Brand assets and icons',
      '- assets/logo.png -> `context/local-code/cherry/files/assets/logo.png` (binary asset)',
      '- build/icon.png -> `context/local-code/cherry/files/build/icon.png` (binary asset)',
      '',
      '### Fonts',
      '- fonts/ubuntu/Ubuntu-Regular.ttf -> `context/local-code/cherry/files/fonts/ubuntu/Ubuntu-Regular.ttf` (binary asset)',
      '',
      '### Reusable components',
      '- src/components/Button.tsx -> `context/local-code/cherry/files/src/components/Button.tsx` (source)',
      '',
      '### Chat and input surfaces',
      '- src/pages/home/Chat.tsx -> `context/local-code/cherry/files/src/pages/home/Chat.tsx` (source)',
    ].join('\n'));
    await writeFile(path.join(tmpDir, 'context/local-code/cherry/files/src/tokens.css'), ':root { --color-primary: #00b96b; }');
    await writeFile(path.join(tmpDir, 'context/local-code/cherry/files/src/components/Button.tsx'), 'export function Button(){ return <button />; }');
    await writeFile(path.join(tmpDir, 'context/local-code/cherry/files/src/pages/home/Chat.tsx'), 'export function Chat(){ return <main><InputBar /><Messages /></main>; }');
    await writeFile(path.join(tmpDir, 'context/local-code/cherry/files/build/icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await runDesignSystemPackageAuditCli([ '--path', tmpDir]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdoutOutput.join(''))).toMatchObject({
      ok: true,
      errors: [],
    });

    await cleanupTempDir(tmpDir);
  });

  it('fails a design-system package audit when manifest docs point at old scaffold paths', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'readable-package-audit-stale-docs-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app/components'), { recursive: true });
    await mkdir(path.join(tmpDir, 'context/local-code/cherry/files/src/components'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), AUDIT_DESIGN_MD);
    await writeFile(
      path.join(tmpDir, 'README.md'),
      `${AUDIT_README}\n\nLegacy review paths still mention preview/typography-scale.html and ui_kits/generated_interface/index.html.\n`,
    );
    await writeFile(path.join(tmpDir, 'SKILL.md'), AUDIT_SKILL);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'typography-specimens.html',
      'spacing-tokens.html',
      'components-buttons.html',
      'brand-assets.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), auditUiKitIndex(['Foundation.jsx', 'Navigation.jsx', 'Workspace.jsx']));
    await writeFile(path.join(tmpDir, 'ui_kits/app/README.md'), '# UI kit\n\nUse ui_kits/app/index.html and role components.\n');
    for (const componentName of ['Foundation.jsx', 'Navigation.jsx', 'Workspace.jsx']) {
      await writeFile(
        path.join(tmpDir, 'ui_kits/app/components', componentName),
        auditUiKitComponent(componentName),
      );
    }
    await writeFile(path.join(tmpDir, 'context/source-context.md'), '# Design System Source Context\n\n## Local Code\n\n- /tmp/cherry\n');
    await writeFile(path.join(tmpDir, 'context/local-code/cherry.md'), [
      '# Local Design Evidence: cherry',
      '',
      'Snapshot files written: 1',
      '',
      '### Reusable components',
      '- src/components/Button.tsx -> `context/local-code/cherry/files/src/components/Button.tsx` (source)',
    ].join('\n'));
    await writeFile(path.join(tmpDir, 'context/local-code/cherry/files/src/components/Button.tsx'), 'export function Button(){ return <button />; }');

    const result = await runDesignSystemPackageAuditCli([ '--path', tmpDir]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(stdoutOutput.join('')).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'stale_package_manifest_references',
        path: 'README.md',
        message: expect.stringContaining('preview/typography-scale.html'),
      }),
    ]));

    await cleanupTempDir(tmpDir);
  });

  it('fails a design-system package audit when package titles come from URL protocol text', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'readable-package-audit-protocol-title-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), AUDIT_DESIGN_MD);
    await writeFile(path.join(tmpDir, 'README.md'), AUDIT_README.replace('# Cherry Studio Design System', '# https Design System'));
    await writeFile(path.join(tmpDir, 'SKILL.md'), AUDIT_SKILL);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'typography-specimens.html',
      'spacing-tokens.html',
      'components-buttons.html',
      'brand-assets.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), auditUiKitIndex());

    const result = await runDesignSystemPackageAuditCli([ '--path', tmpDir]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(stdoutOutput.join('')).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'protocol_derived_title',
        path: 'README.md',
        message: expect.stringContaining('URL protocol text'),
      }),
    ]));

    await cleanupTempDir(tmpDir);
  });

  it('warns when SKILL.md is missing agent-discoverable frontmatter', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'readable-package-audit-skill-frontmatter-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app/components'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), AUDIT_DESIGN_MD);
    await writeFile(path.join(tmpDir, 'README.md'), AUDIT_README);
    await writeFile(path.join(tmpDir, 'SKILL.md'), MARKDOWN_ONLY_AUDIT_SKILL);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'typography-specimens.html',
      'spacing-tokens.html',
      'components-buttons.html',
      'brand-assets.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), auditUiKitIndex());
    await writeFile(path.join(tmpDir, 'ui_kits/app/README.md'), '# UI kit\n');
    for (const componentName of AUDIT_COMPONENT_FILES) {
      await writeFile(
        path.join(tmpDir, 'ui_kits/app/components', componentName),
        auditUiKitComponent(componentName),
      );
    }

    const result = await runDesignSystemPackageAuditCli([ '--path', tmpDir]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdoutOutput.join('')).warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'missing_skill_frontmatter',
        path: 'SKILL.md',
        message: expect.stringContaining('YAML frontmatter'),
      }),
    ]));

    await cleanupTempDir(tmpDir);
  });

  it('warns when SKILL.md lacks Claude-style reusable skill sections', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'readable-package-audit-skill-sections-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app/components'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), AUDIT_DESIGN_MD);
    await writeFile(path.join(tmpDir, 'README.md'), AUDIT_README);
    await writeFile(path.join(tmpDir, 'SKILL.md'), SKILL_WITHOUT_REUSE_SECTIONS);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'typography-specimens.html',
      'spacing-tokens.html',
      'components-buttons.html',
      'brand-assets.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), auditUiKitIndex());
    await writeFile(path.join(tmpDir, 'ui_kits/app/README.md'), AUDIT_UI_KIT_README);
    for (const componentName of AUDIT_COMPONENT_FILES) {
      await writeFile(
        path.join(tmpDir, 'ui_kits/app/components', componentName),
        auditUiKitComponent(componentName),
      );
    }

    const result = await runDesignSystemPackageAuditCli([ '--path', tmpDir]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdoutOutput.join('')).warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'skill_missing_reuse_sections',
        path: 'SKILL.md',
        message: expect.stringContaining('reusable Claude Design skill package'),
      }),
    ]));

    await cleanupTempDir(tmpDir);
  });

  it('warns when README.md lacks a source-backed product overview', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'readable-package-audit-readme-overview-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app/components'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), AUDIT_DESIGN_MD);
    await writeFile(path.join(tmpDir, 'README.md'), README_WITHOUT_PRODUCT_OVERVIEW);
    await writeFile(path.join(tmpDir, 'SKILL.md'), AUDIT_SKILL);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'typography-specimens.html',
      'spacing-tokens.html',
      'components-buttons.html',
      'brand-assets.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), auditUiKitIndex());
    await writeFile(path.join(tmpDir, 'ui_kits/app/README.md'), '# UI kit\n');
    for (const componentName of AUDIT_COMPONENT_FILES) {
      await writeFile(
        path.join(tmpDir, 'ui_kits/app/components', componentName),
        auditUiKitComponent(componentName),
      );
    }

    const result = await runDesignSystemPackageAuditCli([ '--path', tmpDir]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdoutOutput.join('')).warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'readme_missing_product_overview',
        path: 'README.md',
        message: expect.stringContaining('Product Overview'),
      }),
    ]));

    await cleanupTempDir(tmpDir);
  });

  it('warns when README.md lacks a Claude-style package reuse guide', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'readable-package-audit-readme-package-guide-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app/components'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), AUDIT_DESIGN_MD);
    await writeFile(path.join(tmpDir, 'README.md'), README_WITHOUT_PACKAGE_REUSE_GUIDE);
    await writeFile(path.join(tmpDir, 'SKILL.md'), AUDIT_SKILL);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'typography-specimens.html',
      'spacing-tokens.html',
      'components-buttons.html',
      'brand-assets.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), auditUiKitIndex());
    await writeFile(path.join(tmpDir, 'ui_kits/app/README.md'), AUDIT_UI_KIT_README);
    for (const componentName of AUDIT_COMPONENT_FILES) {
      await writeFile(
        path.join(tmpDir, 'ui_kits/app/components', componentName),
        auditUiKitComponent(componentName),
      );
    }

    const result = await runDesignSystemPackageAuditCli([ '--path', tmpDir]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdoutOutput.join('')).warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'readme_missing_package_reuse_guide',
        path: 'README.md',
        message: expect.stringContaining('Claude Design package guide'),
      }),
    ]));

    await cleanupTempDir(tmpDir);
  });

  it('warns when README.md lacks a concrete preview manifest', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'readable-package-audit-readme-preview-manifest-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app/components'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), AUDIT_DESIGN_MD);
    await writeFile(path.join(tmpDir, 'README.md'), README_WITHOUT_PREVIEW_MANIFEST);
    await writeFile(path.join(tmpDir, 'SKILL.md'), AUDIT_SKILL);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'typography-specimens.html',
      'spacing-tokens.html',
      'components-buttons.html',
      'brand-assets.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), auditUiKitIndex());
    await writeFile(path.join(tmpDir, 'ui_kits/app/README.md'), AUDIT_UI_KIT_README);
    for (const componentName of AUDIT_COMPONENT_FILES) {
      await writeFile(
        path.join(tmpDir, 'ui_kits/app/components', componentName),
        auditUiKitComponent(componentName),
      );
    }

    const result = await runDesignSystemPackageAuditCli([ '--path', tmpDir]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdoutOutput.join('')).warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'readme_missing_preview_manifest',
        path: 'README.md',
        message: expect.stringContaining('concrete preview manifest'),
      }),
    ]));

    await cleanupTempDir(tmpDir);
  });

  it('warns when the applied UI-kit README lacks a reuse guide', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'readable-package-audit-uikit-readme-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app/components'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), AUDIT_DESIGN_MD);
    await writeFile(path.join(tmpDir, 'README.md'), AUDIT_README);
    await writeFile(path.join(tmpDir, 'SKILL.md'), AUDIT_SKILL);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'typography-specimens.html',
      'spacing-tokens.html',
      'components-buttons.html',
      'brand-assets.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), auditUiKitIndex());
    await writeFile(
      path.join(tmpDir, 'ui_kits/app/README.md'),
      '# UI kit\n\nThis package was migrated from an earlier workspace. Use index.html as the applied interface example.\n',
    );
    for (const componentName of AUDIT_COMPONENT_FILES) {
      await writeFile(
        path.join(tmpDir, 'ui_kits/app/components', componentName),
        auditUiKitComponent(componentName),
      );
    }

    const result = await runDesignSystemPackageAuditCli([ '--path', tmpDir]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdoutOutput.join('')).warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'ui_kit_readme_missing_reuse_guide',
        path: 'ui_kits/app/README.md',
        message: expect.stringContaining('usage workflow'),
      }),
    ]));

    await cleanupTempDir(tmpDir);
  });

  it('warns when build runtime icon evidence is not preserved in the package', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'readable-package-audit-build-assets-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app/components'), { recursive: true });
    await mkdir(path.join(tmpDir, 'assets'), { recursive: true });
    await mkdir(path.join(tmpDir, 'context/local-code/cherry/files/build'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), AUDIT_DESIGN_MD);
    await writeFile(path.join(tmpDir, 'README.md'), AUDIT_README);
    await writeFile(path.join(tmpDir, 'SKILL.md'), AUDIT_SKILL);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'typography-specimens.html',
      'spacing-tokens.html',
      'components-buttons.html',
      'brand-assets.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), auditUiKitIndex());
    await writeFile(path.join(tmpDir, 'ui_kits/app/README.md'), '# UI kit\n');
    for (const componentName of AUDIT_COMPONENT_FILES) {
      await writeFile(
        path.join(tmpDir, 'ui_kits/app/components', componentName),
        auditUiKitComponent(componentName),
      );
    }
    await writeFile(path.join(tmpDir, 'assets/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(tmpDir, 'context/source-context.md'), '# Design System Source Context\n\n## Local Code\n\n- /tmp/cherry\n');
    await writeFile(path.join(tmpDir, 'context/local-code/cherry.md'), [
      '# Local Design Evidence: cherry',
      '',
      'Snapshot files written: 2',
      '',
      '### Brand assets and icons',
      '- build/icon.ico -> `context/local-code/cherry/files/build/icon.ico` (binary asset)',
      '- build/tray_icon.png -> `context/local-code/cherry/files/build/tray_icon.png` (binary asset)',
    ].join('\n'));
    await writeFile(path.join(tmpDir, 'context/local-code/cherry/files/build/icon.ico'), Buffer.from([0x00, 0x00, 0x01, 0x00]));
    await writeFile(path.join(tmpDir, 'context/local-code/cherry/files/build/tray_icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await runDesignSystemPackageAuditCli([ '--path', tmpDir]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdoutOutput.join('')).warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'missing_build_assets',
        path: 'build/',
        message: expect.stringContaining('build/runtime icon asset'),
      }),
    ]));

    await cleanupTempDir(tmpDir);
  });

  it('warns when preserved build runtime assets do not match captured evidence bytes', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'readable-package-audit-fake-build-assets-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app/components'), { recursive: true });
    await mkdir(path.join(tmpDir, 'assets'), { recursive: true });
    await mkdir(path.join(tmpDir, 'build'), { recursive: true });
    await mkdir(path.join(tmpDir, 'context/local-code/cherry/files/build'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), AUDIT_DESIGN_MD);
    await writeFile(path.join(tmpDir, 'README.md'), AUDIT_README);
    await writeFile(path.join(tmpDir, 'SKILL.md'), AUDIT_SKILL);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'typography-specimens.html',
      'spacing-tokens.html',
      'components-buttons.html',
      'brand-assets.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), auditUiKitIndex());
    await writeFile(path.join(tmpDir, 'ui_kits/app/README.md'), '# UI kit\n');
    for (const componentName of AUDIT_COMPONENT_FILES) {
      await writeFile(
        path.join(tmpDir, 'ui_kits/app/components', componentName),
        auditUiKitComponent(componentName),
      );
    }
    await writeFile(path.join(tmpDir, 'assets/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(tmpDir, 'build/icon.png'), Buffer.from('redrawn-icon'));
    await writeFile(path.join(tmpDir, 'build/tray_icon.png'), Buffer.from('redrawn-tray'));
    await writeFile(path.join(tmpDir, 'context/source-context.md'), '# Design System Source Context\n\n## Local Code\n\n- /tmp/cherry\n');
    await writeFile(path.join(tmpDir, 'context/local-code/cherry.md'), [
      '# Local Design Evidence: cherry',
      '',
      'Snapshot files written: 2',
      '',
      '### Brand assets and icons',
      '- build/icon.png -> `context/local-code/cherry/files/build/icon.png` (binary asset)',
      '- build/tray_icon.png -> `context/local-code/cherry/files/build/tray_icon.png` (binary asset)',
    ].join('\n'));
    await writeFile(path.join(tmpDir, 'context/local-code/cherry/files/build/icon.png'), Buffer.from('source-icon'));
    await writeFile(path.join(tmpDir, 'context/local-code/cherry/files/build/tray_icon.png'), Buffer.from('source-tray'));

    const result = await runDesignSystemPackageAuditCli([ '--path', tmpDir]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdoutOutput.join('')).warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'build_assets_not_source_backed',
        path: 'build/',
        message: expect.stringContaining('byte-for-byte'),
      }),
    ]));

    await cleanupTempDir(tmpDir);
  });

  it('accepts preserved build runtime assets that match captured evidence bytes', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'readable-package-audit-source-build-assets-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app/components'), { recursive: true });
    await mkdir(path.join(tmpDir, 'assets'), { recursive: true });
    await mkdir(path.join(tmpDir, 'build'), { recursive: true });
    await mkdir(path.join(tmpDir, 'context/local-code/cherry/files/build'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), AUDIT_DESIGN_MD);
    await writeFile(path.join(tmpDir, 'README.md'), AUDIT_README);
    await writeFile(path.join(tmpDir, 'SKILL.md'), AUDIT_SKILL);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'typography-specimens.html',
      'spacing-tokens.html',
      'components-buttons.html',
      'brand-assets.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), auditUiKitIndex());
    await writeFile(path.join(tmpDir, 'ui_kits/app/README.md'), '# UI kit\n');
    for (const componentName of AUDIT_COMPONENT_FILES) {
      await writeFile(
        path.join(tmpDir, 'ui_kits/app/components', componentName),
        auditUiKitComponent(componentName),
      );
    }
    const sourceIcon = Buffer.from('source-icon');
    const sourceTray = Buffer.from('source-tray');
    await writeFile(path.join(tmpDir, 'assets/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(tmpDir, 'build/icon.png'), sourceIcon);
    await writeFile(path.join(tmpDir, 'build/tray_icon.png'), sourceTray);
    await writeFile(path.join(tmpDir, 'context/source-context.md'), '# Design System Source Context\n\n## Local Code\n\n- /tmp/cherry\n');
    await writeFile(path.join(tmpDir, 'context/local-code/cherry.md'), [
      '# Local Design Evidence: cherry',
      '',
      'Snapshot files written: 2',
      '',
      '### Brand assets and icons',
      '- build/icon.png -> `context/local-code/cherry/files/build/icon.png` (binary asset)',
      '- build/tray_icon.png -> `context/local-code/cherry/files/build/tray_icon.png` (binary asset)',
    ].join('\n'));
    await writeFile(path.join(tmpDir, 'context/local-code/cherry/files/build/icon.png'), sourceIcon);
    await writeFile(path.join(tmpDir, 'context/local-code/cherry/files/build/tray_icon.png'), sourceTray);

    const result = await runDesignSystemPackageAuditCli([ '--path', tmpDir]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdoutOutput.join('')).warnings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'build_assets_not_source_backed',
      }),
    ]));

    await cleanupTempDir(tmpDir);
  });

  it('warns when the brand-assets preview redraws instead of referencing preserved assets', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'readable-package-audit-brand-preview-assets-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app/components'), { recursive: true });
    await mkdir(path.join(tmpDir, 'assets'), { recursive: true });
    await mkdir(path.join(tmpDir, 'build'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), AUDIT_DESIGN_MD);
    await writeFile(path.join(tmpDir, 'README.md'), AUDIT_README);
    await writeFile(path.join(tmpDir, 'SKILL.md'), AUDIT_SKILL);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'typography-specimens.html',
      'spacing-tokens.html',
      'components-buttons.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    await writeFile(path.join(tmpDir, 'preview/brand-assets.html'), auditHtml('redrawn-brand-assets'));
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), auditUiKitIndex());
    await writeFile(path.join(tmpDir, 'ui_kits/app/README.md'), '# UI kit\n');
    for (const componentName of AUDIT_COMPONENT_FILES) {
      await writeFile(
        path.join(tmpDir, 'ui_kits/app/components', componentName),
        auditUiKitComponent(componentName),
      );
    }
    await writeFile(path.join(tmpDir, 'assets/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(tmpDir, 'build/icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await runDesignSystemPackageAuditCli([ '--path', tmpDir]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdoutOutput.join('')).warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'brand_assets_preview_not_using_preserved_assets',
        path: 'preview/brand-assets.html',
        message: expect.stringContaining('real logos/icons'),
      }),
    ]));

    await cleanupTempDir(tmpDir);
  });

  it('fails a design-system package audit when modular UI-kit components are placeholders', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'readable-package-audit-thin-components-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app/components'), { recursive: true });
    await mkdir(path.join(tmpDir, 'context/local-code/cherry/files/src/components'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), AUDIT_DESIGN_MD);
    await writeFile(path.join(tmpDir, 'README.md'), AUDIT_README);
    await writeFile(path.join(tmpDir, 'SKILL.md'), AUDIT_SKILL);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'typography-specimens.html',
      'spacing-tokens.html',
      'components-buttons.html',
      'brand-assets.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), auditUiKitIndex(['App.jsx', 'Sidebar.jsx', 'ChatArea.jsx']));
    await writeFile(path.join(tmpDir, 'ui_kits/app/README.md'), '# UI kit\n');
    for (const componentName of ['App.jsx', 'Sidebar.jsx', 'ChatArea.jsx']) {
      await writeFile(
        path.join(tmpDir, 'ui_kits/app/components', componentName),
        `export function ${componentName.replace(/\.jsx$/u, '')}(){ return <section>${componentName}</section>; }\n`,
      );
    }
    await writeFile(path.join(tmpDir, 'context/source-context.md'), '# Design System Source Context\n\n## Local Code\n\n- /tmp/cherry\n');
    await writeFile(path.join(tmpDir, 'context/local-code/cherry.md'), [
      '# Local Design Evidence: cherry',
      '',
      'Snapshot files written: 1',
      '',
      '### Reusable components',
      '- src/components/Button.tsx -> `context/local-code/cherry/files/src/components/Button.tsx` (source)',
    ].join('\n'));
    await writeFile(path.join(tmpDir, 'context/local-code/cherry/files/src/components/Button.tsx'), 'export function Button(){ return <button />; }');

    const result = await runDesignSystemPackageAuditCli([ '--path', tmpDir]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(stdoutOutput.join('')).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'thin_modular_ui_kit', path: 'ui_kits/app/components/' }),
    ]));

    await cleanupTempDir(tmpDir);
  });

  it('fails a design-system package audit when the UI-kit entry does not load its modules or token CSS', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'readable-package-audit-disconnected-uikit-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app/components'), { recursive: true });
    await mkdir(path.join(tmpDir, 'context/local-code/cherry/files/src/components'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), AUDIT_DESIGN_MD);
    await writeFile(path.join(tmpDir, 'README.md'), AUDIT_README);
    await writeFile(path.join(tmpDir, 'SKILL.md'), AUDIT_SKILL);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'typography-specimens.html',
      'spacing-tokens.html',
      'components-buttons.html',
      'brand-assets.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), auditHtml('Disconnected UI kit'));
    await writeFile(path.join(tmpDir, 'ui_kits/app/README.md'), '# UI kit\n');
    for (const componentName of ['Foundation.jsx', 'Navigation.jsx', 'Workspace.jsx']) {
      await writeFile(
        path.join(tmpDir, 'ui_kits/app/components', componentName),
        auditUiKitComponent(componentName),
      );
    }
    await writeFile(path.join(tmpDir, 'context/source-context.md'), '# Design System Source Context\n\n## Local Code\n\n- /tmp/cherry\n');
    await writeFile(path.join(tmpDir, 'context/local-code/cherry.md'), [
      '# Local Design Evidence: cherry',
      '',
      'Snapshot files written: 1',
      '',
      '### Reusable components',
      '- src/components/Button.tsx -> `context/local-code/cherry/files/src/components/Button.tsx` (source)',
    ].join('\n'));
    await writeFile(path.join(tmpDir, 'context/local-code/cherry/files/src/components/Button.tsx'), 'export function Button(){ return <button />; }');

    const result = await runDesignSystemPackageAuditCli([ '--path', tmpDir]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(stdoutOutput.join('')).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ui_kit_missing_token_stylesheet', path: 'ui_kits/app/index.html' }),
      expect.objectContaining({ code: 'ui_kit_index_missing_component_references', path: 'ui_kits/app/index.html' }),
    ]));

    await cleanupTempDir(tmpDir);
  });

  it('fails a design-system package audit when the UI-kit entry lists modules without rendering them', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'readable-package-audit-unmounted-uikit-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app/components'), { recursive: true });
    await mkdir(path.join(tmpDir, 'context/local-code/cherry/files/src/components'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), AUDIT_DESIGN_MD);
    await writeFile(path.join(tmpDir, 'README.md'), AUDIT_README);
    await writeFile(path.join(tmpDir, 'SKILL.md'), AUDIT_SKILL);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'typography-specimens.html',
      'spacing-tokens.html',
      'components-buttons.html',
      'brand-assets.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), [
      '<!doctype html><html><head>',
      '<link rel="stylesheet" href="../../colors_and_type.css" />',
      '</head><body><main><h1>Disconnected module list</h1></main>',
      '<script type="text/babel" src="components/Foundation.jsx"></script>',
      '<script type="text/babel" src="components/Navigation.jsx"></script>',
      '<script type="text/babel" src="components/Workspace.jsx"></script>',
      '</body></html>',
    ].join('\n'));
    await writeFile(path.join(tmpDir, 'ui_kits/app/README.md'), '# UI kit\n');
    for (const componentName of ['Foundation.jsx', 'Navigation.jsx', 'Workspace.jsx']) {
      await writeFile(
        path.join(tmpDir, 'ui_kits/app/components', componentName),
        auditUiKitComponent(componentName),
      );
    }
    await writeFile(path.join(tmpDir, 'context/source-context.md'), '# Design System Source Context\n\n## Local Code\n\n- /tmp/cherry\n');
    await writeFile(path.join(tmpDir, 'context/local-code/cherry.md'), [
      '# Local Design Evidence: cherry',
      '',
      'Snapshot files written: 1',
      '',
      '### Reusable components',
      '- src/components/Button.tsx -> `context/local-code/cherry/files/src/components/Button.tsx` (source)',
    ].join('\n'));
    await writeFile(path.join(tmpDir, 'context/local-code/cherry/files/src/components/Button.tsx'), 'export function Button(){ return <button />; }');

    const result = await runDesignSystemPackageAuditCli([ '--path', tmpDir]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(stdoutOutput.join('')).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ui_kit_index_missing_runtime_bootstrap', path: 'ui_kits/app/index.html' }),
      expect.objectContaining({ code: 'ui_kit_index_missing_component_composition', path: 'ui_kits/app/index.html' }),
    ]));

    await cleanupTempDir(tmpDir);
  });

  it('fails a design-system package audit when JSX components are loaded without browser runtime scripts', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'readable-package-audit-missing-jsx-runtime-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app/components'), { recursive: true });
    await mkdir(path.join(tmpDir, 'context/local-code/cherry/files/src/pages/home'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), AUDIT_DESIGN_MD);
    await writeFile(path.join(tmpDir, 'README.md'), AUDIT_README);
    await writeFile(path.join(tmpDir, 'SKILL.md'), AUDIT_SKILL);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'typography-specimens.html',
      'spacing-tokens.html',
      'components-buttons.html',
      'brand-assets.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), [
      '<!doctype html><html><head>',
      '<link rel="stylesheet" href="../../colors_and_type.css" />',
      '</head><body><div id="root"></div>',
      '<script type="text/babel" src="components/Sidebar.jsx"></script>',
      '<script type="text/babel" src="components/AssistantsList.jsx"></script>',
      '<script type="text/babel" src="components/ChatArea.jsx"></script>',
      '<script type="text/babel" src="components/InputBar.jsx"></script>',
      '<script type="text/babel" src="components/MessageBubble.jsx"></script>',
      '<script type="text/babel" src="components/App.jsx"></script>',
      '<script type="text/babel">const { App } = window; const root = ReactDOM.createRoot(document.getElementById("root")); root.render(<App />);</script>',
      '</body></html>',
    ].join('\n'));
    await writeFile(path.join(tmpDir, 'ui_kits/app/README.md'), '# UI kit\n');
    for (const componentName of AUDIT_COMPONENT_FILES) {
      await writeFile(
        path.join(tmpDir, 'ui_kits/app/components', componentName),
        auditUiKitComponent(componentName),
      );
    }
    await writeFile(path.join(tmpDir, 'context/source-context.md'), '# Design System Source Context\n\n## Local Code\n\n- /tmp/cherry\n');
    await writeFile(path.join(tmpDir, 'context/local-code/cherry.md'), [
      '# Local Design Evidence: cherry',
      '',
      'Snapshot files written: 1',
      '',
      '### Chat and input surfaces',
      '- src/pages/home/Chat.tsx -> `context/local-code/cherry/files/src/pages/home/Chat.tsx` (source)',
    ].join('\n'));
    await writeFile(path.join(tmpDir, 'context/local-code/cherry/files/src/pages/home/Chat.tsx'), 'export function Chat(){ return <main><InputBar /><Messages /></main>; }');

    const result = await runDesignSystemPackageAuditCli([ '--path', tmpDir]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(stdoutOutput.join('')).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'ui_kit_index_missing_jsx_runtime',
        path: 'ui_kits/app/index.html',
      }),
    ]));

    await cleanupTempDir(tmpDir);
  });

  it('fails a design-system package audit when script-loaded JSX components do not expose browser globals', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'readable-package-audit-missing-browser-global-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app/components'), { recursive: true });
    await mkdir(path.join(tmpDir, 'context/local-code/cherry/files/src/pages/home'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), AUDIT_DESIGN_MD);
    await writeFile(path.join(tmpDir, 'README.md'), AUDIT_README);
    await writeFile(path.join(tmpDir, 'SKILL.md'), AUDIT_SKILL);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'typography-specimens.html',
      'spacing-tokens.html',
      'components-buttons.html',
      'brand-assets.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), auditUiKitIndex());
    await writeFile(path.join(tmpDir, 'ui_kits/app/README.md'), '# UI kit\n');
    for (const componentName of AUDIT_COMPONENT_FILES) {
      await writeFile(
        path.join(tmpDir, 'ui_kits/app/components', componentName),
        componentName === 'Sidebar.jsx'
          ? 'function Sidebar(){ return <aside>Sidebar</aside>; }\n'
          : auditUiKitComponent(componentName),
      );
    }
    await writeFile(path.join(tmpDir, 'context/source-context.md'), '# Design System Source Context\n\n## Local Code\n\n- /tmp/cherry\n');
    await writeFile(path.join(tmpDir, 'context/local-code/cherry.md'), [
      '# Local Design Evidence: cherry',
      '',
      'Snapshot files written: 1',
      '',
      '### Chat and input surfaces',
      '- src/pages/home/Chat.tsx -> `context/local-code/cherry/files/src/pages/home/Chat.tsx` (source)',
    ].join('\n'));
    await writeFile(path.join(tmpDir, 'context/local-code/cherry/files/src/pages/home/Chat.tsx'), 'export function Chat(){ return <main><InputBar /><Messages /></main>; }');

    const result = await runDesignSystemPackageAuditCli([ '--path', tmpDir]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(stdoutOutput.join('')).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'ui_kit_component_missing_browser_global',
        path: 'ui_kits/app/components/Sidebar.jsx',
        message: expect.stringContaining('window.Sidebar'),
      }),
    ]));

    await cleanupTempDir(tmpDir);
  });

  it('fails a design-system package audit when chat evidence lacks UI-kit role coverage', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'readable-package-audit-missing-roles-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app/components'), { recursive: true });
    await mkdir(path.join(tmpDir, 'assets'), { recursive: true });
    await mkdir(path.join(tmpDir, 'fonts/ubuntu'), { recursive: true });
    await mkdir(path.join(tmpDir, 'context/local-code/cherry/files/src/pages/home'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), AUDIT_DESIGN_MD);
    await writeFile(path.join(tmpDir, 'README.md'), AUDIT_README);
    await writeFile(path.join(tmpDir, 'SKILL.md'), AUDIT_SKILL);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'typography-specimens.html',
      'spacing-tokens.html',
      'components-buttons.html',
      'brand-assets.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), auditUiKitIndex(['App.jsx', 'Sidebar.jsx', 'ChatArea.jsx']));
    await writeFile(path.join(tmpDir, 'ui_kits/app/README.md'), '# UI kit\n');
    for (const componentName of ['App.jsx', 'Sidebar.jsx', 'ChatArea.jsx']) {
      await writeFile(
        path.join(tmpDir, 'ui_kits/app/components', componentName),
        auditUiKitComponent(componentName),
      );
    }
    await writeFile(path.join(tmpDir, 'assets/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(tmpDir, 'fonts/ubuntu/Ubuntu-Regular.ttf'), Buffer.from('font-data'));
    await writeFile(path.join(tmpDir, 'context/source-context.md'), '# Design System Source Context\n\n## Local Code\n\n- /tmp/cherry\n');
    await writeFile(path.join(tmpDir, 'context/local-code/cherry.md'), [
      '# Local Design Evidence: cherry',
      '',
      'Snapshot files written: 1',
      '',
      '### Chat and input surfaces',
      '- src/pages/home/Chat.tsx -> `context/local-code/cherry/files/src/pages/home/Chat.tsx` (source)',
    ].join('\n'));
    await writeFile(path.join(tmpDir, 'context/local-code/cherry/files/src/pages/home/Chat.tsx'), 'export function Chat(){ return <main><InputBar /><Messages /></main>; }');

    const result = await runDesignSystemPackageAuditCli([ '--path', tmpDir]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(stdoutOutput.join('')).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'missing_ui_kit_component_roles',
        path: 'ui_kits/app/components/',
        message: expect.stringContaining('assistant/list rail'),
      }),
    ]));

    await cleanupTempDir(tmpDir);
  });

  it('fails a design-system package audit when the app shell does not compose role components', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'readable-package-audit-uncomposed-app-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app/components'), { recursive: true });
    await mkdir(path.join(tmpDir, 'context/local-code/cherry/files/src/pages/home'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), AUDIT_DESIGN_MD);
    await writeFile(path.join(tmpDir, 'README.md'), AUDIT_README);
    await writeFile(path.join(tmpDir, 'SKILL.md'), AUDIT_SKILL);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'typography-specimens.html',
      'spacing-tokens.html',
      'components-buttons.html',
      'brand-assets.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), auditUiKitIndex());
    await writeFile(path.join(tmpDir, 'ui_kits/app/README.md'), '# UI kit\n');
    for (const componentName of AUDIT_COMPONENT_FILES) {
      await writeFile(
        path.join(tmpDir, 'ui_kits/app/components', componentName),
        componentName === 'App.jsx' ? auditComponent('App') : auditUiKitComponent(componentName),
      );
    }
    await writeFile(path.join(tmpDir, 'context/source-context.md'), '# Design System Source Context\n\n## Local Code\n\n- /tmp/cherry\n');
    await writeFile(path.join(tmpDir, 'context/local-code/cherry.md'), [
      '# Local Design Evidence: cherry',
      '',
      'Snapshot files written: 1',
      '',
      '### Chat and input surfaces',
      '- src/pages/home/Chat.tsx -> `context/local-code/cherry/files/src/pages/home/Chat.tsx` (source)',
    ].join('\n'));
    await writeFile(path.join(tmpDir, 'context/local-code/cherry/files/src/pages/home/Chat.tsx'), 'export function Chat(){ return <main><InputBar /><Messages /></main>; }');

    const result = await runDesignSystemPackageAuditCli([ '--path', tmpDir]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(stdoutOutput.join('')).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'ui_kit_app_missing_role_composition',
        path: 'ui_kits/app/components/App.jsx',
        message: expect.stringContaining('Sidebar, AssistantsList, ChatArea'),
      }),
    ]));

    await cleanupTempDir(tmpDir);
  });

  it('fails a design-system package audit when rich binary evidence is collapsed to one asset and font', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'readable-package-audit-thin-binaries-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app/components'), { recursive: true });
    await mkdir(path.join(tmpDir, 'assets'), { recursive: true });
    await mkdir(path.join(tmpDir, 'fonts/ubuntu'), { recursive: true });
    await mkdir(path.join(tmpDir, 'context/local-code/cherry/files/build'), { recursive: true });
    await mkdir(path.join(tmpDir, 'context/local-code/cherry/files/src/assets/fonts/ubuntu'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), AUDIT_DESIGN_MD);
    await writeFile(path.join(tmpDir, 'README.md'), AUDIT_README);
    await writeFile(path.join(tmpDir, 'SKILL.md'), AUDIT_SKILL);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'typography-specimens.html',
      'spacing-tokens.html',
      'components-buttons.html',
      'brand-assets.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), auditUiKitIndex());
    await writeFile(path.join(tmpDir, 'ui_kits/app/README.md'), '# UI kit\n');
    for (const componentName of AUDIT_COMPONENT_FILES) {
      await writeFile(
        path.join(tmpDir, 'ui_kits/app/components', componentName),
        auditUiKitComponent(componentName),
      );
    }
    await writeFile(path.join(tmpDir, 'assets/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(tmpDir, 'fonts/ubuntu/Ubuntu-Regular.ttf'), Buffer.from('font-data'));
    for (const fileName of ['icon.png', 'logo.png', 'tray_icon.png']) {
      await writeFile(path.join(tmpDir, 'context/local-code/cherry/files/build', fileName), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }
    for (const fileName of ['Ubuntu-Regular.ttf', 'Ubuntu-Medium.ttf', 'Ubuntu-Bold.ttf']) {
      await writeFile(path.join(tmpDir, 'context/local-code/cherry/files/src/assets/fonts/ubuntu', fileName), Buffer.from('font-data'));
    }
    await writeFile(path.join(tmpDir, 'context/source-context.md'), '# Design System Source Context\n\n## Local Code\n\n- /tmp/cherry\n');
    await writeFile(path.join(tmpDir, 'context/local-code/cherry.md'), [
      '# Local Design Evidence: cherry',
      '',
      'Snapshot files written: 6',
      '',
      '### Brand assets and icons',
      '- build/icon.png -> `context/local-code/cherry/files/build/icon.png` (binary asset)',
      '- build/logo.png -> `context/local-code/cherry/files/build/logo.png` (binary asset)',
      '- build/tray_icon.png -> `context/local-code/cherry/files/build/tray_icon.png` (binary asset)',
      '',
      '### Fonts',
      '- src/assets/fonts/ubuntu/Ubuntu-Regular.ttf -> `context/local-code/cherry/files/src/assets/fonts/ubuntu/Ubuntu-Regular.ttf` (binary asset)',
      '- src/assets/fonts/ubuntu/Ubuntu-Medium.ttf -> `context/local-code/cherry/files/src/assets/fonts/ubuntu/Ubuntu-Medium.ttf` (binary asset)',
      '- src/assets/fonts/ubuntu/Ubuntu-Bold.ttf -> `context/local-code/cherry/files/src/assets/fonts/ubuntu/Ubuntu-Bold.ttf` (binary asset)',
    ].join('\n'));

    const result = await runDesignSystemPackageAuditCli([ '--path', tmpDir]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(stdoutOutput.join('')).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'insufficient_preserved_assets', path: 'assets/' }),
      expect.objectContaining({ code: 'insufficient_preserved_fonts', path: 'fonts/' }),
    ]));

    await cleanupTempDir(tmpDir);
  });

  it('fails a design-system package audit when preserved fonts are not bound in token CSS', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'readable-package-audit-font-binding-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app/components'), { recursive: true });
    await mkdir(path.join(tmpDir, 'fonts/ubuntu'), { recursive: true });
    await mkdir(path.join(tmpDir, 'context/local-code/cherry/files/fonts/ubuntu'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), AUDIT_DESIGN_MD);
    await writeFile(path.join(tmpDir, 'README.md'), AUDIT_README);
    await writeFile(path.join(tmpDir, 'SKILL.md'), AUDIT_SKILL);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), UNBOUND_FONT_AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'typography-specimens.html',
      'spacing-tokens.html',
      'components-buttons.html',
      'brand-assets.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), auditUiKitIndex());
    await writeFile(path.join(tmpDir, 'ui_kits/app/README.md'), '# UI kit\n');
    for (const componentName of AUDIT_COMPONENT_FILES) {
      await writeFile(
        path.join(tmpDir, 'ui_kits/app/components', componentName),
        auditUiKitComponent(componentName),
      );
    }
    await writeFile(path.join(tmpDir, 'fonts/ubuntu/Ubuntu-Regular.ttf'), Buffer.from('font-data'));
    await writeFile(path.join(tmpDir, 'context/local-code/cherry/files/fonts/ubuntu/Ubuntu-Regular.ttf'), Buffer.from('font-data'));
    await writeFile(path.join(tmpDir, 'context/source-context.md'), '# Design System Source Context\n\n## Local Code\n\n- /tmp/cherry\n');
    await writeFile(path.join(tmpDir, 'context/local-code/cherry.md'), [
      '# Local Design Evidence: cherry',
      '',
      'Snapshot files written: 1',
      '',
      '### Fonts',
      '- fonts/ubuntu/Ubuntu-Regular.ttf -> `context/local-code/cherry/files/fonts/ubuntu/Ubuntu-Regular.ttf` (binary asset)',
    ].join('\n'));

    const result = await runDesignSystemPackageAuditCli([ '--path', tmpDir]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(stdoutOutput.join('')).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'font_tokens_not_bound',
        path: 'colors_and_type.css',
        message: expect.stringContaining('does not bind them'),
      }),
    ]));

    await cleanupTempDir(tmpDir);
  });

  it('warns when visual artifacts do not reference source-backed component names', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'readable-package-audit-generic-visuals-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app/components'), { recursive: true });
    await mkdir(path.join(tmpDir, 'context/local-code/cherry/files/src/components'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), AUDIT_DESIGN_MD);
    await writeFile(path.join(tmpDir, 'README.md'), AUDIT_README);
    await writeFile(path.join(tmpDir, 'SKILL.md'), AUDIT_SKILL);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'typography-specimens.html',
      'spacing-tokens.html',
      'components-buttons.html',
      'brand-assets.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), auditUiKitIndex(['Foundation.jsx', 'Navigation.jsx', 'Workspace.jsx']));
    await writeFile(path.join(tmpDir, 'ui_kits/app/README.md'), '# UI kit\n');
    for (const componentName of ['Foundation.jsx', 'Navigation.jsx', 'Workspace.jsx']) {
      await writeFile(
        path.join(tmpDir, 'ui_kits/app/components', componentName),
        auditUiKitComponent(componentName),
      );
    }
    await writeFile(path.join(tmpDir, 'context/source-context.md'), '# Design System Source Context\n\n## Local Code\n\n- /tmp/cherry\n');
    await writeFile(path.join(tmpDir, 'context/local-code/cherry.md'), [
      '# Local Design Evidence: cherry',
      '',
      'Snapshot files written: 6',
      '',
      '### Reusable components',
      '- src/components/ToolbarSurface.tsx -> `context/local-code/cherry/files/src/components/ToolbarSurface.tsx` (source)',
      '- src/components/ArtifactPanel.tsx -> `context/local-code/cherry/files/src/components/ArtifactPanel.tsx` (source)',
      '- src/components/ProviderAvatar.tsx -> `context/local-code/cherry/files/src/components/ProviderAvatar.tsx` (source)',
      '- src/components/SettingsForm.tsx -> `context/local-code/cherry/files/src/components/SettingsForm.tsx` (source)',
      '- src/components/TransferCard.tsx -> `context/local-code/cherry/files/src/components/TransferCard.tsx` (source)',
      '- src/components/CodePreview.tsx -> `context/local-code/cherry/files/src/components/CodePreview.tsx` (source)',
    ].join('\n'));
    for (const componentName of ['ToolbarSurface', 'ArtifactPanel', 'ProviderAvatar', 'SettingsForm', 'TransferCard', 'CodePreview']) {
      await writeFile(path.join(tmpDir, 'context/local-code/cherry/files/src/components', `${componentName}.tsx`), `export function ${componentName}(){ return null; }`);
    }

    const result = await runDesignSystemPackageAuditCli([ '--path', tmpDir]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdoutOutput.join('')).warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'generic_visual_artifacts',
        path: 'preview/',
        message: expect.stringContaining('ToolbarSurface'),
      }),
    ]));

    stdoutOutput = [];
    const strictResult = await runDesignSystemPackageAuditCli([ '--path', tmpDir, '--fail-on-warnings']);

    expect(strictResult.exitCode).toBe(1);
    expect(JSON.parse(stdoutOutput.join(''))).toMatchObject({
      ok: false,
      errors: [],
      warnings: expect.arrayContaining([
        expect.objectContaining({ code: 'generic_visual_artifacts', path: 'preview/' }),
      ]),
    });

    await cleanupTempDir(tmpDir);
  });

  it('warns when focused preview cards do not apply tokens to source components', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'readable-package-audit-preview-source-context-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app/components'), { recursive: true });
    await mkdir(path.join(tmpDir, 'context/local-code/cherry/files/src/components'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), AUDIT_DESIGN_MD);
    await writeFile(path.join(tmpDir, 'README.md'), AUDIT_README);
    await writeFile(path.join(tmpDir, 'SKILL.md'), AUDIT_SKILL);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'typography-specimens.html',
      'brand-assets.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    await writeFile(path.join(tmpDir, 'preview/spacing-radius.html'), auditHtml('spacing-radius token swatches only'));
    await writeFile(path.join(tmpDir, 'preview/components-buttons.html'), auditHtml('components-buttons generic controls only'));
    const componentFiles = ['App.jsx', 'Sidebar.jsx', 'AssistantsList.jsx', 'ChatArea.jsx', 'InputBar.jsx', 'MessageBubble.jsx'];
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), auditUiKitIndex(componentFiles));
    await writeFile(path.join(tmpDir, 'ui_kits/app/README.md'), AUDIT_UI_KIT_README);
    for (const componentName of componentFiles) {
      await writeFile(
        path.join(tmpDir, 'ui_kits/app/components', componentName),
        auditUiKitComponent(componentName),
      );
    }
    await writeFile(path.join(tmpDir, 'context/source-context.md'), '# Design System Source Context\n\n## Local Code\n\n- /tmp/cherry\n');
    await writeFile(path.join(tmpDir, 'context/local-code/cherry.md'), [
      '# Local Design Evidence: cherry',
      '',
      'Snapshot files written: 6',
      '',
      '### Reusable components',
      '- src/components/Sidebar.tsx -> `context/local-code/cherry/files/src/components/Sidebar.tsx` (source)',
      '- src/components/AssistantsList.tsx -> `context/local-code/cherry/files/src/components/AssistantsList.tsx` (source)',
      '- src/components/ChatArea.tsx -> `context/local-code/cherry/files/src/components/ChatArea.tsx` (source)',
      '- src/components/InputBar.tsx -> `context/local-code/cherry/files/src/components/InputBar.tsx` (source)',
      '- src/components/MessageBubble.tsx -> `context/local-code/cherry/files/src/components/MessageBubble.tsx` (source)',
      '- src/components/SettingsForm.tsx -> `context/local-code/cherry/files/src/components/SettingsForm.tsx` (source)',
    ].join('\n'));
    for (const componentName of ['Sidebar', 'AssistantsList', 'ChatArea', 'InputBar', 'MessageBubble', 'SettingsForm']) {
      await writeFile(path.join(tmpDir, 'context/local-code/cherry/files/src/components', `${componentName}.tsx`), `export function ${componentName}(){ return null; }`);
    }

    const result = await runDesignSystemPackageAuditCli([ '--path', tmpDir]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdoutOutput.join('')).warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'preview_cards_missing_source_component_context',
        path: 'preview/',
        message: expect.stringContaining('preview/spacing-radius.html'),
      }),
    ]));

    await cleanupTempDir(tmpDir);
  });

  it('warns when rich component evidence is not preserved as source examples outside context', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'readable-package-audit-source-examples-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app/components'), { recursive: true });
    await mkdir(path.join(tmpDir, 'context/local-code/cherry/files/src/components'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), AUDIT_DESIGN_MD);
    await writeFile(path.join(tmpDir, 'README.md'), AUDIT_README);
    await writeFile(path.join(tmpDir, 'SKILL.md'), AUDIT_SKILL);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'typography-specimens.html',
      'spacing-tokens.html',
      'components-buttons.html',
      'brand-assets.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    const componentFiles = [...AUDIT_COMPONENT_FILES, 'PreviewCard.jsx'];
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), auditUiKitIndex(componentFiles));
    await writeFile(path.join(tmpDir, 'ui_kits/app/README.md'), '# UI kit\n');
    for (const componentName of componentFiles) {
      await writeFile(
        path.join(tmpDir, 'ui_kits/app/components', componentName),
        auditUiKitComponent(componentName),
      );
    }
    await writeFile(path.join(tmpDir, 'context/source-context.md'), '# Design System Source Context\n\n## Local Code\n\n- /tmp/cherry\n');
    await writeFile(path.join(tmpDir, 'context/local-code/cherry.md'), [
      '# Local Design Evidence: cherry',
      '',
      'Snapshot files written: 6',
      '',
      '### Reusable components',
      '- src/components/Sidebar.tsx -> `context/local-code/cherry/files/src/components/Sidebar.tsx` (source)',
      '- src/components/AssistantsList.tsx -> `context/local-code/cherry/files/src/components/AssistantsList.tsx` (source)',
      '- src/components/ChatArea.tsx -> `context/local-code/cherry/files/src/components/ChatArea.tsx` (source)',
      '- src/components/InputBar.tsx -> `context/local-code/cherry/files/src/components/InputBar.tsx` (source)',
      '- src/components/MessageBubble.tsx -> `context/local-code/cherry/files/src/components/MessageBubble.tsx` (source)',
      '- src/components/PreviewCard.tsx -> `context/local-code/cherry/files/src/components/PreviewCard.tsx` (source)',
    ].join('\n'));
    for (const componentName of ['Sidebar', 'AssistantsList', 'ChatArea', 'InputBar', 'MessageBubble', 'PreviewCard']) {
      await writeFile(path.join(tmpDir, 'context/local-code/cherry/files/src/components', `${componentName}.tsx`), `export function ${componentName}(){ return null; }`);
    }

    const result = await runDesignSystemPackageAuditCli([ '--path', tmpDir]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdoutOutput.join('')).warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'missing_source_component_examples',
        path: 'source_examples/',
        message: expect.stringContaining('source-backed component example'),
      }),
    ]));

    await cleanupTempDir(tmpDir);
  });

  it('warns when source-backed examples are only tiny stubs', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'readable-package-audit-thin-source-examples-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app/components'), { recursive: true });
    await mkdir(path.join(tmpDir, 'source_examples'), { recursive: true });
    await mkdir(path.join(tmpDir, 'context/local-code/cherry/files/src/components'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), AUDIT_DESIGN_MD);
    await writeFile(path.join(tmpDir, 'README.md'), AUDIT_README);
    await writeFile(path.join(tmpDir, 'SKILL.md'), AUDIT_SKILL);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'typography-specimens.html',
      'spacing-tokens.html',
      'components-buttons.html',
      'brand-assets.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    const componentFiles = [...AUDIT_COMPONENT_FILES, 'PreviewCard.jsx'];
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), auditUiKitIndex(componentFiles));
    await writeFile(path.join(tmpDir, 'ui_kits/app/README.md'), '# UI kit\n');
    for (const componentName of componentFiles) {
      await writeFile(
        path.join(tmpDir, 'ui_kits/app/components', componentName),
        auditUiKitComponent(componentName),
      );
    }
    await writeFile(path.join(tmpDir, 'context/source-context.md'), '# Design System Source Context\n\n## Local Code\n\n- /tmp/cherry\n');
    await writeFile(path.join(tmpDir, 'context/local-code/cherry.md'), [
      '# Local Design Evidence: cherry',
      '',
      'Snapshot files written: 6',
      '',
      '### Reusable components',
      '- src/components/Sidebar.tsx -> `context/local-code/cherry/files/src/components/Sidebar.tsx` (source)',
      '- src/components/AssistantsList.tsx -> `context/local-code/cherry/files/src/components/AssistantsList.tsx` (source)',
      '- src/components/ChatArea.tsx -> `context/local-code/cherry/files/src/components/ChatArea.tsx` (source)',
      '- src/components/InputBar.tsx -> `context/local-code/cherry/files/src/components/InputBar.tsx` (source)',
      '- src/components/MessageBubble.tsx -> `context/local-code/cherry/files/src/components/MessageBubble.tsx` (source)',
      '- src/components/PreviewCard.tsx -> `context/local-code/cherry/files/src/components/PreviewCard.tsx` (source)',
    ].join('\n'));
    for (const componentName of ['Sidebar', 'AssistantsList', 'ChatArea', 'InputBar', 'MessageBubble', 'PreviewCard']) {
      await writeFile(path.join(tmpDir, 'context/local-code/cherry/files/src/components', `${componentName}.tsx`), `export function ${componentName}(){ return <section>${componentName}</section>; }`);
    }
    for (const componentName of ['Sidebar', 'AssistantsList', 'ChatArea']) {
      await writeFile(path.join(tmpDir, 'source_examples', `${componentName}.tsx`), `export function ${componentName}(){ return null; }\n`);
    }

    const result = await runDesignSystemPackageAuditCli([ '--path', tmpDir]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdoutOutput.join('')).warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'thin_source_component_examples',
        path: 'source_examples/',
        message: expect.stringContaining('filename-only stubs'),
      }),
    ]));

    await cleanupTempDir(tmpDir);
  });

  it('fails a design-system package audit when evidence-backed artifacts are missing', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'readable-package-audit-fail-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/generated_interface'), { recursive: true });
    await mkdir(path.join(tmpDir, 'context'), { recursive: true });
    await writeFile(path.join(tmpDir, 'DESIGN.md'), '# Incomplete\n');
    await writeFile(path.join(tmpDir, 'preview/typography-scale.html'), '<!doctype html>');
    await writeFile(path.join(tmpDir, 'ui_kits/generated_interface/index.html'), '<!doctype html>');
    await writeFile(path.join(tmpDir, 'context/source-context.md'), [
      '# Design System Source Context',
      '',
      '## GitHub Repositories',
      '',
      '- https://github.com/acme/ui',
      '',
      '## Local Code',
      '',
      'Linked folders readable by the local agent:',
      '- /tmp/acme-ui',
    ].join('\n'));

    const result = await runDesignSystemPackageAuditCli([ '--path', tmpDir]);

    expect(result.exitCode).toBe(1);
    const output = JSON.parse(stdoutOutput.join(''));
    expect(output.ok).toBe(false);
    expect(output.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing_required_file', path: 'README.md' }),
      expect.objectContaining({ code: 'missing_github_evidence' }),
      expect.objectContaining({ code: 'missing_local_evidence' }),
      expect.objectContaining({ code: 'old_generated_interface' }),
    ]));

    await cleanupTempDir(tmpDir);
  });

  it('can audit an external Claude Design reference package without DESIGN.md', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'readable-package-audit-reference-'));
    process.chdir(tmpDir);
    await mkdir(path.join(tmpDir, 'preview'), { recursive: true });
    await mkdir(path.join(tmpDir, 'ui_kits/app'), { recursive: true });
    await mkdir(path.join(tmpDir, 'assets'), { recursive: true });
    await mkdir(path.join(tmpDir, 'fonts/ubuntu'), { recursive: true });
    await writeFile(path.join(tmpDir, 'README.md'), AUDIT_README);
    await writeFile(path.join(tmpDir, 'SKILL.md'), REFERENCE_AUDIT_SKILL);
    await writeFile(path.join(tmpDir, 'colors_and_type.css'), AUDIT_TOKENS_CSS);
    for (const fileName of [
      'colors-primary.html',
      'colors-theme-light.html',
      'colors-theme-dark.html',
      'typography-specimens.html',
      'spacing-tokens.html',
      'spacing-radius.html',
      'components-buttons.html',
      'components-inputs.html',
      'brand-assets.html',
    ]) {
      await writeFile(path.join(tmpDir, 'preview', fileName), auditHtml(fileName));
    }
    await writeFile(path.join(tmpDir, 'ui_kits/app/index.html'), auditUiKitIndex());
    await writeFile(path.join(tmpDir, 'ui_kits/app/README.md'), '# UI kit\n');
    await mkdir(path.join(tmpDir, 'ui_kits/app/components'), { recursive: true });
    for (const componentName of AUDIT_COMPONENT_FILES) {
      await writeFile(
        path.join(tmpDir, 'ui_kits/app/components', componentName),
        auditUiKitComponent(componentName),
      );
    }
    await writeFile(path.join(tmpDir, 'assets/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(tmpDir, 'fonts/ubuntu/Ubuntu-Regular.ttf'), Buffer.from('font-data'));

    const strict = await runDesignSystemPackageAuditCli([ '--path', tmpDir]);
    expect(strict.exitCode).toBe(1);
    expect(JSON.parse(stdoutOutput.join('')).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing_required_file', path: 'DESIGN.md' }),
    ]));

    stdoutOutput = [];
    const reference = await runDesignSystemPackageAuditCli([ '--path', tmpDir, '--reference-package']);
    expect(reference.exitCode).toBe(0);
    expect(JSON.parse(stdoutOutput.join(''))).toMatchObject({
      ok: true,
      errors: [],
      warnings: expect.arrayContaining([
        expect.objectContaining({ code: 'missing_readable_studio_rules', path: 'DESIGN.md' }),
      ]),
    });

    await cleanupTempDir(tmpDir);
  });
});