import { describe, expect, it } from 'vitest';

import {
  HOSTED_PREVIEW_SCOPE_LIMITS,
  createHostedPreviewScopeRegistry,
  type HostedPreviewScopeBinding,
} from '../src/hosted-preview-scope.js';

const binding: HostedPreviewScopeBinding = {
  userKey: 'user-a',
  generation: 1,
  projectId: 'project-a',
  filePath: 'slides/index.html',
};

describe('hosted preview scope registry', () => {
  it('mints an opaque API URL bound to owner, generation, project, and canonical file', () => {
    const registry = createHostedPreviewScopeRegistry();
    try {
      const grant = registry.mint(binding);
      expect(grant.token).toMatch(/^odpv_[A-Za-z0-9_-]{43}$/u);
      expect(grant.url).toBe(
        `/api/projects/project-a/preview/${grant.token}/slides/index.html`,
      );
      expect(grant.url).not.toContain('file:');
      expect(grant.url).not.toContain('C:');
      expect(grant.browserProof).toMatch(/^odpb_[A-Za-z0-9_-]{43}$/u);
      expect(registry.validate(grant.token, binding, grant.browserProof)).toBe(true);
      expect(registry.resolve(grant.token, {
        projectId: binding.projectId,
        browserProof: grant.browserProof,
      })).toEqual(binding);
      expect(registry.resolve(grant.token, {
        projectId: 'project-b',
        browserProof: grant.browserProof,
      })).toBeNull();

      for (const copied of [
        { ...binding, userKey: 'user-b' },
        { ...binding, generation: 2 },
        { ...binding, projectId: 'project-b' },
        { ...binding, filePath: 'slides/other.html' },
      ]) expect(registry.validate(grant.token, copied, grant.browserProof)).toBe(false);
      expect(registry.validate(grant.token, binding, 'odpb_invalid')).toBe(false);
      expect(registry.validate('odpv_invalid', binding, grant.browserProof)).toBe(false);
    } finally {
      registry.dispose();
    }
  });

  it('rejects non-canonical or filesystem-bearing bindings without consuming capacity', () => {
    const registry = createHostedPreviewScopeRegistry();
    try {
      for (const filePath of [
        '',
        '.',
        '../index.html',
        'slides/../index.html',
        '/index.html',
        'slides\\index.html',
        'C:/private/index.html',
        'index.html:secret',
        'slides//index.html',
      ]) expect(() => registry.mint({ ...binding, filePath })).toThrow(TypeError);

      const grant = registry.mint(binding);
      expect(registry.validate(grant.token, binding, grant.browserProof)).toBe(true);
    } finally {
      registry.dispose();
    }
  });

  it('caps lifetime and expires scopes fail closed', () => {
    let now = 1_000;
    const registry = createHostedPreviewScopeRegistry({ now: () => now });
    try {
      expect(() => registry.mint(binding, { ttlMs: 0 })).toThrow(TypeError);
      expect(() => registry.mint(binding, {
        ttlMs: HOSTED_PREVIEW_SCOPE_LIMITS.maxTtlMs + 1,
      })).toThrow(TypeError);

      const grant = registry.mint(binding, { ttlMs: 1_000 });
      expect(grant.expiresAt).toBe(new Date(2_000).toISOString());
      now = 2_000;
      expect(registry.validate(grant.token, binding, grant.browserProof)).toBe(false);
      expect(registry.resolve(grant.token, {
        projectId: binding.projectId,
        browserProof: grant.browserProof,
      })).toBeNull();
      now = 2_001;
      expect(registry.validate(grant.token, binding, grant.browserProof)).toBe(false);
    } finally {
      registry.dispose();
    }
  });

  it('enforces the per-user cap atomically and generation revocation releases it', () => {
    const registry = createHostedPreviewScopeRegistry();
    try {
      const grants = Array.from({ length: HOSTED_PREVIEW_SCOPE_LIMITS.perUser }, (_, index) => (
        registry.mint({ ...binding, filePath: `slides/${index}.html` })
      ));
      expect(() => registry.mint({ ...binding, filePath: 'overflow.html' }))
        .toThrowError(expect.objectContaining({ code: 'HOSTED_OVERLOADED' }));
      for (const [index, grant] of grants.entries()) {
        expect(registry.validate(grant.token, {
          ...binding,
          filePath: `slides/${index}.html`,
        }, grant.browserProof)).toBe(true);
      }

      expect(registry.revokeGeneration({ userKey: binding.userKey, generation: 2 })).toBe(0);
      expect(registry.revokeGeneration({ userKey: binding.userKey, generation: 1 }))
        .toBe(HOSTED_PREVIEW_SCOPE_LIMITS.perUser);
      expect(registry.validate(grants[0]!.token, binding, grants[0]!.browserProof)).toBe(false);
      expect(() => registry.mint(binding)).not.toThrow();
    } finally {
      registry.dispose();
    }
  });

  it('enforces global capacity and releases it on generation revocation', () => {
    const registry = createHostedPreviewScopeRegistry();
    try {
      for (let index = 0; index < HOSTED_PREVIEW_SCOPE_LIMITS.global; index += 1) {
        registry.mint({
          ...binding,
          userKey: `user-${Math.floor(index / HOSTED_PREVIEW_SCOPE_LIMITS.perUser)}`,
          projectId: `project-${index}`,
          filePath: `${index}.html`,
        });
      }
      expect(() => registry.mint({
        ...binding,
        userKey: 'overflow-user',
        projectId: 'overflow-project',
      })).toThrowError(expect.objectContaining({ code: 'HOSTED_CAPACITY_EXHAUSTED' }));

      expect(registry.revokeGeneration({ userKey: 'user-0', generation: 1 }))
        .toBe(HOSTED_PREVIEW_SCOPE_LIMITS.perUser);
      expect(() => registry.mint({
        ...binding,
        userKey: 'overflow-user',
        projectId: 'overflow-project',
      })).not.toThrow();
    } finally {
      registry.dispose();
    }
  });

  it('dispose is idempotent and rejects both old and new scopes', () => {
    const registry = createHostedPreviewScopeRegistry();
    const grant = registry.mint(binding);
    registry.dispose();
    registry.dispose();
    expect(registry.validate(grant.token, binding, grant.browserProof)).toBe(false);
    expect(registry.revokeGeneration({ userKey: binding.userKey, generation: 1 })).toBe(0);
    expect(() => registry.mint(binding))
      .toThrowError(expect.objectContaining({ code: 'INTERNAL_ERROR' }));
  });
});
