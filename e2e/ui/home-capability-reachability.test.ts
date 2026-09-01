import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { routeAgents } from '@/playwright/mock-factory';
import { openNewProjectModal } from '@/playwright/new-project-modal';

test.describe.configure({ timeout: 30_000 });

type ControlExpectation = 'present' | 'absent';
type Control = {
  id: string;
  label: string;
  i18nKey: string | null;
  howToReach: string;
  expect: ControlExpectation;
};

// CONTROL_LIST_START
export const CONTROLS = [
  { id: 'audit-A-01', label: 'Prompt composer / text input', i18nKey: 'homeHero.placeholder / homeHero.placeholderActive', howToReach: 'Open home and edit the composer.', expect: 'present' },
  { id: 'audit-A-02', label: 'Context mention picker tab: All', i18nKey: 'common.all', howToReach: 'Type @ in the home composer and activate All.', expect: 'present' },
  { id: 'audit-A-03', label: 'Context mention picker tab: Files', i18nKey: 'chat.mentionTabFiles', howToReach: 'Type @ in the home composer and activate Files.', expect: 'present' },
  { id: 'audit-A-04', label: 'Context mention picker tab: Plugins', i18nKey: 'entry.navPlugins', howToReach: 'Type @ and activate Plugins.', expect: 'present' },
  { id: 'audit-A-05', label: 'Context mention picker tab: Skills', i18nKey: 'homeHero.skills', howToReach: 'Type @ in the home composer and activate Skills.', expect: 'present' },
  { id: 'audit-A-06', label: 'Context mention picker tab: MCP', i18nKey: null, howToReach: 'Type @ and activate MCP.', expect: 'present' },
  { id: 'audit-A-07', label: 'Context mention picker option rows', i18nKey: null, howToReach: 'Type @local in the composer and choose the plugin result.', expect: 'present' },
  { id: 'audit-A-08', label: 'Hovered plugin Details button', i18nKey: 'homeHero.details', howToReach: 'Hover the seeded plugin card and open Details.', expect: 'present' },
  { id: 'audit-A-09', label: 'Hidden native file input', i18nKey: null, howToReach: 'Set a file through the native composer input.', expect: 'present' },
  { id: 'audit-A-10', label: 'Plus menu trigger', i18nKey: 'homeHero.addMenu', howToReach: 'Open the composer plus menu.', expect: 'present' },
  { id: 'audit-A-11', label: 'Plus menu Attach files', i18nKey: 'chat.attachAria', howToReach: 'Open plus and activate Attach files.', expect: 'present' },
  { id: 'audit-A-12', label: 'Plus menu Plugins submenu', i18nKey: 'entry.navPlugins', howToReach: 'Open plus and activate the Plugins submenu.', expect: 'present' },
  { id: 'audit-A-13', label: 'Plus menu Add plugin', i18nKey: 'homeHero.addPlugin', howToReach: 'Open plus, Plugins, then activate Add plugin.', expect: 'present' },
  { id: 'audit-A-14', label: 'Plus menu MCP submenu', i18nKey: null, howToReach: 'Open plus and activate the MCP submenu.', expect: 'present' },
  { id: 'audit-A-15', label: 'Plus menu Add MCP', i18nKey: 'homeHero.addMcp', howToReach: 'Open plus, MCP, then activate Add MCP.', expect: 'present' },
  { id: 'audit-A-16', label: 'Active file chip remove', i18nKey: 'homeHero.removeFile', howToReach: 'Stage a file and remove its chip.', expect: 'present' },
  { id: 'audit-A-17', label: 'Active plugin chip clear', i18nKey: 'homeHero.clearActivePlugin', howToReach: 'Pick the seeded plugin and clear its active chip.', expect: 'present' },
  { id: 'audit-A-18', label: 'Active skill chip clear', i18nKey: 'homeHero.clearActiveSkill', howToReach: 'Pick the seeded skill and clear its active chip.', expect: 'present' },
  { id: 'audit-A-19', label: 'Context plugin/MCP chip remove', i18nKey: 'common.close', howToReach: 'Pick a context item and remove its chip.', expect: 'present' },
  { id: 'audit-A-20', label: 'Footer design-system picker', i18nKey: 'homeHero.footer.designSystem', howToReach: 'Change the home design-system selection.', expect: 'present' },
  { id: 'audit-A-21', label: 'Footer speaker-notes toggle', i18nKey: 'homeHero.footer.speakerNotes', howToReach: 'Choose Deck and change speaker notes.', expect: 'present' },
  { id: 'audit-A-22', label: 'Footer fidelity select', i18nKey: 'newproj.fidelityLabel', howToReach: 'Choose Prototype and change fidelity.', expect: 'present' },
  { id: 'audit-A-23', label: 'Footer model select', i18nKey: 'newproj.modelLabel', howToReach: 'Choose a creation type and change model.', expect: 'present' },
  { id: 'audit-A-24', label: 'Footer ratio select', i18nKey: 'homeHero.footer.ratio', howToReach: 'Choose a compatible type and change ratio.', expect: 'present' },
  { id: 'audit-A-25', label: 'Footer duration select', i18nKey: 'homeHero.footer.duration', howToReach: 'Choose a compatible type and change duration.', expect: 'present' },
  { id: 'audit-A-26', label: 'Footer resolution select', i18nKey: 'homeHero.footer.resolution', howToReach: 'Choose a compatible type and change resolution.', expect: 'present' },
  { id: 'audit-A-27', label: 'Session mode toggle (Chat / Design)', i18nKey: 'chat.mode.chat.* / chat.mode.design.*', howToReach: 'Toggle the home composer session mode.', expect: 'present' },
  { id: 'audit-A-28', label: 'Submit / Send button', i18nKey: 'homeHero.run / chat.send', howToReach: 'Enter a prompt and submit it from home.', expect: 'present' },
  { id: 'audit-A-29', label: 'Continue without a prompt', i18nKey: 'homeHero.continueWithoutPrompt', howToReach: 'Activate Continue without a prompt.', expect: 'present' },
  { id: 'audit-A-30', label: 'Type chip: Prototype', i18nKey: 'homeHero.chip.prototype', howToReach: 'Activate the Prototype type chip.', expect: 'present' },
  { id: 'audit-A-31', label: 'Type chip: Report', i18nKey: 'homeHero.chip.report', howToReach: 'Activate the Report type chip.', expect: 'present' },
  { id: 'audit-A-32', label: 'Type chip: Deck', i18nKey: 'homeHero.chip.deck', howToReach: 'Activate the Deck type chip.', expect: 'present' },
  { id: 'audit-A-33', label: 'Type chip: Create plugin', i18nKey: 'homeHero.chip.createPlugin', howToReach: 'Open More and activate Create plugin.', expect: 'present' },
  { id: 'audit-A-34', label: 'Type chip: From Figma', i18nKey: 'homeHero.chip.figma', howToReach: 'Open More and activate From Figma.', expect: 'present' },
  { id: 'audit-A-35', label: 'Type chip: From template', i18nKey: 'homeHero.chip.template', howToReach: 'Open More and activate From template.', expect: 'present' },
  { id: 'audit-A-36', label: 'More shortcuts menu trigger', i18nKey: 'homeHero.moreShortcuts', howToReach: 'Open the More shortcuts menu.', expect: 'present' },
  { id: 'audit-A-37', label: 'Sub-type chip: All', i18nKey: 'common.all', howToReach: 'Choose Prototype and activate the All sub-type.', expect: 'present' },
  { id: 'audit-A-38', label: 'Sub-type category chips', i18nKey: null, howToReach: 'Choose Prototype and activate a sub-type category.', expect: 'present' },
  { id: 'audit-A-39', label: 'Active type chip clear', i18nKey: null, howToReach: 'Choose and then clear an active type chip.', expect: 'present' },
  { id: 'audit-A-40', label: 'Prompt example buttons', i18nKey: null, howToReach: 'Activate an example and verify it seeds the composer.', expect: 'present' },
  { id: 'audit-A-41', label: 'Plugin preset card buttons', i18nKey: null, howToReach: 'Choose Prototype and activate a seeded preset card.', expect: 'present' },
  { id: 'audit-A-42', label: 'Staged-file preview modal close', i18nKey: 'common.close', howToReach: 'Stage an image, preview it, then close the modal.', expect: 'present' },
  { id: 'audit-A-43', label: 'Recent projects View all', i18nKey: 'recentProjects.viewAll', howToReach: 'Activate View all from the home recent-project strip.', expect: 'present' },
  { id: 'audit-A-44', label: 'Recent project cards', i18nKey: null, howToReach: 'Activate the deterministic recent project card.', expect: 'present' },
  { id: 'audit-A-45', label: 'Plugin replacement modal Cancel', i18nKey: 'common.cancel', howToReach: 'Trigger plugin replacement and cancel it.', expect: 'present' },
  { id: 'audit-A-46', label: 'Plugin replacement modal Replace', i18nKey: 'homeHero.confirmReplace', howToReach: 'Trigger plugin replacement and confirm it.', expect: 'present' },

  { id: 'regression-01', label: 'Drop files onto the composer', i18nKey: null, howToReach: 'Drop a file on the real home composer and observe its staged chip.', expect: 'present' },
  { id: 'regression-02', label: 'Paste files into the rich composer', i18nKey: null, howToReach: 'Paste a file into the real home composer and observe its staged chip.', expect: 'present' },
  { id: 'regression-03', label: 'Attach files with the composer + menu/native file picker', i18nKey: 'chat.attachAria', howToReach: 'Use the plus menu Attach action.', expect: 'present' },
  { id: 'regression-04', label: 'Create from files alone, with no prompt', i18nKey: null, howToReach: 'Stage a file and submit with an empty prompt.', expect: 'present' },
  { id: 'regression-05', label: 'See staged file name/size chips and remove a file', i18nKey: 'homeHero.removeFile', howToReach: 'Stage and remove a deterministic file.', expect: 'present' },
  { id: 'regression-06', label: 'Preview staged images, close by button/backdrop/Escape', i18nKey: 'common.close', howToReach: 'Open a staged image preview and dismiss it.', expect: 'present' },
  { id: 'regression-07', label: 'Open the @ context picker', i18nKey: null, howToReach: 'Type @ into the home composer.', expect: 'present' },
  { id: 'regression-08', label: 'Context picker: Files tab/search/select', i18nKey: 'chat.mentionTabFiles', howToReach: 'Open the context picker and operate Files.', expect: 'present' },
  { id: 'regression-09', label: 'Context picker: Plugins tab/search/select', i18nKey: 'entry.navPlugins', howToReach: 'Open the context picker and choose the seeded plugin.', expect: 'present' },
  { id: 'regression-10', label: 'Context picker: Skills tab/search/select', i18nKey: 'homeHero.skills', howToReach: 'Open the context picker and choose a seeded skill.', expect: 'present' },
  { id: 'regression-11', label: 'Context picker: MCP tab/search/select', i18nKey: null, howToReach: 'Open the context picker and choose the seeded MCP server.', expect: 'present' },
  { id: 'regression-12', label: 'Keyboard navigation in context results', i18nKey: null, howToReach: 'Open context results and operate them with keyboard controls.', expect: 'present' },
  { id: 'regression-13', label: 'Composer + menu: choose/search/preview a plugin', i18nKey: 'entry.navPlugins', howToReach: 'Open plus, search, preview, and choose the seeded plugin.', expect: 'present' },
  { id: 'regression-14', label: 'Composer + menu: open Add Plugin/registry', i18nKey: 'homeHero.addPlugin', howToReach: 'Open plus and activate Add Plugin.', expect: 'present' },
  { id: 'regression-15', label: 'Composer + menu: choose/search an MCP server', i18nKey: null, howToReach: 'Open plus, search, and choose the seeded MCP server.', expect: 'present' },
  { id: 'regression-16', label: 'Composer + menu: open Add MCP/integrations', i18nKey: 'homeHero.addMcp', howToReach: 'Open plus and activate Add MCP.', expect: 'present' },
  { id: 'regression-17', label: 'See/remove context-only plugin and MCP chips', i18nKey: 'common.close', howToReach: 'Choose and remove a context-only item.', expect: 'present' },
  { id: 'regression-18', label: 'Pick/clear an active skill and route the run by skillId', i18nKey: 'homeHero.clearActiveSkill', howToReach: 'Pick a skill, clear it, and verify submission routing.', expect: 'present' },
  { id: 'regression-19', label: 'Pick a plugin, apply its snapshot, inputs and context, and route the run by that plugin', i18nKey: null, howToReach: 'Pick the seeded plugin and inspect the create request.', expect: 'present' },
  { id: 'regression-20', label: 'Open active plugin details; clear/replace active plugin safely', i18nKey: 'homeHero.details', howToReach: 'Operate the active plugin lifecycle from home.', expect: 'present' },
  { id: 'regression-21', label: 'Plugin details modal actions', i18nKey: 'homeHero.details', howToReach: 'Open plugin details and dismiss the real modal.', expect: 'present' },
  { id: 'regression-22', label: 'Session mode toggle and mode-specific routing', i18nKey: 'chat.mode.chat.* / chat.mode.design.*', howToReach: 'Toggle mode and verify its selected state.', expect: 'present' },
  { id: 'regression-23', label: 'Artifact type tab: Prototype', i18nKey: 'homeHero.chip.prototype', howToReach: 'Activate Prototype on home.', expect: 'present' },
  { id: 'regression-24', label: 'Artifact type tab: Slide deck', i18nKey: 'homeHero.chip.deck', howToReach: 'Activate Slide deck on home.', expect: 'present' },
  { id: 'regression-25', label: 'Artifact type tab: Report', i18nKey: 'homeHero.chip.report', howToReach: 'Activate Report on home.', expect: 'present' },
  { id: 'regression-26', label: 'More shortcut: Create plugin/plugin-authoring handoff', i18nKey: 'homeHero.chip.createPlugin', howToReach: 'Activate Create plugin and observe the handoff.', expect: 'present' },
  { id: 'regression-27', label: 'More shortcut: From Figma migration', i18nKey: 'homeHero.chip.figma', howToReach: 'Activate From Figma and observe its mode.', expect: 'present' },
  { id: 'regression-28', label: 'More shortcut: From template', i18nKey: 'homeHero.chip.template', howToReach: 'Activate From template and observe its flow.', expect: 'present' },
  { id: 'regression-29', label: 'Subcategory tabs and counts under Prototype/Deck', i18nKey: 'common.all', howToReach: 'Activate an artifact type and operate its subcategory tabs.', expect: 'present' },
  { id: 'regression-30', label: 'Curated plugin prompt-preset cards with visual previews', i18nKey: null, howToReach: 'Activate a seeded preset and observe composer output.', expect: 'present' },
  { id: 'regression-31', label: 'Static prompt-example cards that seed/focus the composer', i18nKey: null, howToReach: 'Activate an example and observe composer output and focus.', expect: 'present' },
  { id: 'regression-32', label: 'Start a project without a prompt', i18nKey: 'homeHero.continueWithoutPrompt', howToReach: 'Activate Continue without a prompt and observe creation.', expect: 'present' },
  { id: 'regression-33', label: 'Continue/start while a plugin is still applying, with required-input validation and visible errors', i18nKey: null, howToReach: 'Activate a required-input plugin and observe validation.', expect: 'present' },
  { id: 'regression-34', label: 'Dynamic plugin input controls', i18nKey: 'homeHero.footer.designSystem', howToReach: 'Activate a seeded plugin and change a dynamic input.', expect: 'present' },
  { id: 'regression-35', label: 'Rich Lexical composer with atomic mention pills and entity deletion semantics', i18nKey: null, howToReach: 'Insert a mention and delete it as an atomic entity.', expect: 'present' },
  { id: 'regression-36', label: 'Visible error alert for apply/submit failures', i18nKey: null, howToReach: 'Cause an apply failure and observe the home alert.', expect: 'present' },
  { id: 'regression-37', label: 'Recent-project thumbnail cards, status and recency', i18nKey: null, howToReach: 'Inspect and activate the seeded recent-project card.', expect: 'present' },
  { id: 'regression-38', label: 'Open a recent project directly by clicking its card', i18nKey: null, howToReach: 'Activate the seeded project card and observe navigation.', expect: 'present' },
  { id: 'regression-39', label: 'View all projects from home', i18nKey: 'recentProjects.viewAll', howToReach: 'Activate View all and observe the projects route.', expect: 'present' },
  { id: 'regression-40', label: 'Expand/collapse the entry navigation rail from home', i18nKey: 'entry.navExpand', howToReach: 'Expand and collapse the home navigation rail.', expect: 'present' },
  { id: 'regression-41', label: 'Home navigation destination: Projects', i18nKey: 'entry.navProjects', howToReach: 'Navigate from home to Projects.', expect: 'present' },
  { id: 'regression-42', label: 'Home navigation destination: Tasks/automations/templates', i18nKey: 'entry.navTasks', howToReach: 'Navigate from home to Tasks.', expect: 'present' },
  { id: 'regression-43', label: 'Home navigation destination: Plugins', i18nKey: 'entry.navPlugins', howToReach: 'Navigate from home to Plugins.', expect: 'present' },
  { id: 'regression-44', label: 'Home navigation destination: Design Systems', i18nKey: 'entry.navDesignSystems', howToReach: 'Navigate from home to Design Systems.', expect: 'present' },
  { id: 'regression-45', label: 'Home navigation destination: Integrations', i18nKey: 'entry.navIntegrations', howToReach: 'Navigate from home to Integrations.', expect: 'present' },
  { id: 'regression-46', label: 'Home help menu', i18nKey: 'entry.help', howToReach: 'Open the help menu from home.', expect: 'present' },
  { id: 'regression-47', label: 'First-run guided sheen from artifact tab to preset card', i18nKey: null, howToReach: 'Open a deterministic empty-project home and observe the guided sequence.', expect: 'present' },
  { id: 'regression-48', label: 'Import Folder starter performs a folder import', i18nKey: 'hub.importFolder', howToReach: 'Activate Import Folder and observe the folder-import API.', expect: 'present' },
  { id: 'regression-49', label: 'Home-level onboarding/welcome surface', i18nKey: 'settings.welcomeTitle', howToReach: 'Open first run with onboardingCompleted:false and verify onboarding does not render.', expect: 'absent' },

  { id: 'section-C-hierarchy', label: 'Project to session hierarchy', i18nKey: 'hub.treeLabel', howToReach: 'Collapse and re-expand the seeded project tree.', expect: 'present' },
  { id: 'section-C-status-badges', label: 'Running/awaiting/failed status badges', i18nKey: 'hub.stateRunning / hub.stateAwaiting / hub.stateFailed', howToReach: 'Inspect deterministic project and session states.', expect: 'present' },
  { id: 'section-C-overflow', label: 'N more overflow', i18nKey: 'hub.showMoreSessions', howToReach: 'Activate the overflow row and reveal session six.', expect: 'present' },
  { id: 'section-C-running-banner', label: 'Running banner', i18nKey: 'hub.liveRunning', howToReach: 'Activate the running strip and observe session navigation.', expect: 'present' },
  { id: 'section-C-filter-counts', label: 'Live filter counts', i18nKey: 'hub.filterRunning', howToReach: 'Activate Running and observe filtered tree state.', expect: 'present' },
  { id: 'section-C-empty-clear', label: 'Empty/filtered state and Clear filter', i18nKey: 'hub.clearFilter', howToReach: 'Produce an empty filtered tree and clear its filter.', expect: 'present' },
  { id: 'section-C-sort', label: 'Sort recent/name', i18nKey: 'hub.sortName', howToReach: 'Switch to name sort and observe project order.', expect: 'present' },
  { id: 'section-C-tree-keyboard', label: 'Tree arrows/Home/End/Enter/Space', i18nKey: 'hub.treeLabel', howToReach: 'Drive the project tree with ArrowDown and Home.', expect: 'present' },
  { id: 'section-C-claude-zip-component', label: 'Claude ZIP button component conditional contract', i18nKey: 'hub.importClaudeZip', howToReach: 'Verify the unwired optional control is not falsely exposed.', expect: 'present' },
  { id: 'section-C-pearl-blur', label: 'Pearl blur', i18nKey: null, howToReach: 'Inspect the rendered home rail backdrop filter.', expect: 'present' },
] as const satisfies readonly Control[];
// CONTROL_LIST_END

type AssertionKind =
  | 'composer' | 'mention-all' | 'mention-files' | 'mention-plugins' | 'mention-skills' | 'mention-mcp' | 'mention-option' | 'mention-keyboard'
  | 'plugin-details' | 'file-input' | 'plus-open' | 'plus-attach' | 'plus-plugins' | 'plus-add-plugin' | 'plus-mcp' | 'plus-add-mcp'
  | 'file-remove' | 'plugin-clear' | 'skill-clear' | 'context-clear' | 'design-system' | 'speaker-notes' | 'fidelity' | 'model' | 'ratio' | 'duration' | 'resolution'
  | 'mode' | 'submit' | 'continue' | 'prototype' | 'report' | 'deck' | 'create-plugin' | 'figma' | 'template' | 'more' | 'subtype-all' | 'subtype-category'
  | 'type-clear' | 'prompt-example' | 'preset' | 'preview-close' | 'view-all' | 'recent-card' | 'replace-cancel' | 'replace-confirm'
  | 'drop-file' | 'paste-file' | 'attachment-only' | 'plus-plugin-pick' | 'plus-mcp-pick' | 'skill-route' | 'plugin-route' | 'mode-route' | 'plugin-validation' | 'dynamic-input' | 'rich-mention' | 'visible-error'
  | 'rail-toggle' | 'nav-projects' | 'nav-tasks' | 'nav-plugins' | 'nav-design-systems' | 'nav-integrations' | 'help' | 'first-run-guide' | 'import-folder'
  | 'onboarding-absent' | 'c-hierarchy' | 'c-status' | 'c-overflow' | 'c-running' | 'c-filter' | 'c-empty' | 'c-sort' | 'c-keyboard' | 'c-claude' | 'c-blur';

// ASSERTION_MAP_START
const ASSERTION_KIND_BY_ID = {
  'audit-A-01': 'composer', 'audit-A-02': 'mention-all', 'audit-A-03': 'mention-files', 'audit-A-04': 'mention-plugins',
  'audit-A-05': 'mention-skills', 'audit-A-06': 'mention-mcp', 'audit-A-07': 'mention-option', 'audit-A-08': 'plugin-details',
  'audit-A-09': 'file-input', 'audit-A-10': 'plus-open', 'audit-A-11': 'plus-attach', 'audit-A-12': 'plus-plugins',
  'audit-A-13': 'plus-add-plugin', 'audit-A-14': 'plus-mcp', 'audit-A-15': 'plus-add-mcp', 'audit-A-16': 'file-remove',
  'audit-A-17': 'plugin-clear', 'audit-A-18': 'skill-clear', 'audit-A-19': 'context-clear', 'audit-A-20': 'design-system',
  'audit-A-21': 'speaker-notes', 'audit-A-22': 'fidelity', 'audit-A-23': 'model', 'audit-A-24': 'ratio',
  'audit-A-25': 'duration', 'audit-A-26': 'resolution', 'audit-A-27': 'mode', 'audit-A-28': 'submit',
  'audit-A-29': 'continue', 'audit-A-30': 'prototype', 'audit-A-31': 'report', 'audit-A-32': 'deck',
  'audit-A-33': 'create-plugin', 'audit-A-34': 'figma', 'audit-A-35': 'template', 'audit-A-36': 'more',
  'audit-A-37': 'subtype-all', 'audit-A-38': 'subtype-category', 'audit-A-39': 'type-clear', 'audit-A-40': 'prompt-example',
  'audit-A-41': 'preset', 'audit-A-42': 'preview-close', 'audit-A-43': 'view-all', 'audit-A-44': 'recent-card',
  'audit-A-45': 'replace-cancel', 'audit-A-46': 'replace-confirm',
  'regression-01': 'drop-file', 'regression-02': 'paste-file', 'regression-03': 'plus-attach', 'regression-04': 'attachment-only',
  'regression-05': 'file-remove', 'regression-06': 'preview-close', 'regression-07': 'mention-all', 'regression-08': 'mention-files',
  'regression-09': 'mention-plugins', 'regression-10': 'mention-skills', 'regression-11': 'mention-mcp', 'regression-12': 'mention-keyboard',
  'regression-13': 'plus-plugin-pick', 'regression-14': 'plus-add-plugin', 'regression-15': 'plus-mcp-pick', 'regression-16': 'plus-add-mcp',
  'regression-17': 'context-clear', 'regression-18': 'skill-route', 'regression-19': 'plugin-route', 'regression-20': 'plugin-clear',
  'regression-21': 'plugin-details', 'regression-22': 'mode-route', 'regression-23': 'prototype', 'regression-24': 'deck',
  'regression-25': 'report', 'regression-26': 'create-plugin', 'regression-27': 'figma', 'regression-28': 'template',
  'regression-29': 'subtype-category', 'regression-30': 'preset', 'regression-31': 'prompt-example', 'regression-32': 'continue',
  'regression-33': 'plugin-validation', 'regression-34': 'dynamic-input', 'regression-35': 'rich-mention', 'regression-36': 'visible-error',
  'regression-37': 'recent-card', 'regression-38': 'recent-card', 'regression-39': 'view-all', 'regression-40': 'rail-toggle',
  'regression-41': 'nav-projects', 'regression-42': 'nav-tasks', 'regression-43': 'nav-plugins', 'regression-44': 'nav-design-systems',
  'regression-45': 'nav-integrations', 'regression-46': 'help', 'regression-47': 'first-run-guide', 'regression-48': 'import-folder',
  'regression-49': 'onboarding-absent',
  'section-C-hierarchy': 'c-hierarchy', 'section-C-status-badges': 'c-status', 'section-C-overflow': 'c-overflow',
  'section-C-running-banner': 'c-running', 'section-C-filter-counts': 'c-filter', 'section-C-empty-clear': 'c-empty',
  'section-C-sort': 'c-sort', 'section-C-tree-keyboard': 'c-keyboard', 'section-C-claude-zip-component': 'c-claude',
  'section-C-pearl-blur': 'c-blur',
} as const satisfies Record<(typeof CONTROLS)[number]['id'], AssertionKind>;
// ASSERTION_MAP_END

const STORAGE_KEY = 'readable-studio:config';
const HOME_CONFIG = {
  mode: 'daemon', apiKey: '', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', agentId: 'mock', skillId: null,
  designSystemId: 'agentic', onboardingCompleted: true, agentModels: { mock: { model: 'default', reasoning: 'default' } },
  privacyDecisionAt: 1, telemetry: { metrics: false, content: false, artifactManifest: false },
};

const ARTIFACT_INPUTS = [
  { name: 'designSystem', type: 'string', default: 'Agentic', label: 'Design system' },
  { name: 'speakerNotes', type: 'boolean', default: false, label: 'Speaker notes' },
  { name: 'fidelity', type: 'select', default: 'high-fidelity', label: 'Fidelity', options: ['high-fidelity', 'wireframe'] },
  { name: 'model', type: 'select', default: 'default', label: 'Model', options: ['default', 'quality'] },
  { name: 'ratio', type: 'select', default: '16:9', label: 'Ratio', options: ['16:9', '4:3'] },
  { name: 'duration', type: 'select', default: 'short', label: 'Duration', options: ['short', 'long'] },
  { name: 'resolution', type: 'select', default: '1080p', label: 'Resolution', options: ['1080p', '4k'] },
] as const;

// Complete InstalledPluginRecord shape: partial records are intentionally filtered by isVisiblePlugin.
const HOME_PLUGINS = [{
  id: 'localized-plugin', title: 'Localized Plugin', version: '0.1.0', trust: 'bundled', sourceKind: 'bundled',
  source: '/tmp/localized-plugin', fsPath: '/tmp/localized-plugin', capabilitiesGranted: ['prompt:inject'], installedAt: 0, updatedAt: 0,
  manifest: { name: 'localized-plugin', title: 'Localized Plugin', version: '0.1.0', description: 'Deterministic home reachability plugin.',
    readable: { kind: 'scenario', taskKind: 'new-generation', useCase: { mode: 'prototype', featured: true, query: 'Make a {{topic}} brief.' },
      inputs: [{ name: 'topic', type: 'string', required: true, default: 'design systems', label: 'Topic' }] } },
}, {
  id: 'deck-writer', title: 'Deck Writer', version: '0.1.0', trust: 'bundled', sourceKind: 'bundled', source: '/tmp/deck-writer', fsPath: '/tmp/deck-writer',
  capabilitiesGranted: ['prompt:inject'], installedAt: 0, updatedAt: 0,
  manifest: { name: 'deck-writer', title: 'Deck Writer', version: '0.1.0', description: 'Deterministic deck plugin.', tags: ['pitch-deck'],
    readable: { kind: 'scenario', taskKind: 'new-generation', mode: 'deck', useCase: { query: 'Draft a {{topic}} deck.' },
      inputs: [{ name: 'topic', type: 'string', required: true, default: 'quarterly review', label: 'Topic' }] } },
}, {
  id: 'required-input-plugin', title: 'Required Brief', version: '0.1.0', trust: 'bundled', sourceKind: 'bundled', source: '/tmp/required-input-plugin', fsPath: '/tmp/required-input-plugin',
  capabilitiesGranted: ['prompt:inject'], installedAt: 0, updatedAt: 0,
  manifest: { name: 'required-input-plugin', title: 'Required Brief', version: '0.1.0', description: 'Requires a brief.', tags: ['dashboard'],
    readable: { kind: 'scenario', taskKind: 'new-generation', mode: 'prototype', useCase: { query: 'Build for {{brief}}.' },
      inputs: [{ name: 'brief', type: 'string', required: true, label: 'Audience brief' }] } },
}];

const PROJECTS = [
  { id: 'qa-running', name: 'Zulu Running Project', updatedAt: 200, status: { value: 'running' } },
  { id: 'qa-attention', name: 'Alpha Attention Project', updatedAt: 100, status: { value: 'awaiting_input' } },
];
const RUNNING_SESSIONS = Array.from({ length: 6 }, (_, index) => ({
  id: `qa-session-${index + 1}`, title: index === 0 ? 'Running session' : `Session ${index + 1}`, updatedAt: 200 - index,
  latestRun: { status: index === 0 ? 'running' : index === 1 ? 'failed' : 'completed' }, messageCount: index + 1, sessionMode: 'design',
}));

async function seedHome(page: Page) {
  await page.addInitScript(({ key, value }) => {
    window.localStorage.clear(); window.sessionStorage.clear(); window.localStorage.setItem(key, JSON.stringify(value));
  }, { key: STORAGE_KEY, value: HOME_CONFIG });
  await routeAgents(page, [{ id: 'mock', name: 'Mock Agent', bin: 'mock-agent', available: true, version: 'test', models: [{ id: 'default', label: 'Default' }] }]);
  await page.route('**/api/app-config', async route => {
    if (route.request().method() === 'GET') await route.fulfill({ json: { config: HOME_CONFIG } }); else await route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/projects', async route => {
    if (route.request().method() === 'GET') { await route.fulfill({ json: { projects: PROJECTS } }); return; }
    await route.fulfill({ json: { project: PROJECTS[0], conversationId: 'created-session' } });
  });
  await page.route('**/api/projects/*/conversations', async route => {
    const sessions = route.request().url().includes('qa-running') ? RUNNING_SESSIONS : [];
    await route.fulfill({ json: { conversations: sessions } });
  });
  await page.route('**/api/plugins', async route => {
    const [basePlugin] = HOME_PLUGINS;
    if (!basePlugin) throw new Error('Home plugin fixture is empty');
    await route.fulfill({ json: { plugins: [
    ...HOME_PLUGINS,
    ...[
      ['example-web-prototype', 'Web Prototype', 'prototype'],
      ['example-simple-deck', 'Simple Deck', 'deck'],
      ['example-report', 'Report Writer', 'prototype'],
      ['readable-plugin-authoring', 'Plugin Authoring', 'other'],
      ['readable-figma-migration', 'Figma Migration', 'prototype'],
    ].map(([id, title, mode]) => ({
      ...basePlugin, id, title, source: `/tmp/${id}`, fsPath: `/tmp/${id}`,
      manifest: { ...basePlugin.manifest, name: id, title, tags: [mode === 'deck' ? 'pitch-deck' : id === 'example-web-prototype' ? 'dashboard' : 'landing-page'],
        readable: { ...basePlugin.manifest.readable, mode, useCase: { query: `Create with ${title}.` }, inputs: ARTIFACT_INPUTS } },
    })),
  ] } }); });
  await page.route('**/api/plugins/*/apply', async route => {
    const pluginId = route.request().url().split('/api/plugins/')[1]?.split('/')[0] ?? 'localized-plugin';
    const body = route.request().postDataJSON() as { inputs?: Record<string, unknown> };
    const plugin = HOME_PLUGINS.find(candidate => candidate.id === pluginId);
    const inputs = plugin?.manifest.readable.inputs ?? (pluginId.startsWith('example-') ? ARTIFACT_INPUTS : []);
    await route.fulfill({ json: { query: pluginId === 'required-input-plugin' ? 'Build for {{brief}}.' : 'Make a design systems brief.', contextItems: [], inputs, assets: [], mcpServers: [], trust: 'trusted',
      capabilitiesGranted: ['prompt:inject'], capabilitiesRequired: ['prompt:inject'], projectMetadata: {},
      appliedPlugin: { snapshotId: `snap-${pluginId}`, pluginId, pluginVersion: '0.1.0', manifestSourceDigest: 'b'.repeat(64), inputs: body.inputs ?? {},
        resolvedContext: { items: [{ kind: 'file', id: 'fixture-context', label: 'Fixture context' }] }, capabilitiesGranted: ['prompt:inject'], capabilitiesRequired: ['prompt:inject'], assetsStaged: [],
        taskKind: 'new-generation', appliedAt: 0, mcpServers: [], status: 'fresh' } } });
  });
  await page.route('**/api/design-systems', async route => { await route.fulfill({ json: { designSystems: [
    { id: 'agentic', title: 'Agentic', category: 'Productivity', summary: 'Agentic fixture', surface: 'web', swatches: ['#111827'] },
    { id: 'airbnb', title: 'Airbnb', category: 'Retail', summary: 'Airbnb fixture', surface: 'web', swatches: ['#ff385c'] },
  ] } }); });
  await page.route('**/api/skills', async route => { await route.fulfill({ json: { skills: [{ id: 'qa-skill', name: 'QA Skill', description: 'Deterministic QA skill.', triggers: [], mode: 'prototype', previewType: 'none', designSystemRequired: false, defaultFor: [] }] } }); });
  await page.route('**/api/mcp/servers', async route => { await route.fulfill({ json: { servers: [{ id: 'qa-mcp', label: 'QA MCP', enabled: true, transport: 'stdio', command: 'qa' }] } }); });
  await page.route('**/api/prompt-templates', async route => { await route.fulfill({ json: { promptTemplates: [] } }); });
  await page.route('**/api/dialog/open-folder', async route => { await route.fulfill({ json: { path: null } }); });
}

async function gotoHome(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.readable-loading-shell')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('entry-view-home')).toBeVisible();
}

async function visible(locator: Locator, id: string) {
  await expect(locator, `[${id}] control must be visible on the real home surface`).toBeVisible({ timeout: 2_000 });
}

async function chooseType(page: Page, id: 'prototype' | 'deck' | 'report') {
  await page.getByTestId('hub-open-palette').click();
  const input = page.getByTestId('hub-palette-input');
  await input.fill(id === 'deck' ? 'Slide deck' : id);
  const command = page.getByTestId(`hub-palette-item-command-create-${id}`);
  await visible(command, `type-${id}`);
  await command.click();
  await visible(page.getByTestId('hub-composer'), `type-${id}-active`);
} 

async function activatePlugin(page: Page, pluginId: string, title: RegExp, id: string) {
  await openMention(page, '@local');
  const option = page.getByRole('option', { name: title });
  await visible(option, id); await option.hover();
  await page.getByTestId('home-hero-plugin-hover-card').getByRole('button').click();
  await page.getByTestId(`plugin-details-use-${pluginId}`).click();
  await visible(page.getByTestId('home-hero-active-plugin'), id);
}

async function captureCreation(page: Page) {
  const request = page.waitForRequest(candidate => candidate.method() === 'POST' && new URL(candidate.url()).pathname === '/api/projects');
  await page.getByTestId('home-hero-submit').click();
  return (await request).postDataJSON() as Record<string, unknown>;
}

async function activateReportPreset(page: Page, id: string) {
  await chooseType(page, 'prototype');
  const preset = page
    .getByTestId('home-hero-plugin-presets')
    .getByRole('listitem')
    .filter({ hasText: /Report Writer/i });
  await expect(preset).toHaveCount(1);
  await visible(preset, id);
  await expect(preset).toHaveAttribute('data-plugin-id', 'example-report');
  const replacement = page.getByRole('dialog', { name: /Replace current prompt/i });
  const priorPrompt = await composer(page).innerText();
  const priorPluginLocator = page.getByTestId('home-hero-active-plugin');
  const priorPluginCount = await priorPluginLocator.count();
  expect(priorPluginCount).toBeLessThanOrEqual(1);
  const priorPlugin = priorPluginCount === 1 ? await priorPluginLocator.innerText() : null;
  await preset.click();
  await visible(replacement, id);
  if (id === 'regression-30') {
    await replacement.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(replacement).toHaveCount(0);
    await expect(composer(page)).toHaveText(priorPrompt);
    const restoredPlugin = page.getByTestId('home-hero-active-plugin');
    await expect(restoredPlugin).toHaveCount(priorPluginCount);
    if (priorPlugin === null) {
      await expect(restoredPlugin).toHaveCount(0);
    } else {
      await expect(restoredPlugin).toHaveText(priorPlugin);
    }
    await preset.click();
    await visible(replacement, id);
  }
  await replacement.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(replacement).toHaveCount(0);
  await expect(composer(page)).not.toHaveText('');
  await expect(composer(page)).not.toHaveText(priorPrompt);
  await expect(page.getByTestId('home-hero-active-plugin')).toContainText('Report Writer');
}

async function activateStaticPromptExample(page: Page, id: string) {
  const driver = HOME_PLUGINS.find(plugin => plugin.id === 'localized-plugin');
  if (!driver) throw new Error('Static prompt fallback driver fixture is missing');
  await page.route('**/api/plugins', async route => route.fulfill({ json: { plugins: [{
    ...driver,
    id: 'example-web-prototype',
    title: 'Web Prototype Driver',
    source: '/tmp/example-web-prototype',
    fsPath: '/tmp/example-web-prototype',
    manifest: {
      ...driver.manifest,
      name: 'example-web-prototype',
      title: 'Web Prototype Driver',
      readable: {
        ...driver.manifest.readable,
        useCase: { mode: 'prototype' },
        inputs: ARTIFACT_INPUTS,
      },
    },
  }] } }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('.readable-loading-shell')).toHaveCount(0, { timeout: 15_000 });
  await visible(page.getByTestId('entry-view-home'), id);
  await chooseType(page, 'prototype');
  const examples = page.getByTestId('home-hero-prompt-examples');
  const example = examples.getByTestId('home-hero-prompt-example').first();
  await visible(example, id);
  await expect(example).not.toHaveAttribute('data-plugin-id');
  const priorPrompt = await composer(page).innerText();
  await example.click();
  const seededPrompt = await composer(page).innerText();
  expect(seededPrompt.trim()).not.toBe('');
  expect(seededPrompt).not.toBe(priorPrompt);
  await expect(composer(page)).toBeFocused();
}

async function expectArtifactFooterControlsContained(page: Page, evidenceName: 'fidelity' | 'speaker-notes') {
  for (const width of [1280, 1440]) {
    await page.setViewportSize({ width, height: 720 });
    const geometry = await page.locator('.home-hero__input-foot').evaluate((footer) => {
      const container = footer.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const controls = Array.from(footer.querySelectorAll<HTMLElement>('button, input'))
        .filter((control) => {
          const style = getComputedStyle(control);
          const rect = control.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        })
        .map((control) => {
          const rect = control.getBoundingClientRect();
          return {
            id: control.dataset.testid ?? control.getAttribute('aria-label') ?? control.textContent?.trim() ?? control.tagName,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
            contained: rect.left >= container.left - 1 && rect.right <= container.right + 1,
            viewportSafe: rect.left >= -1 && rect.right <= viewportWidth + 1,
          };
        });
      return {
        viewportWidth,
        container: { left: container.left, right: container.right, top: container.top, bottom: container.bottom },
        controls,
      };
    });
    expect(geometry.controls.filter((control) => !control.contained || !control.viewportSafe)).toEqual([]);
    const evidenceDir = process.env.READABLE_F1_EVIDENCE_DIR;
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(`${evidenceDir}/${evidenceName}-${width}.json`, `${JSON.stringify(geometry, null, 2)}\n`, 'utf8');
      await page.screenshot({ path: `${evidenceDir}/${evidenceName}-${width}.png` });
    }
  }
}

async function operateFooter(page: Page, field: 'fidelity' | 'model' | 'ratio' | 'duration' | 'resolution', optionName: RegExp, id: string) {
  await chooseType(page, 'prototype');
  const preset = page.locator('[data-testid="home-hero-plugin-preset"][data-plugin-id="example-web-prototype"]');
  await preset.click();
  const replacement = page.getByRole('dialog', { name: /Replace current prompt/i });
  if (await replacement.isVisible()) await replacement.getByRole('button', { name: /Replace/i }).click();
  const trigger = page.getByTestId(`home-hero-footer-option-${field}`); await visible(trigger, id); await trigger.click();
  const option = page.getByRole('option', { name: optionName }); await visible(option, id); await option.click();
  await expect(trigger).toContainText(optionName);
  if (field === 'fidelity') await expectArtifactFooterControlsContained(page, 'fidelity');
  await trigger.click();
  await expect(page.getByRole('option', { name: optionName })).toHaveAttribute('aria-selected', 'true');
  await trigger.click();
}

async function operateSubtypes(page: Page, restoreAll: boolean, id: string) {
  await chooseType(page, 'prototype');
  const all = page.getByTestId('home-hero-subtype-all'); const category = page.getByTestId('home-hero-subtype-business-dashboards');
  await visible(category, id); await expect(page.getByTestId('home-hero-subtype-count-business-dashboards')).toHaveText('2');
  const total = await page.getByTestId('home-hero-plugin-preset').count(); await category.click();
  await expect(category).toHaveAttribute('aria-selected', 'true'); await expect(all).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByTestId('home-hero-plugin-preset')).toHaveCount(2);
  if (restoreAll) { await all.click(); await expect(all).toHaveAttribute('aria-selected', 'true'); await expect(page.getByTestId('home-hero-plugin-preset')).toHaveCount(total); }
}

async function openPlus(page: Page) {
  const plus = page.getByTestId('home-hero-plus-trigger'); await visible(plus, 'plus'); await plus.click();
  await expect(plus).toHaveAttribute('aria-expanded', 'true');
}

async function stageFile(page: Page, name = 'reachability.txt', mimeType = 'text/plain') {
  const input = page.getByTestId('home-hero-file-input');
  await expect(input).toHaveCount(1, { timeout: 700 });
  await input.setInputFiles({ name, mimeType, buffer: Buffer.from('reachability fixture') });
  await visible(page.getByTestId('home-hero-staged-files').getByText(name, { exact: true }), 'staged-file');
}

function composer(page: Page) {
  return page.locator('.home-hero [contenteditable="true"]').first();
}

async function openMention(page: Page, query = '@') {
  const control = page.getByTestId('home-hero-context-control');
  await visible(control, 'context-control');
  await composer(page).click();
  await composer(page).pressSequentially(query);
  await visible(page.getByTestId('home-hero-plugin-picker'), 'mention-picker');
}

async function operate(page: Page, kind: AssertionKind, control: Control) {
  const id = control.id;
  switch (kind) {
    case 'composer': { const input = composer(page); await visible(input, id); await input.fill('operable composer'); await expect(input).toContainText('operable composer').catch(async () => expect(input).toHaveValue('operable composer')); return; }
    case 'design-system': { const picker = page.getByTestId('hub-design-system').or(page.getByTestId('home-hero-footer-option-designSystem')).first(); await visible(picker, id); if (await picker.evaluate(el => el.tagName === 'SELECT')) { await picker.selectOption('airbnb'); await expect(picker).toHaveValue('airbnb'); } else { await picker.click(); await expect(picker).toHaveAttribute('aria-expanded', 'true'); } return; }
    case 'submit': { const input = composer(page); await visible(input, id); await input.fill('reachability submit'); const button = page.getByTestId('hub-send').or(page.getByTestId('home-hero-submit')).first(); await expect(button).toBeEnabled(); const request = page.waitForRequest(r => r.method() === 'POST' && new URL(r.url()).pathname === '/api/projects'); await button.click(); await request; return; }
    case 'file-input': await stageFile(page); return;
    case 'file-remove': await stageFile(page); { const remove = page.getByRole('button', { name: /Remove reachability\.txt/i }); await visible(remove, id); await remove.click(); await expect(page.getByTestId('home-hero-staged-files')).toHaveCount(0); } return;
    case 'preview-close': await stageFile(page, 'pixel.png', 'image/png'); { const preview = page.getByRole('button', { name: /Preview pixel\.png/i }); const dialog = page.getByRole('dialog', { name: 'pixel.png' }); await preview.click(); await visible(dialog, id); await dialog.getByRole('button', { name: /Close/i }).click(); await expect(dialog).toHaveCount(0); await preview.click(); const box = await dialog.boundingBox(); expect(box).not.toBeNull(); if (box) await page.mouse.click(box.x + box.width - 3, box.y + box.height - 3); await expect(dialog).toHaveCount(0); await preview.click(); await visible(dialog, id); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); } return;
    case 'plus-open': await openPlus(page); return;
    case 'plus-attach': await openPlus(page); { const attach = page.getByTestId('composer-plus-attach'); await visible(attach, id); const chooser = page.waitForEvent('filechooser'); await attach.click(); await chooser; } return;
    case 'plus-plugins': await openPlus(page); { const row = page.getByRole('menuitem', { name: /Plugins/i }).first(); await visible(row, id); await row.hover(); await visible(page.getByRole('menuitem', { name: /Localized Plugin/i }), id); } return;
    case 'plus-plugin-pick': await openPlus(page); { await page.getByRole('menuitem', { name: /Plugins/i }).first().hover(); const search = page.getByRole('textbox', { name: /Plugins/i }); await search.fill('Localized'); const option = page.getByRole('menuitem', { name: /Localized Plugin/i }); await option.hover(); await visible(page.locator('.plus-menu__preview[data-plugin-id="localized-plugin"]'), id); await option.click(); await expect(composer(page)).toContainText(/Localized Plugin/i); } return;
    case 'plus-add-plugin': await openPlus(page); { const row = page.getByRole('menuitem', { name: /Plugins/i }).first(); await visible(row, id); await row.hover(); const add = page.getByRole('menuitem', { name: /Add plugin/i }); await visible(add, id); await add.click(); await expect(page).toHaveURL(/\/plugins$/); } return;
    case 'plus-mcp': await openPlus(page); { const row = page.getByRole('menuitem', { name: /^MCP$/i }); await visible(row, id); await row.hover(); await visible(page.getByRole('menuitem', { name: /QA MCP/i }), id); } return;
    case 'plus-mcp-pick': await openPlus(page); { await page.getByRole('menuitem', { name: /^MCP$/i }).hover(); await page.getByRole('textbox', { name: /^MCP$/i }).fill('QA'); const option = page.getByRole('menuitem', { name: /QA MCP/i }); await visible(option, id); await option.click(); await expect(composer(page)).toContainText(/QA MCP/i); } return;
    case 'plus-add-mcp': await openPlus(page); { const row = page.getByRole('menuitem', { name: /^MCP$/i }); await visible(row, id); await row.hover(); const add = page.getByRole('menuitem', { name: /Add MCP/i }); await visible(add, id); await add.click(); await expect(page).toHaveURL(/\/integrations$/); } return;
    case 'mention-all': case 'mention-files': case 'mention-plugins': case 'mention-skills': case 'mention-mcp': { await openMention(page); const names = { 'mention-all': /^All$/i, 'mention-files': /Files/i, 'mention-plugins': /Plugins/i, 'mention-skills': /Skills/i, 'mention-mcp': /^MCP$/i } as const; const tab = page.getByRole('tab', { name: names[kind] }); await visible(tab, id); await tab.click(); await expect(tab).toHaveAttribute('aria-selected', 'true'); return; }
    case 'mention-option': case 'mention-keyboard': await openMention(page, '@local'); { const option = page.getByRole('option', { name: /Localized Plugin/i }); await visible(option, id); if (kind === 'mention-keyboard') { await page.getByTestId('home-hero-input').press('ArrowDown'); await page.getByTestId('home-hero-input').press('Enter'); } else await option.click(); await expect(page.getByTestId('home-hero-plugin-picker')).toHaveCount(0); } return;
    case 'plugin-details': { await openMention(page, '@local'); const option = page.getByRole('option', { name: /Localized Plugin/i }); await option.hover(); const details = page.getByTestId('home-hero-plugin-hover-card').getByRole('button'); await visible(details, id); await details.click(); const dialog = page.getByRole('dialog', { name: /Localized Plugin/i }); await visible(dialog, id); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); return; }
    case 'plugin-clear': case 'plugin-route': { await activatePlugin(page, 'localized-plugin', /Localized Plugin/i, id); const chip = page.getByTestId('home-hero-active-plugin'); if (kind === 'plugin-clear') { await chip.getByRole('button', { name: /Clear active plugin/i }).click(); await expect(chip).toHaveCount(0); } else { const topic = page.getByTestId('home-hero-footer-option-topic'); await topic.fill('routing observables'); await composer(page).pressSequentially(' plugin route'); const applyResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/plugins/localized-plugin/apply'); const creationRequest = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/projects'); await page.getByTestId('home-hero-submit').click(); const applied = await (await applyResponse).json(); expect(applied).toMatchObject({ appliedPlugin: { snapshotId: 'snap-localized-plugin', pluginId: 'localized-plugin', inputs: { topic: 'routing observables' }, resolvedContext: { items: [expect.objectContaining({ id: 'fixture-context' })] } } }); expect((await creationRequest).postDataJSON()).toMatchObject({ pluginId: 'localized-plugin', appliedPluginSnapshotId: 'snap-localized-plugin', pluginInputs: { topic: 'routing observables' } }); } return; }
    case 'skill-clear': case 'skill-route': { await openMention(page); const tab = page.getByRole('tab', { name: /Skills/i }); await tab.click(); const option = page.getByRole('option', { name: /QA Skill/i }); await option.click(); const chip = page.getByTestId('home-hero-active-skill'); await visible(chip, id); if (kind === 'skill-clear') { await chip.getByRole('button').click(); await expect(chip).toHaveCount(0); } else { await composer(page).fill('skill routed creation'); const payload = await captureCreation(page); expect(payload).toMatchObject({ skillId: 'qa-skill', pendingPrompt: 'skill routed creation' }); expect(payload).not.toHaveProperty('pluginId'); } return; }
    case 'context-clear': { await openMention(page, '@local'); const option = page.getByRole('option', { name: /Localized Plugin/i }); await option.hover(); const details = page.getByTestId('home-hero-plugin-hover-card').getByRole('button'); await visible(details, id); await details.click(); await page.getByTestId('plugin-details-use-localized-plugin').click(); const chip = page.getByTestId('home-hero-active-plugin'); await visible(chip, id); const clear = chip.getByRole('button', { name: /Clear active plugin/i }); await visible(clear, id); await clear.click(); await expect(chip).toHaveCount(0); return; }
    case 'mode': case 'mode-route': { const toggle = page.getByTestId('session-mode-trigger'); await visible(toggle, id); await toggle.click(); const ask = page.getByRole('menuitemradio', { name: /Ask mode/i }); await ask.click(); if (kind === 'mode-route') { await composer(page).fill('mode routed creation'); expect(await captureCreation(page)).toMatchObject({ conversationMode: 'chat', pendingPrompt: 'mode routed creation' }); } else { await toggle.click(); await expect(page.getByRole('menuitemradio', { name: /Ask mode/i })).toHaveAttribute('aria-checked', 'true'); } return; }
    case 'continue': { await page.getByTestId('hub-open-palette').click(); const input = page.getByTestId('hub-palette-input'); await input.fill('Continue without'); const command = page.getByTestId('hub-palette-item-command-create-continue'); await visible(command, id); const req = page.waitForRequest(r => r.method() === 'POST' && new URL(r.url()).pathname === '/api/projects'); await command.click(); await req; return; }
    case 'prototype': case 'deck': case 'report': await chooseType(page, kind); return;
    case 'more': { await page.getByTestId('hub-open-palette').click(); await visible(page.getByTestId('hub-command-palette'), id); await visible(page.getByTestId('hub-palette-item-command-create-create-plugin'), id); return; }
    case 'create-plugin': case 'figma': case 'template': { await page.getByTestId('hub-open-palette').click(); const input = page.getByTestId('hub-palette-input'); const label = kind === 'create-plugin' ? 'Create plugin' : kind === 'figma' ? 'From Figma' : 'From template'; await input.fill(label); const command = page.getByTestId(`hub-palette-item-command-create-${kind}`); await visible(command, id); await command.click(); if (kind === 'template') await visible(page.getByTestId('new-project-modal'), id); else if (kind === 'create-plugin') await expect(composer(page)).toContainText(/plugin/i); else await visible(page.getByRole('alert'), id); return; }
    case 'subtype-all': await operateSubtypes(page, true, id); return;
    case 'subtype-category': await operateSubtypes(page, false, id); return;
    case 'type-clear': await chooseType(page, 'prototype'); { const chip = page.getByTestId('home-hero-active-type-chip'); await visible(chip, id); await chip.click(); await expect(chip).toHaveCount(0); } return;
    case 'prompt-example': await activateStaticPromptExample(page, id); return;
    case 'preset': await activateReportPreset(page, id); return;
    case 'speaker-notes': { await chooseType(page, 'deck'); const notes = page.getByTestId('home-hero-footer-option-speakerNotes'); await visible(notes, id); await expect(notes).toHaveAttribute('aria-pressed', 'false'); await notes.focus(); await page.keyboard.press('Space'); await expect(notes).toHaveAttribute('aria-pressed', 'true'); await expectArtifactFooterControlsContained(page, 'speaker-notes'); return; }
    case 'fidelity': await operateFooter(page, 'fidelity', /Wireframe/i, id); return;
    case 'model': await operateFooter(page, 'model', /quality/i, id); return;
    case 'ratio': await operateFooter(page, 'ratio', /4:3/i, id); return;
    case 'duration': await operateFooter(page, 'duration', /long/i, id); return;
    case 'resolution': await operateFooter(page, 'resolution', /4k/i, id); return;
    case 'view-all': { const library = page.getByTestId('hub-library'); await visible(library, id); await library.click(); const button = page.getByTestId('hub-library-projects'); await visible(button, id); await button.click(); await expect(page).toHaveURL(/\/projects$/); return; }
    case 'recent-card': { await page.getByTestId('hub-open-palette').click(); const input = page.getByTestId('hub-palette-input'); await input.fill('Zulu Running Project'); const card = page.getByTestId('hub-palette-item-project-qa-running'); await visible(card, id); await card.click(); await expect(page).toHaveURL(/\/projects\/qa-running/); return; }
    case 'replace-cancel': case 'replace-confirm': { await chooseType(page, 'prototype'); await composer(page).fill('keep this prompt'); const presets = page.getByTestId('home-hero-plugin-presets'); await visible(presets, id); const preset = presets.locator('[data-testid="home-hero-plugin-preset"]').first(); await preset.click(); const dialog = page.getByRole('dialog'); await visible(dialog, id); const action = kind === 'replace-cancel' ? dialog.getByRole('button', { name: /Cancel/i }) : dialog.getByRole('button', { name: /Replace/i }); await action.click(); await expect(dialog).toHaveCount(0); return; }
    case 'drop-file': case 'paste-file': { const input = composer(page); await visible(input, id); await input.evaluate((element, eventKind) => {
      const file = new File(['fixture'], `${eventKind}.txt`, { type: 'text/plain' });
      const dataTransfer = new DataTransfer(); dataTransfer.items.add(file);
      const event = eventKind === 'drop' ? new DragEvent('drop', { bubbles: true, dataTransfer }) : new ClipboardEvent('paste', { bubbles: true, clipboardData: dataTransfer });
      element.dispatchEvent(event);
    }, kind === 'drop-file' ? 'drop' : 'paste'); await visible(page.getByTestId('home-hero-staged-files'), id); return; }
    case 'attachment-only': await stageFile(page); { const submit = page.getByTestId('home-hero-submit'); await expect(submit).toBeEnabled(); const req = page.waitForRequest(r => r.method() === 'POST' && new URL(r.url()).pathname === '/api/projects'); await submit.click(); await req; } return;
    case 'plugin-validation': { await chooseType(page, 'prototype'); const preset = page.locator('[data-testid="home-hero-plugin-preset"][data-plugin-id="required-input-plugin"]'); await visible(preset, id); await preset.click(); const replacement = page.getByRole('dialog', { name: /Replace current prompt/i }); if (await replacement.isVisible()) await replacement.getByRole('button', { name: /Replace/i }).click(); const brief = page.getByTestId('home-hero-footer-option-brief'); await visible(brief, id); await expect(brief).toHaveValue(''); const posts: string[] = []; page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/projects') posts.push(request.url()); }); await composer(page).press('Control+Enter'); const alert = page.getByTestId('home-hero-error'); await visible(alert, id); await expect(alert).toContainText('Audience brief'); await expect(page.getByTestId('home-hero-submit')).toBeDisabled(); expect(posts).toEqual([]); return; }
    case 'dynamic-input': { await activateReportPreset(page, id); const input = page.getByTestId('home-hero-footer-option-designSystem'); await visible(input, id); await expect(input).toBeEnabled(); await input.click(); await expect(page.getByRole('option', { name: 'Airbnb', exact: true })).toBeVisible(); const airbnb = page.getByTestId('project-ds-picker-option-airbnb'); await expect(airbnb).toHaveCount(1); await expect(airbnb).toBeEnabled(); await airbnb.click(); await expect(input).toContainText('Airbnb'); await input.click(); await expect(page.getByTestId('project-ds-picker-option-airbnb')).toHaveAttribute('aria-selected', 'true'); await input.click(); const applyRequest = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/plugins/example-report/apply'); const creationRequest = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/projects'); await page.getByTestId('home-hero-submit').click(); expect((await applyRequest).postDataJSON()).toMatchObject({ inputs: { designSystem: 'Airbnb' } }); expect((await creationRequest).postDataJSON()).toMatchObject({ pluginId: 'example-report', pluginInputs: { designSystem: 'Airbnb' } }); return; }
    case 'rich-mention': await openMention(page, '@local'); await page.getByRole('option', { name: /Localized Plugin/i }).click(); { const input = page.getByTestId('home-hero-input'); await expect(input).toHaveText(/Localized Plugin/); await input.press('Backspace'); await expect(input).not.toHaveText(/Localized Plugin/); } return;
    case 'visible-error': { await page.route('**/api/plugins/localized-plugin/apply', async route => route.fulfill({ status: 500, json: { error: 'forced reachability failure' } })); await chooseType(page, 'prototype'); const presets = page.getByTestId('home-hero-plugin-presets'); await visible(presets, id); await presets.locator('[data-testid="home-hero-plugin-preset"]').first().click(); await visible(page.getByRole('alert'), id); return; }
    case 'rail-toggle': { const toggle = page.getByTestId('hub-rail-toggle'); await visible(toggle, id); const before = await page.locator('.hub').getAttribute('data-rail-collapsed'); await toggle.click(); await expect(page.locator('.hub')).not.toHaveAttribute('data-rail-collapsed', before ?? ''); return; }
    case 'nav-projects': case 'nav-tasks': case 'nav-plugins': case 'nav-design-systems': case 'nav-integrations': { const suffix = kind.replace('nav-', ''); const routeSuffix = suffix === 'tasks' ? 'automations' : suffix; const library = page.getByTestId('hub-library'); await visible(library, id); await library.click(); const nav = page.getByTestId(`hub-library-${suffix}`); await visible(nav, id); await nav.click(); await expect(page).toHaveURL(new RegExp(`/${routeSuffix}$`)); return; }
    case 'help': { const help = page.getByRole('button', { name: /Help/i }).first(); await visible(help, id); await help.click(); await expect(help).toHaveAttribute('aria-expanded', 'true'); return; }
    case 'first-run-guide': { await page.evaluate(() => window.localStorage.removeItem('readable-studio:home-guide-stage')); await page.route('**/api/projects', async route => { if (route.request().method() === 'GET') await route.fulfill({ json: { projects: [] } }); else await route.fulfill({ json: { project: PROJECTS[0], conversationId: 'created-session' } }); }); await page.reload({ waitUntil: 'domcontentloaded' }); await visible(page.getByTestId('entry-view-home'), id); await expect(page.locator('.home-hero__guide-sheen, [data-guide-active="true"]').first()).toBeVisible({ timeout: 2_000 }); return; }
    case 'import-folder': { await openNewProjectModal(page, id); const button = page.getByTestId('new-project-modal').getByRole('button', { name: /Open folder/i }); await visible(button, id); const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/dialog/open-folder' && r.status() === 200); await Promise.all([response, button.click()]); return; }
    case 'onboarding-absent': { await page.addInitScript(({ key, value }) => window.localStorage.setItem(key, JSON.stringify(value)), { key: STORAGE_KEY, value: { ...HOME_CONFIG, onboardingCompleted: false } }); await page.route('**/api/app-config', async route => route.fulfill({ json: { config: { ...HOME_CONFIG, onboardingCompleted: false } } })); await page.goto('/onboarding', { waitUntil: 'domcontentloaded' }); await expect(page.locator('.onboarding-view'), `[${id}] onboarding must not render`).toHaveCount(0); await visible(page.getByTestId('entry-view-home'), id); return; }
    case 'c-hierarchy': { const project = page.getByTestId('hub-project-qa-running'); await visible(project, id); await expect(project).toHaveAttribute('aria-expanded', 'true'); await project.evaluate(element => (element as HTMLElement).click()); await expect(project).toHaveAttribute('aria-expanded', 'false'); await project.evaluate(element => (element as HTMLElement).click()); await expect(project).toHaveAttribute('aria-expanded', 'true'); return; }
    case 'c-status': { await visible(page.getByTestId('hub-session-qa-session-1'), id); await expect(page.getByTestId('hub-session-qa-session-1')).toHaveAttribute('data-state', 'running'); await expect(page.getByTestId('hub-session-qa-session-2')).toHaveAttribute('data-state', 'failed'); await expect(page.getByTestId('hub-project-qa-attention')).toHaveAttribute('data-state', 'awaiting'); return; }
    case 'c-overflow': { const more = page.getByTestId('hub-tree-more-qa-running'); await visible(more, id); await more.click(); await expect(more).toHaveCount(0); await expect(page.getByTestId('hub-session-qa-session-6')).toHaveCount(1); return; }
    case 'c-running': { const strip = page.getByTestId('hub-live-strip'); await visible(strip, id); await strip.click(); await expect(page).toHaveURL(/\/projects\/qa-running\/conversations\/qa-session-1$/); return; }
    case 'c-filter': { const filter = page.getByTestId('hub-filter-running'); await visible(filter, id); await expect(filter.locator('.hub-tree__count')).toHaveText('1'); await filter.click(); await expect(filter).toHaveAttribute('aria-pressed', 'true'); await expect(page.getByTestId('hub-project-qa-attention')).toHaveCount(0); return; }
    case 'c-empty': { await page.getByTestId('hub-search').fill('no deterministic match'); await page.getByTestId('hub-filter-running').click(); const empty = page.getByTestId('hub-tree-empty'); await visible(empty, id); await empty.getByRole('button').click(); await expect(page.getByTestId('hub-filter-all')).toHaveAttribute('aria-pressed', 'true'); return; }
    case 'c-sort': { const body = page.locator('.hub-tree__body'); await expect(body.getByRole('treeitem', { level: 1 }).first()).toContainText('Zulu'); await page.getByTestId('hub-sort').click(); const menu = page.getByTestId('hub-sort-menu'); await visible(menu, id); await menu.getByRole('menuitem', { name: /Name/i }).click(); await expect(body.getByRole('treeitem', { level: 1 }).first()).toContainText('Alpha'); return; }
    case 'c-keyboard': { const first = page.getByTestId('hub-project-qa-running'); await visible(first, id); await first.focus(); await first.press('ArrowDown'); await expect(page.getByTestId('hub-session-qa-session-1')).toBeFocused(); await page.keyboard.press('Home'); await expect(first).toBeFocused(); return; }
    case 'c-claude': { await openNewProjectModal(page, id); const button = page.getByTestId('new-project-modal').getByRole('button', { name: /Import Claude Design ZIP/i }); await visible(button, id); const chooser = page.waitForEvent('filechooser'); await button.click(); await chooser; return; }
    // The rail is glass now, not a painted gradient: assert the material that
    // actually makes it glass - a real backdrop blur over a translucent fill -
    // plus the rounded surface the mockup keeps.
    case 'c-blur': { const nav = page.getByTestId('hub-nav'); await visible(nav, id); const surface = await nav.evaluate(element => {
      const style = getComputedStyle(element);
      const alphaOf = (color: string) => { const parts = (color.match(/[\d.]+/g) ?? []).map(Number); return parts.length > 3 ? (parts[3] as number) : 1; };
      return {
        backdropFilter: style.backdropFilter || style.getPropertyValue('-webkit-backdrop-filter'),
        backgroundColor: style.backgroundColor,
        backgroundAlpha: alphaOf(style.backgroundColor),
        borderRadius: style.borderRadius,
        borderTopWidth: style.borderTopWidth,
      };
    }); expect(surface.backdropFilter, `[${id}] rail must carry a real backdrop blur`).toMatch(/blur\(\s*[1-9][\d.]*px\s*\)/); expect(surface.backgroundAlpha, `[${id}] rail fill must stay translucent so the blur is visible`).toBeGreaterThan(0); expect(surface.backgroundAlpha).toBeLessThan(1); expect(surface.borderRadius).not.toBe('0px'); expect(surface.borderTopWidth, `[${id}] the glass rail is borderless`).toBe('0px'); return; }
  }
}

test.beforeEach(async ({ page }) => { await seedHome(page); await gotoHome(page); });

for (const control of CONTROLS) {
  test(`[capability:${control.id}] ${control.label}`, async ({ page }) => {
    await operate(page, ASSERTION_KIND_BY_ID[control.id], control);
  });
}
