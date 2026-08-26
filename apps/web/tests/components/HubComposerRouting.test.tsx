// @vitest-environment jsdom

// The welcome screen routed bare prompts through the hidden default scenario
// plugin with projectKind='other', so the agent asks for the exact task type.
// The hub composer replaced that surface and must keep the same routing.

import { describe, expect, it } from 'vitest';
import { DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID } from '@readable-studio/contracts';

import { buildHubSubmission } from '../../src/components/hub/buildHubSubmission';

describe('hub composer routing parity with the welcome screen', () => {
  it('routes bare prompts through the default scenario plugin', () => {
    const payload = buildHubSubmission('분기 리포트', { designSystemId: null });
    expect(payload.pluginId).toBe(DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID);
    expect(payload.pluginType).toBe('official');
  });

  it("stamps projectKind 'other' so the agent asks for the task type", () => {
    expect(buildHubSubmission('가격표', { designSystemId: null }).projectKind).toBe('other');
  });

  it('creates the conversation in design mode like the hero did', () => {
    expect(buildHubSubmission('가격표', { designSystemId: null }).conversationMode).toBe('design');
  });

  it('carries the composer design system and auto-sends the first message', () => {
    const payload = buildHubSubmission('분기 리포트', { designSystemId: 'aurora' });
    expect(payload.designSystemId).toBe('aurora');
    expect(payload.autoSendFirstMessage).toBe(true);
    expect(payload.prompt).toBe('분기 리포트');
  });

  it('never routes a skill alongside the scenario plugin', () => {
    // Scenario plugins and explicit skill picks are mutually exclusive (#2972).
    expect(buildHubSubmission('분기 리포트', { designSystemId: null }).skillId).toBeNull();
  });
});
