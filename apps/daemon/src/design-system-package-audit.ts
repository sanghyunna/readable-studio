import { stat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  DesignSystemPackageAuditIssue,
  DesignSystemPackageAuditSeverity,
  DesignSystemPackageAudit,
} from '@readable-studio/contracts';

export type { DesignSystemPackageAuditIssue, DesignSystemPackageAuditSeverity, DesignSystemPackageAudit };
async function listAuditFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
      const normalized = relativePath.toLowerCase();
      if (entry.isDirectory()) {
        if (shouldSkipAuditPath(`${normalized}/`)) continue;
        await walk(absolutePath);
        continue;
      }
      if (entry.isFile() && !shouldSkipAuditPath(normalized)) files.push(relativePath);
    }
  };
  await walk(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function shouldSkipAuditPath(normalizedPath: string): boolean {
  return /(^|\/)(node_modules|vendor|dist|coverage|\.next|\.nuxt|\.git|out|target|storybook-static)\//u.test(normalizedPath)
    || /(^|\/)(package-lock\.json|pnpm-lock\.ya?ml|yarn\.lock|bun\.lockb|\.ds_store)$/u.test(normalizedPath);
}
export async function auditDesignSystemPackage(
  projectPath: string,
  options: { referencePackage?: boolean } = {},
): Promise<DesignSystemPackageAudit> {
  const projectStat = await stat(projectPath);
  if (!projectStat.isDirectory()) {
    throw new Error(`design-system-package-audit requires --path to be a directory: ${projectPath}`);
  }
  const files = await listAuditFiles(projectPath);
  const fileSet = new Set(files);
  const issues: DesignSystemPackageAuditIssue[] = [];
  const addIssue = (severity: DesignSystemPackageAuditSeverity, code: string, message: string, issuePath?: string) => {
    issues.push({
      severity,
      code,
      message,
      ...(issuePath === undefined ? {} : { path: issuePath }),
    });
  };
  const requireFile = (filePath: string, message: string) => {
    if (!fileSet.has(filePath)) addIssue('error', 'missing_required_file', message, filePath);
  };
  const requireContent = async (
    filePath: string,
    minBytes: number,
    code: string,
    message: string,
    validate?: (text: string) => string | undefined,
  ) => {
    if (!fileSet.has(filePath)) return;
    const text = await readAuditText(projectPath, filePath);
    if (text === undefined) return;
    if (Buffer.byteLength(text, 'utf8') < minBytes) {
      addIssue('error', code, message, filePath);
      return;
    }
    const validationMessage = validate?.(text);
    if (validationMessage) addIssue('error', code, validationMessage, filePath);
  };

  if (options.referencePackage === true) {
    if (!fileSet.has('DESIGN.md')) {
      addIssue('warning', 'missing_readable_studio_rules', 'Reference packages may omit DESIGN.md, but generated Readable Studio packages must include it as the canonical rules file.', 'DESIGN.md');
    }
  } else {
    requireFile('DESIGN.md', 'Claude Design-style packages need DESIGN.md as the canonical system rules.');
  }
  requireFile('README.md', 'Claude Design-style packages need README.md so the system is reusable outside the current run.');
  requireFile('SKILL.md', 'Claude Design-style packages need SKILL.md with agent-facing usage instructions.');
  requireFile('colors_and_type.css', 'Claude Design-style packages need colors_and_type.css for reusable color, type, spacing, radius, and state tokens.');
  await requireContent('DESIGN.md', 800, 'thin_design_rules', 'DESIGN.md is too thin to be a reusable rules document; include source-backed context, foundations, tokens, components, motion, voice, and anti-patterns.', validateDesignRules);
  await requireContent('README.md', 600, 'thin_readme', 'README.md is too thin to explain the package, source evidence, generated files, and reuse workflow.', requireMarkdownHeading);
  await requireContent('SKILL.md', 500, 'thin_skill', 'SKILL.md is too thin to guide future agents on how to use this design system.', validateSkillInstructions);
  await requireContent('colors_and_type.css', 500, 'thin_token_css', 'colors_and_type.css is too thin to carry reusable color, typography, spacing, radius, and state tokens.', validateTokenCss);
  if (fileSet.has('SKILL.md')) {
    const skillText = await readAuditText(projectPath, 'SKILL.md');
    if (skillText !== undefined && !skillHasAgentFrontmatter(skillText)) {
      addIssue(
        'warning',
        'missing_skill_frontmatter',
        'SKILL.md should include Claude-style YAML frontmatter with name, description, and user-invocable so future agents can discover and invoke the design system package.',
        'SKILL.md',
      );
    }
    if (skillText !== undefined && !skillHasReusableSections(skillText)) {
      addIssue(
        'warning',
        'skill_missing_reuse_sections',
        'SKILL.md should read like a reusable Claude Design skill package: include What is inside, Source context, When to use, How to use, and design-system highlights grounded in source evidence.',
        'SKILL.md',
      );
    }
  }
  const readmeText = fileSet.has('README.md') ? await readAuditText(projectPath, 'README.md') : undefined;
  if (fileSet.has('README.md')) {
    if (readmeText !== undefined && !readmeHasProductOverview(readmeText)) {
      addIssue(
        'warning',
        'readme_missing_product_overview',
        'README.md should include a Claude-style Product Overview or Product Context section that explains the source product, primary surfaces, and core capabilities instead of only listing tokens or generated files.',
        'README.md',
      );
    }
    if (readmeText !== undefined && !readmeHasPackageReuseGuide(readmeText)) {
      addIssue(
        'warning',
        'readme_missing_package_reuse_guide',
        'README.md should work as a Claude Design package guide: list source/context references, package contents, preview cards, preserved assets/fonts/build artifacts, ui_kits/app, and a concrete reuse or review workflow.',
        'README.md',
      );
    }
  }
  for (const docPath of ['DESIGN.md', 'README.md', 'SKILL.md', 'ui_kits/app/README.md']) {
    if (!fileSet.has(docPath)) continue;
    const text = await readAuditText(projectPath, docPath);
    const staleReferences = text ? stalePackageReferences(text) : [];
    if (staleReferences.length > 0) {
      addIssue(
        options.referencePackage === true ? 'warning' : 'error',
        'stale_package_manifest_references',
        `Package documentation still references old scaffold paths: ${staleReferences.join(', ')}. Rewrite it to point at preview/* focused cards and ui_kits/app/.`,
        docPath,
      );
    }
  }
  for (const filePath of protocolTitleAuditFiles(files)) {
    const text = await readAuditText(projectPath, filePath);
    const protocolTitle = text ? protocolDerivedDesignSystemTitle(text) : undefined;
    if (!protocolTitle) continue;
    addIssue(
      options.referencePackage === true ? 'warning' : 'error',
      'protocol_derived_title',
      `${filePath} uses "${protocolTitle}" as a product/design-system title. Derive the package title from source evidence or repository slug instead of URL protocol text.`,
      filePath,
    );
  }

  const previewFiles = files.filter((filePath) => /^preview\/.+\.html$/u.test(filePath));
  if (previewFiles.length < 6) {
    addIssue('error', 'insufficient_preview_cards', `Expected at least 6 focused preview HTML cards, found ${previewFiles.length}.`, 'preview/');
  }
  requirePreviewCategory(previewFiles, /^preview\/colors-[^/]+\.html$/u, 'missing_color_preview', 'Expected at least one focused color preview card such as preview/colors-primary.html.', addIssue);
  requirePreviewCategory(previewFiles, /^preview\/typography-specimens\.html$/u, 'missing_typography_preview', 'Expected preview/typography-specimens.html.', addIssue);
  requirePreviewCategory(previewFiles, /^preview\/spacing-[^/]+\.html$/u, 'missing_spacing_preview', 'Expected at least one focused spacing preview card such as preview/spacing-tokens.html.', addIssue);
  requirePreviewCategory(previewFiles, /^preview\/components-[^/]+\.html$/u, 'missing_component_preview', 'Expected at least one focused component preview card such as preview/components-buttons.html.', addIssue);
  if (readmeText !== undefined && !readmeHasPreviewManifest(readmeText, previewFiles)) {
    addIssue(
      'warning',
      'readme_missing_preview_manifest',
      'README.md should include a concrete preview manifest that lists the generated preview/*.html cards so reviewers and future agents know what to inspect.',
      'README.md',
    );
  }

  const oldPreviewFiles = previewFiles.filter((filePath) => /preview\/(colors-node-types|colors-ui-palette|typography-scale|spacing-system|logo-variants)\.html$/u.test(filePath));
  if (oldPreviewFiles.length > 0) {
    addIssue('warning', 'old_generic_preview_names', `Replace old generic preview names with Claude-style focused cards: ${oldPreviewFiles.join(', ')}.`, 'preview/');
  }
  if (files.some((filePath) => filePath.startsWith('ui_kits/generated_interface/'))) {
    const level = fileSet.has('ui_kits/app/index.html') ? 'warning' : 'error';
    addIssue(level, 'old_generated_interface', 'Replace ui_kits/generated_interface/ with the reusable Claude-style ui_kits/app/ package.', 'ui_kits/generated_interface/');
  }

  requireFile('ui_kits/app/index.html', 'Claude Design-style packages need an applied interface kit at ui_kits/app/index.html.');
  await requireContent('ui_kits/app/index.html', 900, 'thin_ui_kit', 'ui_kits/app/index.html is too thin; include an applied interface example with real layout, components, and states.', validateHtmlDocument);
  if (!fileSet.has('ui_kits/app/README.md')) {
    addIssue('warning', 'missing_ui_kit_readme', 'Add ui_kits/app/README.md so future projects know how to reuse the applied UI kit.', 'ui_kits/app/README.md');
  } else {
    const uiKitReadmeText = await readAuditText(projectPath, 'ui_kits/app/README.md');
    if (uiKitReadmeText !== undefined && !uiKitReadmeHasReuseGuide(uiKitReadmeText)) {
      addIssue(
        'warning',
        'ui_kit_readme_missing_reuse_guide',
        'ui_kits/app/README.md should document the applied kit structure, component files, usage workflow, design notes, and source basis so future agents can reuse it like a Claude Design package.',
        'ui_kits/app/README.md',
      );
    }
  }
  await Promise.all(previewFiles.map((filePath) =>
    requireContent(filePath, 900, 'thin_preview_card', `${filePath} is too thin to be a reviewable focused preview card.`, validateHtmlDocument),
  ));

  const sourceManifest = await readAuditText(projectPath, 'context/source-context.md');
  const evidenceNotes = files.filter((filePath) => /^context\/(github|local-code)\/[^/]+\.md$/u.test(filePath));
  const evidenceTexts = await Promise.all(evidenceNotes.map(async (filePath) => ({
    filePath,
    text: await readAuditText(projectPath, filePath) ?? '',
  })));
  const evidenceText = evidenceTexts.map((item) => item.text).join('\n');
  if (sourceManifest !== undefined) {
    if (manifestHasLinkedGithub(sourceManifest) && !evidenceNotes.some((filePath) => filePath.startsWith('context/github/'))) {
      addIssue('error', 'missing_github_evidence', 'Linked GitHub repositories require context/github/*.md evidence notes before final design-system files are trusted.', 'context/github/');
    }
    if (manifestHasLinkedLocalFolder(sourceManifest) && !evidenceNotes.some((filePath) => filePath.startsWith('context/local-code/'))) {
      addIssue('error', 'missing_local_evidence', 'Linked local folders require context/local-code/*.md evidence notes before final design-system files are trusted.', 'context/local-code/');
    }
  }
  for (const evidence of evidenceTexts) {
    if (/Snapshot files written:\s*0\b/iu.test(evidence.text)) {
      addIssue('error', 'empty_evidence_snapshot', 'Evidence note reports zero snapshot files; rerun bounded intake before drafting final artifacts.', evidence.filePath);
    }
  }
  if (evidenceNotes.length > 0 && !files.some((filePath) => /^context\/(github|local-code)\/[^/]+\/files\//u.test(filePath))) {
    addIssue('error', 'missing_evidence_snapshot_files', 'Evidence notes exist but no command-written snapshot files were found under context/github/*/files/ or context/local-code/*/files/.', 'context/');
  }

  const hasAssetEvidence = evidenceHasAssets(evidenceText) || files.some((filePath) => /^context\/(github|local-code)\/.+\/files\/.+\.(svg|png|jpe?g|webp|ico)$/iu.test(filePath));
  const hasFontEvidence = evidenceHasFonts(evidenceText) || files.some((filePath) => /^context\/(github|local-code)\/.+\/files\/.+\.(ttf|otf|woff2?)$/iu.test(filePath));
  const evidenceAssetFiles = evidenceSnapshotFiles(files, evidenceText, /\.(svg|png|jpe?g|webp|ico)$/iu);
  const evidenceBuildAssetFiles = evidenceSnapshotFiles(files, evidenceText, /(^|\/)(build|resources|public-resources)\/[^`\s)]*(logo|icon|tray|wordmark|mark)[^/]*\.(svg|png|jpe?g|webp|ico)$/iu);
  const evidenceFontFiles = evidenceSnapshotFiles(files, evidenceText, /\.(ttf|otf|woff2?)$/iu);
  const preservedAssetFiles = files.filter((filePath) => /^assets\/.+\.(svg|png|jpe?g|webp|ico)$/iu.test(filePath));
  const preservedBuildAssetFiles = files.filter((filePath) => /^build\/.+\.(svg|png|jpe?g|webp|ico)$/iu.test(filePath));
  const preservedFontFiles = files.filter((filePath) => /^fonts\/.+\.(ttf|otf|woff2?|css)$/iu.test(filePath));
  const evidenceComponentNames = sourceComponentNamesFromEvidence(files, evidenceText);
  const evidenceSurfaceComponentNames = evidenceComponentNames.filter(isSourceSurfaceComponentName);
  const suggestedComponentNames = evidenceSurfaceComponentNames.length >= 3
    ? evidenceSurfaceComponentNames
    : evidenceComponentNames;
  const visualSourceAnchors = await sourceComponentAnchorsInVisualArtifacts(projectPath, files, evidenceComponentNames);
  const componentPreviewGaps = await sourceComponentPreviewGaps(projectPath, previewFiles, evidenceSurfaceComponentNames);
  const sourceExampleAnchors = sourceComponentExamplesInPackage(files, evidenceComponentNames);
  const hasComponentEvidence = evidenceHasReusableComponents(evidenceText)
    || files.some((filePath) => /^context\/(github|local-code)\/.+\/files\/.+(?:\/|^)(components?|ui|app|layout|shell|navbar|sidebar|chat|input|composer|assistant|message|model)[^/]*\/?.*\.(tsx|ts|jsx|js|css|scss|less)$/iu.test(filePath));
  const hasChatUiEvidence = evidenceHasChatInterface(evidenceText)
    || files.some((filePath) => /^context\/(github|local-code)\/.+\/files\/.+(?:pages\/home|components\/app|inputbar|messages?|chat|assistants?|sidebar).*\.(tsx|ts|jsx|js|css|scss|less)$/iu.test(filePath));
  const uiKitComponentFiles = files.filter((filePath) => /^ui_kits\/app\/components\/.+\.(jsx|tsx|js|ts|css|html)$/iu.test(filePath));
  const uiKitScriptComponentFiles = uiKitComponentFiles.filter((filePath) => /\.(jsx|tsx|js|ts)$/iu.test(filePath));
  const uiKitIndexText = await readAuditText(projectPath, 'ui_kits/app/index.html');
  if (fileSet.has('colors_and_type.css') && uiKitIndexText !== undefined && !/colors_and_type\.css/iu.test(uiKitIndexText)) {
    addIssue(
      'error',
      'ui_kit_missing_token_stylesheet',
      'ui_kits/app/index.html must load colors_and_type.css so the applied interface kit uses the extracted design tokens.',
      'ui_kits/app/index.html',
    );
  }
  if (uiKitComponentFiles.length >= 3 && uiKitIndexText !== undefined) {
    const referencedComponents = uiKitComponentFiles.filter((filePath) =>
      uiKitIndexText.includes(path.basename(filePath)),
    );
    const requiredReferences = Math.min(3, uiKitComponentFiles.length);
    if (referencedComponents.length < requiredReferences) {
      addIssue(
        'error',
        'ui_kit_index_missing_component_references',
        `ui_kits/app/index.html must load or import at least ${requiredReferences} modular UI-kit component file(s) from ui_kits/app/components/. Found ${referencedComponents.length}.`,
        'ui_kits/app/index.html',
      );
    }
  }
  if (uiKitScriptComponentFiles.length >= 3 && uiKitIndexText !== undefined) {
    if (!uiKitIndexHasRuntimeBootstrap(uiKitIndexText)) {
      addIssue(
        'error',
        'ui_kit_index_missing_runtime_bootstrap',
        'ui_kits/app/index.html must mount or render the applied UI kit so reviewers see a real composed interface, not only disconnected component files.',
        'ui_kits/app/index.html',
      );
    }
    const composedComponents = componentNamesComposedInUiKitIndex(uiKitIndexText, uiKitScriptComponentFiles);
    if (composedComponents.length === 0) {
      addIssue(
        'error',
        'ui_kit_index_missing_component_composition',
        'ui_kits/app/index.html must compose at least one modular UI-kit component in the rendered entry surface, not only list component filenames.',
        'ui_kits/app/index.html',
      );
    }
    if (uiKitIndexLoadsJsxComponents(uiKitIndexText, uiKitScriptComponentFiles) && !uiKitIndexHasBrowserJsxRuntime(uiKitIndexText)) {
      addIssue(
        'error',
        'ui_kit_index_missing_jsx_runtime',
        'ui_kits/app/index.html directly loads JSX/TSX component files, so it must include React, ReactDOM, and Babel standalone scripts or use compiled browser-ready JavaScript instead.',
        'ui_kits/app/index.html',
      );
    }
    const directlyLoadedJsxComponents = directScriptLoadedJsxComponents(uiKitIndexText, uiKitScriptComponentFiles);
    for (const filePath of directlyLoadedJsxComponents) {
      const componentText = await readAuditText(projectPath, filePath);
      const componentName = componentNameFromUiKitFile(filePath);
      if (componentText !== undefined && componentName !== undefined && !componentTextExposesBrowserGlobal(componentText, componentName)) {
        addIssue(
          'error',
          'ui_kit_component_missing_browser_global',
          `${filePath} is loaded by ui_kits/app/index.html as a browser script, so it must assign \`window.${componentName}\` or \`globalThis.${componentName}\` for the entry renderer to compose it.`,
          filePath,
        );
      }
    }
  }
  if (hasComponentEvidence && uiKitComponentFiles.length < 3) {
    addIssue(
      'error',
      'missing_modular_ui_kit',
      `Source evidence includes reusable product components; add at least 3 reusable files under ui_kits/app/components/. Found ${uiKitComponentFiles.length}.`,
      'ui_kits/app/components/',
    );
  }
  if (hasComponentEvidence && uiKitComponentFiles.length >= 3) {
    const componentByteTotal = await totalAuditBytes(projectPath, uiKitComponentFiles);
    if (componentByteTotal < 3000) {
      addIssue(
        'error',
        'thin_modular_ui_kit',
        `ui_kits/app/components/ is too thin for source-backed component evidence; expected at least 3000 bytes across reusable components, found ${componentByteTotal}.`,
        'ui_kits/app/components/',
      );
    }
  }
  if (hasChatUiEvidence) {
    const missingRoles = missingUiKitComponentRoles(uiKitComponentFiles);
    if (missingRoles.length > 0) {
      addIssue(
        'error',
        'missing_ui_kit_component_roles',
        `Chat/workspace evidence requires UI kit components covering these roles: ${missingRoles.join(', ')}.`,
        'ui_kits/app/components/',
      );
    }
    const appShellFiles = uiKitScriptComponentFiles.filter(isUiKitAppShellComponent);
    if (appShellFiles.length > 0 && uiKitScriptComponentFiles.length >= 4) {
      const bestComposition = await bestUiKitAppShellComposition(projectPath, appShellFiles, uiKitScriptComponentFiles);
      const requiredComposedRoles = Math.min(3, uiKitScriptComponentFiles.length - 1);
      if (bestComposition.composed.length < requiredComposedRoles) {
        addIssue(
          'error',
          'ui_kit_app_missing_role_composition',
          `Chat/workspace UI kits need an app shell component that composes at least ${requiredComposedRoles} role component(s) such as Sidebar, AssistantsList, ChatArea, InputBar, or MessageBubble. Found ${bestComposition.composed.length}.`,
          bestComposition.filePath ?? 'ui_kits/app/components/',
        );
      }
    }
  }
  if (hasComponentEvidence && evidenceComponentNames.length >= 6 && visualSourceAnchors.length < 3) {
    addIssue(
      'warning',
      'generic_visual_artifacts',
      `Source evidence includes ${evidenceComponentNames.length} component snapshots, but preview/UI-kit visuals only reference ${visualSourceAnchors.length} source component name(s). Model or label at least 3 source-backed components such as ${suggestedComponentNames.slice(0, 5).join(', ')}.`,
      'preview/',
    );
  }
  if (hasComponentEvidence && evidenceSurfaceComponentNames.length >= 3 && componentPreviewGaps.length > 0) {
    addIssue(
      'warning',
      'preview_cards_missing_source_component_context',
      `Focused component/spacing preview cards should model or label real source components, not only abstract token swatches. Add source-backed examples to ${componentPreviewGaps.slice(0, 6).join(', ')} using components such as ${evidenceSurfaceComponentNames.slice(0, 5).join(', ')}.`,
      'preview/',
    );
  }
  if (hasComponentEvidence && evidenceComponentNames.length >= 6 && sourceExampleAnchors.length < 3) {
    addIssue(
      'warning',
      'missing_source_component_examples',
      `Source evidence includes ${evidenceComponentNames.length} component snapshots, but the package preserves only ${sourceExampleAnchors.length} source-backed component example(s) outside context/. Copy at least 3 high-signal examples such as ${suggestedComponentNames.slice(0, 5).join(', ')} into source_examples/, a component examples folder, or root/nested TSX files like Claude Design exports.`,
      'source_examples/',
    );
  }
  if (hasComponentEvidence && evidenceComponentNames.length >= 6 && sourceExampleAnchors.length >= 3) {
    const sourceExampleBytes = await totalAuditBytes(projectPath, sourceExampleAnchors);
    if (sourceExampleBytes < 2400) {
      addIssue(
        'warning',
        'thin_source_component_examples',
        `Source examples should preserve substantive component code, not filename-only stubs. Found ${sourceExampleAnchors.length} source-backed example file(s) totaling ${sourceExampleBytes} bytes; preserve larger high-signal examples from the original evidence, similar to Claude Design exports.`,
        'source_examples/',
      );
    }
  }
  if (hasAssetEvidence) {
    if (preservedAssetFiles.length === 0) {
      addIssue('error', 'missing_preserved_assets', 'Source evidence includes brand assets; preserve selected logos/icons/avatars under assets/.', 'assets/');
    }
    if (evidenceAssetFiles.length >= 3 && preservedAssetFiles.length < 3) {
      addIssue(
        'error',
        'insufficient_preserved_assets',
        `Source evidence includes ${evidenceAssetFiles.length} brand asset snapshots; preserve at least 3 representative logos/icons/avatars under assets/. Found ${preservedAssetFiles.length}.`,
        'assets/',
      );
    }
    if (!fileSet.has('preview/brand-assets.html')) {
      addIssue('error', 'missing_brand_assets_preview', 'Source evidence includes brand assets; add preview/brand-assets.html.', 'preview/brand-assets.html');
    }
  }
  const preservedBrandAssetFiles = [...preservedAssetFiles, ...preservedBuildAssetFiles];
  if (preservedBrandAssetFiles.length > 0 && fileSet.has('preview/brand-assets.html')) {
    const brandAssetPreview = await readAuditText(projectPath, 'preview/brand-assets.html');
    const referencedAssets = brandAssetPreview === undefined ? [] : preservedAssetsReferencedInPreview(brandAssetPreview, preservedBrandAssetFiles);
    const requiredAssetReferences = Math.min(2, preservedBrandAssetFiles.length);
    if (referencedAssets.length < requiredAssetReferences) {
      addIssue(
        'warning',
        'brand_assets_preview_not_using_preserved_assets',
        `preview/brand-assets.html should visibly reference at least ${requiredAssetReferences} preserved asset file(s) from assets/ or build/ so the review card shows real logos/icons instead of generated placeholders. Found ${referencedAssets.length}.`,
        'preview/brand-assets.html',
      );
    }
  }
  if (evidenceBuildAssetFiles.length > 0 && preservedBuildAssetFiles.length === 0) {
    addIssue(
      'warning',
      'missing_build_assets',
      `Source evidence includes ${evidenceBuildAssetFiles.length} build/runtime icon asset(s); preserve representative app, installer, tray, or wordmark files under build/ like Claude Design exports instead of collapsing them into prose.`,
      'build/',
    );
  }
  if (evidenceBuildAssetFiles.length > 0 && preservedBuildAssetFiles.length > 0) {
    const sourceBackedBuildAssets = await sourceBackedBuildAssetFiles(projectPath, fileSet, evidenceBuildAssetFiles);
    if (sourceBackedBuildAssets.length === 0) {
      addIssue(
        'warning',
        'build_assets_not_source_backed',
        `Root build/ contains preserved-looking runtime assets, but none match the captured build/resource snapshots byte-for-byte. Copy representative originals such as ${evidenceBuildAssetFiles.slice(0, 3).join(', ')} into build/ with original filenames instead of redrawing or re-encoding placeholders.`,
        'build/',
      );
    }
  }
  if (hasFontEvidence) {
    if (preservedFontFiles.length === 0) {
      addIssue('error', 'missing_preserved_fonts', 'Source evidence includes font files; preserve selected fonts under fonts/ and bind them in colors_and_type.css.', 'fonts/');
    }
    const tokenCss = await readAuditText(projectPath, 'colors_and_type.css');
    if (preservedFontFiles.length > 0 && tokenCss !== undefined && !tokenCssBindsPreservedFonts(tokenCss, preservedFontFiles)) {
      addIssue(
        'error',
        'font_tokens_not_bound',
        'Source font files are preserved under fonts/, but colors_and_type.css does not bind them with @font-face, @import, or a url(...) reference to the preserved font files.',
        'colors_and_type.css',
      );
    }
    if (evidenceFontFiles.length >= 3 && preservedFontFiles.length < 3) {
      addIssue(
        'error',
        'insufficient_preserved_fonts',
        `Source evidence includes ${evidenceFontFiles.length} font snapshots; preserve at least 3 representative font files or declarations under fonts/. Found ${preservedFontFiles.length}.`,
        'fonts/',
      );
    }
  }

  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  return {
    ok: errors.length === 0,
    projectPath,
    filesInspected: files.length,
    errors,
    warnings,
  };
}

function requirePreviewCategory(
  previewFiles: string[],
  pattern: RegExp,
  code: string,
  message: string,
  addIssue: (severity: DesignSystemPackageAuditSeverity, code: string, message: string, path?: string) => void,
): void {
  if (!previewFiles.some((filePath) => pattern.test(filePath))) {
    addIssue('error', code, message, 'preview/');
  }
}

async function readAuditText(projectPath: string, relativePath: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(projectPath, relativePath), 'utf8');
  } catch {
    return undefined;
  }
}

function safePathSegment(value: string): string {
  const normalized = value.trim().replace(/[^a-z0-9._-]+/giu, '-').replace(/^-+|-+$/gu, '');
  return normalized || 'repo';
}

function safeRepoRelativePath(repoPath: string): string {
  return repoPath
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .map(safePathSegment)
    .join('/');
}

function packageBuildAssetTarget(repoPath: string): string | undefined {
  const safeRelativePath = safeRepoRelativePath(repoPath);
  if (!safeRelativePath) return undefined;
  if (!/\.(svg|png|jpe?g|webp|ico)$/iu.test(safeRelativePath)) return undefined;
  if (!/(^|\/)[^/]*(logo|icon|tray|wordmark|mark)[^/]*\.(svg|png|jpe?g|webp|ico)$/iu.test(safeRelativePath)) return undefined;
  const parts = safeRelativePath.split('/');
  const buildIndex = parts.findIndex((part) => /^build$/iu.test(part));
  const assetRootIndex = buildIndex === -1
    ? parts.findIndex((part) => /^(resources|public-resources)$/iu.test(part))
    : buildIndex;
  if (assetRootIndex === -1 || assetRootIndex === parts.length - 1) return undefined;
  return path.join('build', ...parts.slice(assetRootIndex + 1)).split(path.sep).join('/');
}

async function sourceBackedBuildAssetFiles(
  projectPath: string,
  fileSet: Set<string>,
  evidenceBuildAssetFiles: string[],
): Promise<string[]> {
  const matchedFiles: string[] = [];
  const seenTargets = new Set<string>();
  for (const evidenceFilePath of evidenceBuildAssetFiles) {
    if (!fileSet.has(evidenceFilePath)) continue;
    const repoPath = repoPathFromEvidenceSnapshot(evidenceFilePath);
    if (repoPath === undefined) continue;
    const target = packageBuildAssetTarget(repoPath);
    if (target === undefined || seenTargets.has(target) || !fileSet.has(target)) continue;
    seenTargets.add(target);
    try {
      const [sourceBytes, targetBytes] = await Promise.all([
        readFile(path.join(projectPath, evidenceFilePath)),
        readFile(path.join(projectPath, target)),
      ]);
      if (sourceBytes.equals(targetBytes)) matchedFiles.push(target);
    } catch {
      // Missing or unreadable files are already covered by structural audit checks.
    }
  }
  return matchedFiles;
}

function repoPathFromEvidenceSnapshot(filePath: string): string | undefined {
  const match = /^context\/(?:github|local-code)\/[^/]+\/files\/(.+)$/u.exec(filePath);
  return match?.[1];
}

async function totalAuditBytes(projectPath: string, relativePaths: string[]): Promise<number> {
  let total = 0;
  for (const relativePath of relativePaths) {
    try {
      const info = await stat(path.join(projectPath, relativePath));
      if (info.isFile()) total += info.size;
    } catch {
      // Missing files are reported by the caller's structural checks.
    }
  }
  return total;
}

function requireMarkdownHeading(text: string): string | undefined {
  return /^#\s+\S+/mu.test(text) ? undefined : 'Expected a top-level markdown heading.';
}

function validateSkillInstructions(text: string): string | undefined {
  if (requireMarkdownHeading(text) === undefined) return undefined;
  if (/^---\n[\s\S]*?\n---/u.test(text) && /^description:\s+\S+/mu.test(text) && /\*\*How to use:\*\*/iu.test(text)) {
    return undefined;
  }
  return 'Expected a top-level markdown heading or skill frontmatter with usage instructions.';
}

function skillHasAgentFrontmatter(text: string): boolean {
  const match = /^---\n([\s\S]*?)\n---/u.exec(text);
  if (!match) return false;
  const frontmatter = match[1] ?? '';
  return /^name:\s+\S+/mu.test(frontmatter)
    && /^description:\s+\S+/mu.test(frontmatter)
    && /^user-invocable:\s+(true|false)/imu.test(frontmatter);
}

function skillHasReusableSections(text: string): boolean {
  if (text.trim().length < 800) return false;
  const hasInside = (/\*\*What's inside:\*\*/iu.test(text) || /^##\s+(?:What's inside|Contents)\s*$/imu.test(text))
    && /\b(tokens?|assets?|fonts?|preview|ui\s*kit|components?)\b/iu.test(text);
  const hasSourceContext = (/\*\*Source context:\*\*/iu.test(text) || /^##\s+(?:Source Context|Source)\s*$/imu.test(text))
    && /\b(source|repository|github|local|based on|evidence)\b/iu.test(text);
  const hasWhenToUse = (/\*\*When to use(?: this skill)?:\*\*/iu.test(text) || /^##\s+When to use(?: this skill)?\s*$/imu.test(text))
    && /\b(prototypes?|mockups?|interfaces?|artifacts?|production|design|build(?:ing)?)\b/iu.test(text);
  const hasHowToUse = (/\*\*How to use:\*\*/iu.test(text) || /^##\s+(?:How to use|Usage)\s*$/imu.test(text))
    && /\b(README\.md|DESIGN\.md|colors_and_type\.css|preview\/|assets\/|build\/|fonts\/|ui_kits\/app)\b/iu.test(text);
  const hasHighlights = (/\*\*Design system highlights:\*\*/iu.test(text) || /^##\s+(?:(?:Design System|Design) )?Highlights\s*$/imu.test(text))
    && /\b(colors?|typography|spacing|radius|shadows?|icons?|layout|interaction)\b/iu.test(text);
  return hasInside && hasSourceContext && hasWhenToUse && hasHowToUse && hasHighlights;
}

function readmeHasProductOverview(text: string): boolean {
  const section = [
    markdownSection(text, 'Product Overview'),
    markdownSection(text, 'Product Context'),
    markdownSection(text, 'Overview'),
  ].find((value): value is string => value !== undefined && value.trim().length > 0);
  if (section === undefined) return false;
  const body = section.trim();
  return body.length >= 180
    && /\b(product|app|application|workspace|client|platform|tool|service)\b/iu.test(body)
    && /\b(supports?|provides?|features?|includes?|built|designed|helps?|enables?|offers?)\b/iu.test(body);
}

function readmeHasPackageReuseGuide(text: string): boolean {
  const hasPackageContents = /##\s+(?:Package Contents|What's inside|Contents|Files)\b/iu.test(text)
    && /\bDESIGN\.md\b/iu.test(text)
    && /\bcolors_and_type\.css\b/iu.test(text)
    && /\bpreview\//iu.test(text)
    && /\bui_kits\/app\/?\b/iu.test(text);
  const hasSourceContext = /##\s+(?:Source Context|Source Evidence|Sources?|Product Overview|Product Context)\b/iu.test(text)
    && /\b(?:GitHub|repository|source|evidence|context\/|local folder)\b/iu.test(text);
  const hasPreservedArtifacts = /\b(?:assets\/|build\/|fonts\/|source_examples\/)\b/iu.test(text)
    && /\b(?:preserv|source-backed|captured|runtime|brand|font|component)\b/iu.test(text);
  const hasReuseWorkflow = /##\s+(?:Review Workflow|Reuse Workflow|Usage|How to use|Workflow)\b/iu.test(text)
    && /\b(?:reuse|review|inspect|copy|load|compose|start with|open)\b/iu.test(text)
    && /\b(?:preview|DESIGN\.md|colors_and_type\.css|ui_kits\/app|assets\/|fonts\/)\b/iu.test(text);
  return hasPackageContents && hasSourceContext && hasPreservedArtifacts && hasReuseWorkflow;
}

function readmeHasPreviewManifest(text: string, previewFiles: string[]): boolean {
  if (previewFiles.length === 0) return true;
  const previewSection = markdownSection(text, 'Preview Manifest')
    ?? markdownSection(text, 'Preview Cards')
    ?? markdownSection(text, 'Review Previews')
    ?? markdownSection(text, 'Previews');
  if (previewSection === undefined) return false;
  const referencedPreviews = previewFiles.filter((filePath) =>
    new RegExp(`\\b${escapeRegExp(filePath)}\\b`, 'iu').test(previewSection),
  );
  return referencedPreviews.length >= Math.min(4, previewFiles.length);
}

function uiKitReadmeHasReuseGuide(text: string): boolean {
  if (text.trim().length < 350) return false;
  const hasStructure = /##\s+(Structure|Files|Components)\b/iu.test(text)
    && /\bindex\.html\b/iu.test(text)
    && /\bcomponents\//iu.test(text);
  const hasUsage = /##\s+(Usage|How to use|Reuse)\b/iu.test(text)
    && /\b(copy|compose|import|use|build|create)\b/iu.test(text);
  const hasDesignOrSourceNotes = /##\s+(Design Notes|Design|Layout|Source)\b/iu.test(text)
    && /\b(source|based on|layout|colors?|typography|tokens?)\b/iu.test(text);
  const componentMentions = new Set(
    [...text.matchAll(/\b(?:App|Sidebar|AssistantsList|ChatArea|MessageBubble|InputBar|Composer|PreviewCard)\b|components\/[^`\s)]+\.jsx/giu)]
      .map((match) => match[0].toLowerCase()),
  );
  return hasStructure && hasUsage && hasDesignOrSourceNotes && componentMentions.size >= 3;
}

function validateDesignRules(text: string): string | undefined {
  const headings = new Set([...text.matchAll(/^##\s+(.+?)\s*$/gmu)].map((match) => (match[1] ?? '').toLowerCase()));
  const requiredGroups = [
    ['context', 'product'],
    ['color', 'palette'],
    ['typography', 'type'],
    ['spacing', 'layout'],
    ['component'],
    ['motion', 'interaction'],
    ['voice', 'brand'],
    ['anti-pattern'],
  ];
  const missing = requiredGroups.filter((group) =>
    ![...headings].some((heading) => group.some((needle) => heading.includes(needle))),
  );
  return missing.length === 0
    ? undefined
    : `DESIGN.md is missing source-backed sections for ${missing.map((group) => group[0]).join(', ')}.`;
}

function validateTokenCss(text: string): string | undefined {
  const variables = [...text.matchAll(/--[a-z0-9_-]+\s*:/giu)].length;
  if (variables < 12) return `Expected at least 12 CSS custom properties, found ${variables}.`;
  const colors = [...text.matchAll(/#[0-9a-f]{3,8}\b|rgb[a]?\(|hsl[a]?\(/giu)].length;
  if (colors < 4) return `Expected concrete color values in colors_and_type.css, found ${colors}.`;
  if (!/font(-family)?|--[^:]*font/iu.test(text)) return 'Expected font-family or font token declarations.';
  if (!/radius|border-radius/iu.test(text)) return 'Expected radius token declarations.';
  if (!/space|spacing|gap/iu.test(text)) return 'Expected spacing token declarations.';
  return undefined;
}

function validateHtmlDocument(text: string): string | undefined {
  if (!/<!doctype html>|<html[\s>]/iu.test(text)) return 'Expected a complete HTML document.';
  if (!/<style[\s>]/iu.test(text)) return 'Expected embedded CSS styles for review fidelity.';
  if (!/<(main|section|article|aside|header|div)\b/iu.test(text)) return 'Expected real layout markup, not only metadata.';
  return undefined;
}

function tokenCssBindsPreservedFonts(text: string, preservedFontFiles: string[]): boolean {
  const fontAssets = preservedFontFiles.filter((filePath) => /\.(ttf|otf|woff2?)$/iu.test(filePath));
  if (fontAssets.length === 0) {
    return /@import\s+[^;]*fonts\//iu.test(text) || /url\([^)]*fonts\//iu.test(text);
  }
  const hasFontRule = /@font-face/iu.test(text) || /@import\s+[^;]*fonts\//iu.test(text);
  if (!hasFontRule) return false;
  if (/@import\s+[^;]*fonts\/[^;]*\.css/iu.test(text)) return true;
  return fontAssets.some((filePath) => {
    const baseName = escapeRegExp(path.basename(filePath));
    return new RegExp(`url\\([^)]*(?:fonts\\/[^)]*)?${baseName}`, 'iu').test(text)
      || new RegExp(`@import\\s+[^;]*(?:fonts\\/[^;]*)?${baseName}`, 'iu').test(text);
  }) || /url\([^)]*fonts\/[^)]*\.(ttf|otf|woff2?)/iu.test(text);
}

function preservedAssetsReferencedInPreview(text: string, preservedAssetFiles: string[]): string[] {
  return preservedAssetFiles.filter((filePath) => {
    const escapedPath = escapeRegExp(filePath);
    const escapedParentPath = escapeRegExp(`../${filePath}`);
    const escapedBaseName = escapeRegExp(path.basename(filePath));
    return new RegExp(`(?:src|href)=["'][^"']*(?:${escapedPath}|${escapedParentPath}|${escapedBaseName})["']`, 'iu').test(text)
      || new RegExp(`url\\([^)]*(?:${escapedPath}|${escapedParentPath}|${escapedBaseName})`, 'iu').test(text);
  });
}

function evidenceSnapshotFiles(files: string[], evidenceText: string, pattern: RegExp): string[] {
  const fromFiles = files.filter((filePath) => /^context\/(github|local-code)\/.+\/files\//u.test(filePath) && pattern.test(filePath));
  const fromText = [...evidenceText.matchAll(/context\/(?:github|local-code)\/[^`\s)]+\/files\/[^`\s)]+/giu)]
    .map((match) => match[0])
    .filter((filePath) => pattern.test(filePath));
  return [...new Set([...fromFiles, ...fromText])];
}

function sourceComponentNamesFromEvidence(files: string[], evidenceText: string): string[] {
  const paths = [
    ...files.filter((filePath) => /^context\/(github|local-code)\/.+\/files\//u.test(filePath)),
    ...[...evidenceText.matchAll(/context\/(?:github|local-code)\/[^`\s)]+\/files\/[^`\s)]+/giu)].map((match) => match[0]),
  ];
  const names = paths
    .filter((filePath) => /\.(tsx|ts|jsx|js|css|scss|less)$/iu.test(filePath))
    .map(sourceComponentNameFromPath)
    .filter((name): name is string => name !== undefined);
  return [...new Set(names)];
}

function sourceComponentNameFromPath(filePath: string): string | undefined {
  const parts = filePath.split('/').filter(Boolean);
  const fileName = parts.at(-1);
  if (!fileName) return undefined;
  const base = fileName.replace(/\.(tsx|ts|jsx|js|css|scss|less)$/iu, '');
  const name = /^(index|style|styles|constants?|types?|utils?|hooks?)$/iu.test(base)
    ? parts.at(-2)
    : base;
  if (!name || name.length < 4) return undefined;
  if (/^(component|components|page|pages|button|input|card|modal|dialog|index)$/iu.test(name)) return undefined;
  return name;
}

function isSourceSurfaceComponentName(name: string): boolean {
  const normalized = normalizeAnchorText(name);
  if (normalized.length < 4) return false;
  return !/(provider|config|constant|theme|token|style|util|hook|store|locale|schema|type|client|server)$/iu.test(normalized);
}

async function sourceComponentAnchorsInVisualArtifacts(
  projectPath: string,
  files: string[],
  sourceNames: string[],
): Promise<string[]> {
  if (sourceNames.length === 0) return [];
  const visualFiles = files.filter((filePath) =>
    /^preview\/.+\.html$/u.test(filePath)
    || /^ui_kits\/app\/(?:index\.html|components\/.+\.(jsx|tsx|js|ts|css|html))$/u.test(filePath),
  );
  const texts = await Promise.all(visualFiles.map(async (filePath) => await readAuditText(projectPath, filePath) ?? ''));
  const normalizedText = normalizeAnchorText(texts.join('\n'));
  return sourceNames.filter((name) => normalizedText.includes(normalizeAnchorText(name)));
}

async function sourceComponentPreviewGaps(
  projectPath: string,
  previewFiles: string[],
  sourceNames: string[],
): Promise<string[]> {
  if (sourceNames.length === 0) return [];
  const focusedPreviewFiles = previewFiles.filter((filePath) =>
    /^preview\/(?:components|spacing)-.+\.html$/u.test(filePath),
  );
  const normalizedSourceNames = sourceNames.map(normalizeAnchorText);
  const missing: string[] = [];
  for (const filePath of focusedPreviewFiles) {
    const text = await readAuditText(projectPath, filePath);
    const normalizedText = normalizeAnchorText(text ?? '');
    if (!normalizedSourceNames.some((name) => normalizedText.includes(name))) {
      missing.push(filePath);
    }
  }
  return missing;
}

function sourceComponentExamplesInPackage(files: string[], sourceNames: string[]): string[] {
  if (sourceNames.length === 0) return [];
  const sourceNameSet = new Set(sourceNames.map(normalizeAnchorText));
  return files.filter(isPackageSourceExampleFile).filter((filePath) => {
    const name = sourceComponentNameFromPath(filePath);
    return name !== undefined && sourceNameSet.has(normalizeAnchorText(name));
  });
}

function isPackageSourceExampleFile(filePath: string): boolean {
  return /\.(tsx|ts|jsx|js)$/iu.test(filePath)
    && !/^context\//u.test(filePath)
    && !/^preview\//u.test(filePath)
    && !/^ui_kits\/app\//u.test(filePath)
    && !/^assets\//u.test(filePath)
    && !/^fonts\//u.test(filePath)
    && !/^dist\//u.test(filePath)
    && !/^node_modules\//u.test(filePath)
    && !/(^|\/)(package|tsconfig|vite\.config|next\.config|design-system-reference)\.(tsx|ts|jsx|js)$/iu.test(filePath);
}

function normalizeAnchorText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/gu, '');
}

function uiKitIndexHasRuntimeBootstrap(text: string): boolean {
  return /ReactDOM\.createRoot\s*\(|\bcreateRoot\s*\(|ReactDOM\.render\s*\(|\broot\.render\s*\(|\brender\s*\(\s*<|customElements\.define\s*\(|\bmount\s*\(|document\.(?:getElementById|querySelector)\([^)]*\)\.(?:append|appendChild|replaceChildren)\s*\(|document\.(?:getElementById|querySelector)\([^)]*\)\.innerHTML\s*=/iu.test(text);
}

function uiKitIndexLoadsJsxComponents(text: string, componentFiles: string[]): boolean {
  return componentFiles
    .filter((filePath) => /\.(jsx|tsx)$/iu.test(filePath))
    .some((filePath) => text.includes(path.basename(filePath)));
}

function uiKitIndexHasBrowserJsxRuntime(text: string): boolean {
  const hasReact = /\breact(?:\.development|\.production)?\.js\b|\breact@\d|from\s+['"][^'"]*react(?:\/[^'"]*)?['"]|\bReact\./iu.test(text);
  const hasReactDom = /\breact-dom\b|react-dom(?:\.development|\.production)?\.js\b|from\s+['"][^'"]*react-dom(?:\/[^'"]*)?['"]|\bReactDOM\./iu.test(text);
  const hasBabel = /@babel\/standalone|babel\.min\.js|\bBabel\.transform\b/iu.test(text);
  return hasReact && hasReactDom && hasBabel;
}

function directScriptLoadedJsxComponents(text: string, componentFiles: string[]): string[] {
  return componentFiles
    .filter((filePath) => /\.(jsx|tsx)$/iu.test(filePath))
    .filter((filePath) => {
      const fileName = escapeRegExp(path.basename(filePath));
      return new RegExp(`<script\\b[^>]*\\bsrc=["'][^"']*components/${fileName}["'][^>]*>`, 'iu').test(text);
    });
}

function componentNameFromUiKitFile(filePath: string): string | undefined {
  const name = path.basename(filePath).replace(/\.(jsx|tsx|js|ts|html)$/iu, '');
  return name.length > 0 ? name : undefined;
}

function componentTextExposesBrowserGlobal(text: string, componentName: string): boolean {
  const escaped = escapeRegExp(componentName);
  return new RegExp(`(?:window|globalThis)\\s*\\.\\s*${escaped}\\s*=|(?:window|globalThis)\\s*\\[\\s*["']${escaped}["']\\s*\\]\\s*=|Object\\.assign\\s*\\(\\s*(?:window|globalThis)\\s*,\\s*\\{[^}]*\\b${escaped}\\b`, 'u').test(text);
}

function componentNamesComposedInUiKitIndex(text: string, componentFiles: string[]): string[] {
  const textWithoutExternalComponentRefs = text
    .replace(/<script\b[^>]*\bsrc=["'][^"']*components\/[^"']+["'][^>]*>\s*<\/script>/giu, ' ')
    .replace(/components\/[a-z0-9_.-]+/giu, ' ');
  return componentNamesInText(textWithoutExternalComponentRefs, componentFiles);
}

function isUiKitAppShellComponent(filePath: string): boolean {
  return /(^|\/)(app|shell|layout|workspace)\.(jsx|tsx|js|ts)$/iu.test(path.basename(filePath));
}

async function bestUiKitAppShellComposition(
  projectPath: string,
  appShellFiles: string[],
  componentFiles: string[],
): Promise<{ filePath?: string; composed: string[] }> {
  let best: { filePath?: string; composed: string[] } = { composed: [] };
  for (const filePath of appShellFiles) {
    const text = await readAuditText(projectPath, filePath);
    if (text === undefined) continue;
    const composed = componentNamesComposedInComponentText(text, componentFiles, path.basename(filePath));
    if (best.filePath === undefined || composed.length > best.composed.length) best = { filePath, composed };
  }
  return best;
}

function componentNamesInText(text: string, componentFiles: string[], excludeBaseName?: string): string[] {
  const excluded = excludeBaseName?.replace(/\.(jsx|tsx|js|ts)$/iu, '');
  const componentNames = componentFiles
    .map((filePath) => path.basename(filePath).replace(/\.(jsx|tsx|js|ts|html)$/iu, ''))
    .filter((componentName) => componentName.length > 0 && componentName !== excluded);
  return componentNames.filter((componentName) =>
    new RegExp(`\\b${escapeRegExp(componentName)}\\b`, 'u').test(text),
  );
}

function componentNamesComposedInComponentText(text: string, componentFiles: string[], excludeBaseName?: string): string[] {
  return componentNamesInText(text, componentFiles, excludeBaseName).filter((componentName) => {
    const escaped = escapeRegExp(componentName);
    return new RegExp(`<\\s*${escaped}(?:\\s|/|>)|React\\.createElement\\s*\\(\\s*${escaped}\\b|\\b${escaped}\\s*\\(`, 'u').test(text);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function stalePackageReferences(text: string): string[] {
  const stalePreviewPaths = [
    'preview/colors-node-types.html',
    'preview/colors-ui-palette.html',
    'preview/typography-scale.html',
    'preview/spacing-system.html',
    'preview/logo-variants.html',
  ];
  const references = stalePreviewPaths.filter((stalePath) => text.includes(stalePath));
  if (text.includes('ui_kits/generated_interface/index.html')) {
    references.push('ui_kits/generated_interface/index.html');
  } else if (text.includes('ui_kits/generated_interface')) {
    references.push('ui_kits/generated_interface/');
  }
  return references;
}

function protocolTitleAuditFiles(files: string[]): string[] {
  return files.filter((filePath) =>
    /^(DESIGN|README|SKILL)\.md$/u.test(filePath)
    || /^preview\/.+\.html$/u.test(filePath)
    || /^ui_kits\/app\/(?:README\.md|index\.html|components\/.+\.(jsx|tsx|js|ts|html))$/u.test(filePath)
    || /^index\.html$/u.test(filePath),
  );
}

function protocolDerivedDesignSystemTitle(text: string): string | undefined {
  const match = /\bhttps?[^\S\r\n]+Design[^\S\r\n]+System(?:[^\S\r\n]+[A-Za-z][A-Za-z ]*)?/iu.exec(text);
  if (!match) return undefined;
  return match[0].trim().replace(/\s+/gu, ' ');
}

function manifestHasLinkedGithub(manifest: string): boolean {
  const section = markdownSection(manifest, 'GitHub Repositories');
  return section !== undefined && /github\.com[:/][^\s]+|^- https?:\/\/github\.com\//imu.test(section) && !/- None linked\./iu.test(section);
}

function manifestHasLinkedLocalFolder(manifest: string): boolean {
  const section = markdownSection(manifest, 'Local Code');
  return section !== undefined
    && /Linked folders readable by the local agent:\s*\n- (?!none\.)(.+)/iu.test(section);
}

function markdownSection(markdown: string, title: string): string | undefined {
  const lines = markdown.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${title}`.toLowerCase());
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s+/u.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

function evidenceHasAssets(evidenceText: string): boolean {
  return /### Brand assets and icons|## Binary Assets Preserved|\.(svg|png|jpe?g|webp|ico)\b/iu.test(evidenceText);
}

function evidenceHasFonts(evidenceText: string): boolean {
  return /### Fonts|\.(ttf|otf|woff2?)\b/iu.test(evidenceText);
}

function evidenceHasReusableComponents(evidenceText: string): boolean {
  return /### Reusable components|### App shell and navigation|### Chat and input surfaces|components?\/|ui_kits?\/|sidebar|navbar|composer|message bubble|assistant row|model selector/iu.test(evidenceText);
}

function evidenceHasChatInterface(evidenceText: string): boolean {
  return /### Chat and input surfaces|pages\/home|inputbar|messages?\/|chat(area)?|assistant(list|item|stab)?|message bubble|composer/iu.test(evidenceText);
}

function missingUiKitComponentRoles(componentFiles: string[]): string[] {
  const normalized = componentFiles.map((filePath) => path.basename(filePath).toLowerCase());
  const roles = [
    ['app shell', /(app|shell|layout|workspace)\.(jsx|tsx|js|ts|html|css)$/u],
    ['navigation/sidebar', /(sidebar|nav|rail)\.(jsx|tsx|js|ts|html|css)$/u],
    ['assistant/list rail', /(assistants?list|assistantitem|list|panel|tabs?)\.(jsx|tsx|js|ts|html|css)$/u],
    ['chat area', /(chatarea|chat|messages?)\.(jsx|tsx|js|ts|html|css)$/u],
    ['message bubble', /(messagebubble|message)\.(jsx|tsx|js|ts|html|css)$/u],
    ['input bar/composer', /(inputbar|composer|input|messageinput)\.(jsx|tsx|js|ts|html|css)$/u],
  ] as const;
  return roles
    .filter(([, pattern]) => !normalized.some((fileName) => pattern.test(fileName)))
    .map(([role]) => role);
}


export async function runDesignSystemPackageAuditCli(args: string[]): Promise<{ exitCode: number }> {
  let projectPath = process.cwd();
  let projectId: string | undefined;
  let failOnWarnings = false;
  let referencePackage = false;
  let pretty = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--path' && i + 1 < args.length) {
      projectPath = args[i + 1] ?? projectPath;
      i += 1;
    } else if (arg === '--project-id' && i + 1 < args.length) {
      projectId = args[i + 1];
      i += 1;
    } else if (arg === '--fail-on-warnings') {
      failOnWarnings = true;
    } else if (arg === '--reference-package') {
      referencePackage = true;
    } else if (arg === '--json') {
      // Accepted for explicitness; JSON is the default output format.
      pretty = false;
    } else if (arg === '--pretty') {
      pretty = true;
    }
  }

  try {
    let audit: DesignSystemPackageAudit;
    if (projectId) {
      audit = await fetchDaemonAudit(projectId);
    } else {
      audit = await auditDesignSystemPackage(projectPath, { referencePackage });
    }
    const ok = audit.errors.length === 0 && (!failOnWarnings || audit.warnings.length === 0);
    if (pretty) {
      process.stdout.write(`${summarizeDesignSystemPackageAudit(audit)}\n`);
      if (!ok) {
        for (const issue of [...audit.errors, ...audit.warnings]) {
          const pathLabel = issue.path ? ` (${issue.path})` : '';
          process.stdout.write(`  [${issue.severity}] ${issue.code}${pathLabel}: ${issue.message}\n`);
        }
      }
    } else {
      process.stdout.write(`${JSON.stringify({ ...audit, ok }, null, 2)}\n`);
    }
    return { exitCode: ok ? 0 : 1 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ ok: false, error: { message } })}\n`);
    return { exitCode: 1 };
  }
}

async function fetchDaemonAudit(projectId: string): Promise<DesignSystemPackageAudit> {
  const daemonUrl = process.env.READABLE_DAEMON_URL;
  const token = process.env.READABLE_TOOL_TOKEN;
  if (!daemonUrl) throw new Error('READABLE_DAEMON_URL is required for --project-id audit');
  if (!token) throw new Error('READABLE_TOOL_TOKEN is required for --project-id audit');

  const url = new URL(`/api/projects/${encodeURIComponent(projectId)}/design-system-package-audit`, daemonUrl);
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Audit request failed (${response.status}): ${body}`);
  }
  const json = await response.json() as { audit: DesignSystemPackageAudit };
  return json.audit;
}

function summarizeDesignSystemPackageAudit(audit: DesignSystemPackageAudit): string {
  const parts: string[] = [];
  parts.push(`Inspected ${audit.filesInspected} file(s) in ${audit.projectPath}`);
  if (audit.errors.length > 0) parts.push(`${audit.errors.length} error(s)`);
  if (audit.warnings.length > 0) parts.push(`${audit.warnings.length} warning(s)`);
  return parts.join('; ');
}
