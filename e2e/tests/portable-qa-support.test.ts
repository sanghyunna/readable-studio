import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { PortableQaError, validateEvidenceRoot, workspaceRoot } from '../scripts/portable-qa-support.ts';

const rejectionMessage = /evidence root .* is not inside the dedicated evidence directory .*; refusing to delete workspace, git, or ancestor paths/;

test('portable QA validates every evidence-root allow and deny case', () => {
  const evidenceRoot = resolve(workspaceRoot, '.omo', 'evidence');
  const cases = [
    ['workspace root', workspaceRoot, false],
    ['repository root', workspaceRoot, false],
    ['repository ancestor', resolve(workspaceRoot, '..'), false],
    ['git directory', resolve(workspaceRoot, '.git'), false],
    ['inside git directory', resolve(workspaceRoot, '.git', 'objects'), false],
    ['unrelated absolute path', resolve(tmpdir(), '..', 'foreign-evidence-root'), false],
    ['escaped traversal', resolve(evidenceRoot, '..', '..', 'escaped'), false],
    ['dedicated evidence subdirectory', resolve(evidenceRoot, 'portable-qa'), true],
    ['dedicated temp subdirectory', resolve(tmpdir(), 'portable-qa'), true],
  ] as const;

  for (const [label, path, accepted] of cases) {
    if (accepted) {
      assert.doesNotThrow(() => validateEvidenceRoot(path), label);
    } else {
      assert.throws(
        () => validateEvidenceRoot(path),
        (error: unknown) => error instanceof PortableQaError && rejectionMessage.test(error.message),
        label,
      );
    }
  }
});
