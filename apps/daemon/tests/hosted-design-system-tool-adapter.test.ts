import { describe, expect, it, vi } from 'vitest';

import {
  HOSTED_DESIGN_SYSTEM_CONTENT_MAX_BYTES,
  HOSTED_DESIGN_SYSTEM_GRANT_GLOBAL_LIMIT,
  HOSTED_DESIGN_SYSTEM_GRANT_MAX_TTL_MS,
  HOSTED_DESIGN_SYSTEM_READ_ENDPOINT,
  HostedDesignSystemToolAdapterError,
  createHostedDesignSystemToolAdapter,
  type HostedDesignSystemToolAuthInput,
  type HostedDesignSystemToolBinding,
  type HostedDesignSystemToolGrant,
} from '../src/hosted-design-system-tool-adapter.js';

const binding: HostedDesignSystemToolBinding = {
  userKey: 'user-a',
  runId: 'run-a',
  projectId: 'project-a',
  endpoint: HOSTED_DESIGN_SYSTEM_READ_ENDPOINT,
  generation: 1,
  designSystemId: 'calm-web',
};

const carrierFor = (index: number): string => `odpi_${String(index).padStart(43, 'A')}`;

function authFor(
  grant: HostedDesignSystemToolGrant,
  carrier = carrierFor(1),
): HostedDesignSystemToolAuthInput {
  return {
    token: grant.token,
    carrierToken: carrier,
    cookiePresent: false,
    csrfPresent: false,
    origin: null,
  };
}

function fixture() {
  const release = vi.fn();
  const validateBinding = vi.fn(() => ({ release }));
  const adapter = createHostedDesignSystemToolAdapter({
    catalogue: [{
      id: 'calm-web',
      files: [
        { path: 'DESIGN.md', content: '# Calm\n' },
        { path: 'preview/colors.html', content: '<h1>Colors</h1>' },
      ],
    }],
    validateBinding,
  });
  const grant = adapter.mintGrant(binding, { carrierToken: carrierFor(1) });
  return { adapter, auth: authFor(grant), grant, release, validateBinding };
}

describe('hosted design-system tool adapter', () => {
  it('rejects browser, missing-secret, and mixed-grant calls before validation or body parsing', async () => {
    const { adapter, auth, validateBinding } = fixture();
    try {
      const grantB = adapter.mintGrant({
        ...binding,
        userKey: 'user-b',
        runId: 'run-b',
        projectId: 'project-b',
      }, { carrierToken: carrierFor(2) });
      expect(() => adapter.mintGrant({
        ...binding,
        userKey: 'user-c',
      }, { carrierToken: carrierFor(1) }))
        .toThrowError(expect.objectContaining({ code: 'INTERNAL_ERROR' }));
      const invalidAuth: HostedDesignSystemToolAuthInput[] = [
        { ...auth, token: null },
        { ...auth, carrierToken: null },
        { ...auth, cookiePresent: true },
        { ...auth, csrfPresent: true },
        { ...auth, origin: 'https://hosted.example' },
        { ...auth, carrierToken: carrierFor(2) },
        { ...authFor(grantB, carrierFor(2)), carrierToken: auth.carrierToken },
      ];

      for (const candidate of invalidAuth) {
        const readBody = vi.fn(() => ({ path: 'DESIGN.md' }));
        await expect(adapter.read({ auth: candidate, readBody })).rejects.toBeInstanceOf(
          HostedDesignSystemToolAdapterError,
        );
        expect(readBody).not.toHaveBeenCalled();
      }
      expect(validateBinding).not.toHaveBeenCalled();
    } finally {
      adapter.dispose();
    }
  });

  it('holds the server-validated immutable binding through the complete read', async () => {
    let finishBody!: (value: unknown) => void;
    const body = new Promise<unknown>((resolve) => { finishBody = resolve; });
    const release = vi.fn();
    const validateBinding = vi.fn(() => ({ release }));
    const mutableBinding = { ...binding };
    const adapter = createHostedDesignSystemToolAdapter({
      catalogue: [{ id: 'calm-web', files: [{ path: 'DESIGN.md', content: '# Calm\n' }] }],
      validateBinding,
    });
    const grant = adapter.mintGrant(mutableBinding, { carrierToken: carrierFor(1) });
    mutableBinding.userKey = 'changed-user';
    mutableBinding.runId = 'changed-run';
    mutableBinding.projectId = 'changed-project';
    mutableBinding.generation = 9;
    mutableBinding.designSystemId = 'changed-system';
    try {
      const read = adapter.read({ auth: authFor(grant), readBody: () => body });
      await vi.waitFor(() => expect(validateBinding).toHaveBeenCalledOnce());
      expect(validateBinding).toHaveBeenCalledWith(binding);
      expect(release).not.toHaveBeenCalled();

      finishBody({ path: 'DESIGN.md', designSystemId: 'calm-web' });
      await expect(read).resolves.toEqual({ content: '# Calm\n' });
      expect(release).toHaveBeenCalledOnce();
    } finally {
      adapter.dispose();
    }
  });

  it('rejects a stale server binding before reading the body', async () => {
    const readBody = vi.fn(() => ({ path: 'DESIGN.md' }));
    const adapter = createHostedDesignSystemToolAdapter({
      catalogue: [{ id: 'calm-web', files: [{ path: 'DESIGN.md', content: '# Calm\n' }] }],
      validateBinding: () => null,
    });
    const grant = adapter.mintGrant(binding, { carrierToken: carrierFor(1) });
    try {
      await expect(adapter.read({ auth: authFor(grant), readBody })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(readBody).not.toHaveBeenCalled();
    } finally {
      adapter.dispose();
    }
  });

  it('accepts only the exact V1 body and manifest-declared grant paths', async () => {
    const { adapter, auth, grant } = fixture();
    try {
      const response = await adapter.read({
        auth,
        readBody: () => ({ path: 'DESIGN.md', designSystemId: 'calm-web' }),
      });
      expect(response).toEqual({ content: '# Calm\n' });
      expect(Object.keys(response)).toEqual(['content']);
      expect(JSON.stringify(response)).not.toContain(grant.token);
      expect(JSON.stringify(response)).not.toContain(carrierFor(1));
      expect(JSON.stringify(response)).not.toContain('DESIGN.md');

      for (const body of [
        null,
        {},
        { path: '' },
        { path: '../DESIGN.md' },
        { path: 'DESIGN.md', owner: 'user-a' },
        { path: 'DESIGN.md', token: 'copied-token' },
        { path: 'DESIGN.md', carrier: 'copied-carrier' },
        { path: 'DESIGN.md', grant: {} },
        { path: 'DESIGN.md', root: 'C:\\private' },
        { path: 'DESIGN.md', designSystemId: '' },
        { path: 'x'.repeat(1_025) },
      ]) {
        await expect(adapter.read({ auth, readBody: () => body })).rejects.toMatchObject({
          code: 'BAD_REQUEST',
        });
      }

      await expect(adapter.read({
        auth,
        readBody: () => ({ path: 'DESIGN.md', designSystemId: 'other-brand' }),
      })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(adapter.read({
        auth,
        readBody: () => ({ path: 'preview/not-in-manifest.html' }),
      })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      adapter.dispose();
    }
  });

  it('releases binding validation when body parsing fails', async () => {
    const { adapter, auth, release } = fixture();
    try {
      await expect(adapter.read({
        auth,
        readBody: () => { throw new Error('broken body'); },
      })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(release).toHaveBeenCalledOnce();
    } finally {
      adapter.dispose();
    }
  });

  it('caps lifetime, replaces per user, and revokes by token or generation', async () => {
    let now = 1_000;
    const validateBinding = vi.fn(() => ({ release: vi.fn() }));
    const adapter = createHostedDesignSystemToolAdapter({
      catalogue: [{ id: 'calm-web', files: [{ path: 'DESIGN.md', content: '# Calm\n' }] }],
      now: () => now,
      validateBinding,
    });
    try {
      expect(() => adapter.mintGrant(binding, {
        carrierToken: carrierFor(1),
        ttlMs: HOSTED_DESIGN_SYSTEM_GRANT_MAX_TTL_MS + 1,
      })).toThrowError(expect.objectContaining({ code: 'INTERNAL_ERROR' }));
      expect(() => adapter.mintGrant(binding, { carrierToken: '' }))
        .toThrowError(expect.objectContaining({ code: 'INTERNAL_ERROR' }));

      const expiring = adapter.mintGrant(binding, { carrierToken: carrierFor(1), ttlMs: 1_000 });
      expect(expiring.expiresAt).toBe(new Date(2_000).toISOString());
      now = 2_000;
      const expiredBody = vi.fn(() => ({ path: 'DESIGN.md' }));
      await expect(adapter.read({ auth: authFor(expiring), readBody: expiredBody }))
        .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(expiredBody).not.toHaveBeenCalled();

      const replaced = adapter.mintGrant(binding, { carrierToken: carrierFor(1) });
      const replacement = adapter.mintGrant(
        { ...binding, runId: 'run-replacement' },
        { carrierToken: carrierFor(1) },
      );
      const replacedBody = vi.fn(() => ({ path: 'DESIGN.md' }));
      await expect(adapter.read({ auth: authFor(replaced), readBody: replacedBody }))
        .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(replacedBody).not.toHaveBeenCalled();

      expect(adapter.revokeGeneration({ userKey: binding.userKey, generation: 2 })).toBe(false);
      expect(adapter.revokeGeneration({ userKey: binding.userKey, generation: 1 })).toBe(true);
      expect(adapter.revoke(replacement.token)).toBe(false);

      const revoked = adapter.mintGrant(binding, { carrierToken: carrierFor(1) });
      expect(adapter.revoke(revoked.token)).toBe(true);
      expect(adapter.revoke(revoked.token)).toBe(false);
    } finally {
      adapter.dispose();
    }
  });

  it('enforces the 32-grant process cap while allowing in-place user replacement', () => {
    const adapter = createHostedDesignSystemToolAdapter({
      catalogue: [{ id: 'calm-web', files: [{ path: 'DESIGN.md', content: '# Calm\n' }] }],
      validateBinding: () => ({ release() {} }),
    });
    try {
      const grants = Array.from({ length: HOSTED_DESIGN_SYSTEM_GRANT_GLOBAL_LIMIT }, (_, index) => (
        adapter.mintGrant({
          ...binding,
          userKey: `user-${index}`,
          runId: `run-${index}`,
          projectId: `project-${index}`,
        }, { carrierToken: carrierFor(index) })
      ));
      expect(() => adapter.mintGrant({
        ...binding,
        userKey: 'overflow-user',
      }, { carrierToken: carrierFor(HOSTED_DESIGN_SYSTEM_GRANT_GLOBAL_LIMIT) }))
        .toThrowError(expect.objectContaining({ code: 'HOSTED_CAPACITY_EXHAUSTED' }));

      expect(() => adapter.mintGrant({
        ...binding,
        userKey: 'user-0',
        runId: 'replacement-run',
      }, { carrierToken: carrierFor(0) })).not.toThrow();
      expect(adapter.revoke(grants[0]!.token)).toBe(false);
    } finally {
      adapter.dispose();
    }
  });

  it('snapshots a bounded immutable manifest catalogue and disposes grants', async () => {
    const file = { path: 'DESIGN.md', content: '# Original\n' };
    const catalogue = [{ id: 'calm-web', files: [file] }];
    const adapter = createHostedDesignSystemToolAdapter({
      catalogue,
      validateBinding: () => ({ release() {} }),
    });
    const grant = adapter.mintGrant(binding, { carrierToken: carrierFor(1) });
    file.path = 'private.txt';
    file.content = 'secret';
    catalogue[0]!.files.push({ path: 'late.txt', content: 'late' });
    const response = await adapter.read({
      auth: authFor(grant),
      readBody: () => ({ path: 'DESIGN.md' }),
    });
    expect(response).toEqual({ content: '# Original\n' });
    await expect(adapter.read({
      auth: authFor(grant),
      readBody: () => ({ path: 'late.txt' }),
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    adapter.dispose();
    const disposedBody = vi.fn(() => ({ path: 'DESIGN.md' }));
    await expect(adapter.read({ auth: authFor(grant), readBody: disposedBody }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(disposedBody).not.toHaveBeenCalled();

    expect(() => createHostedDesignSystemToolAdapter({
      catalogue: [{
        id: 'calm-web',
        files: [{ path: 'DESIGN.md', content: 'x'.repeat(HOSTED_DESIGN_SYSTEM_CONTENT_MAX_BYTES + 1) }],
      }],
      validateBinding: () => ({ release() {} }),
    })).toThrowError(expect.objectContaining({ code: 'INTERNAL_ERROR' }));
  });
});
