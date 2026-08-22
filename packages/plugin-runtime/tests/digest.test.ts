import { describe, expect, it } from 'vitest';
import { manifestSourceDigest } from '../src/digest';
import type { PluginManifest } from '@readable-studio/contracts';

const baseManifest: PluginManifest = {
  name: 'sample-plugin',
  title: 'Sample Plugin',
  version: '1.0.0',
  description: 'Fixture for digest tests.',
  readable: {
    kind: 'skill',
    taskKind: 'new-generation',
    useCase: { query: 'Make a {{topic}} brief.' },
    inputs: [{ name: 'topic', type: 'string', required: true }],
  },
};

describe('manifestSourceDigest', () => {
  // Pinned hex values guard against accidental drift in the canonical
  // serializer. If a Phase 1+ refactor changes them, update the fixtures
  // *and* document the migration impact in the plan.
  it('digests the empty-input case to a stable hex', () => {
    const digest = manifestSourceDigest({
      manifest: baseManifest,
      inputs: {},
      resolvedContextRefs: [],
    });
    expect(digest).toBe('462708192b92b495e8fa8f610ee27407d5e37881bc8cebba71a4d8ac44d4ab1b');
  });

  it('digests the topic-input case to a stable hex', () => {
    const digest = manifestSourceDigest({
      manifest: baseManifest,
      inputs: { topic: 'agentic design' },
      resolvedContextRefs: [
        { kind: 'skill', ref: 'sample-plugin' },
        { kind: 'design-system', ref: 'linear-clone' },
      ],
    });
    expect(digest).toBe('078cab2d428f8f0133e722b4ea6ff801874f3052a584a0a1bb3920506016dc2a');
  });

  it('produces the same digest regardless of object key order', () => {
    const a = manifestSourceDigest({
      manifest: baseManifest,
      inputs: { audience: 'VC', topic: 'design' },
      resolvedContextRefs: [
        { kind: 'skill', ref: 'sample-plugin' },
        { kind: 'craft', ref: 'typography' },
      ],
    });
    const b = manifestSourceDigest({
      manifest: { ...baseManifest, description: baseManifest.description },
      inputs: { topic: 'design', audience: 'VC' },
      resolvedContextRefs: [
        { kind: 'skill', ref: 'sample-plugin' },
        { kind: 'craft', ref: 'typography' },
      ],
    });
    expect(a).toBe(b);
  });

  it('changes when an input value changes', () => {
    const a = manifestSourceDigest({
      manifest: baseManifest,
      inputs: { topic: 'design' },
      resolvedContextRefs: [],
    });
    const b = manifestSourceDigest({
      manifest: baseManifest,
      inputs: { topic: 'engineering' },
      resolvedContextRefs: [],
    });
    expect(a).not.toBe(b);
  });
});
