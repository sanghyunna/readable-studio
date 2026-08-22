import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getAutomationSourcePacket,
  ingestAutomationSource,
  listAutomationSourcePackets,
} from '../src/automation-ingestions.js';
import {
  applyAutomationProposal,
  listAutomationProposals,
} from '../src/automation-proposals.js';
import { buildMemoryTree, readMemoryEntry } from '../src/memory.js';

let dataDir = '';

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'readable-automation-ingestions-'));
});

afterEach(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true });
});

describe('automation source ingestion', () => {

  it('uses design-system templates to draft design-system and memory proposals with compression evidence', async () => {
    const longBody = `# Brand notes\n\n${'Primary action color #335CFF. Use dense product dashboards. '.repeat(400)}`;
    const result = await ingestAutomationSource(dataDir, {
      templateId: 'extract-design-system',
      sourceKind: 'repo',
      sourceRef: 'https://github.com/acme/design',
      title: 'Acme brand notes',
      bodyMarkdown: longBody,
      tokenCompression: 'aggressive',
    });

    expect(result.compressionReport.status).toBe('applied');
    expect(result.compressionReport.afterTokens).toBeLessThan(
      result.compressionReport.beforeTokens,
    );
    expect(result.proposals.map((proposal) => proposal.targetKind).sort()).toEqual([
      'design-system',
      'memory-node',
    ]);
    expect(result.proposals.find((proposal) => proposal.targetKind === 'design-system')?.patch.after)
      .toContain('Acme brand notes Design System');

    const packets = await listAutomationSourcePackets(dataDir);
    expect(packets.map((packet) => packet.id)).toContain(result.packet.id);
  });
});

