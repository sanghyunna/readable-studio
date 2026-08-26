// Routing for prompts typed into the hub composer.
//
// The welcome screen this surface replaced sent free-form prompts through the
// hidden default scenario plugin with `projectKind: 'other'`, so the agent asks
// which artifact the user actually wants before generating. Keeping that shape
// here means the hub creates identically-routed projects.

import { DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID } from '@readable-studio/contracts';

import type { PluginLoopSubmit } from '../PluginLoopHome';

export function buildHubSubmission(
  prompt: string,
  options: { designSystemId: string | null },
): PluginLoopSubmit {
  return {
    prompt,
    pluginId: DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID,
    // The default router ships with the product, so it is an official plugin.
    pluginType: 'official',
    // Scenario plugins and explicit skill picks are mutually exclusive (#2972).
    skillId: null,
    appliedPluginSnapshotId: null,
    pluginTitle: null,
    taskKind: null,
    projectKind: 'other',
    conversationMode: 'design',
    autoSendFirstMessage: true,
    designSystemId: options.designSystemId,
  };
}
