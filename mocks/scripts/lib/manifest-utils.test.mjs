import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { readManifest } from './manifest-utils.mjs';

const manifestPath = path.resolve(import.meta.dirname, '../../manifest.json');

test('manifest derived counts replay from immutable trace metadata', () => {
  // Given: the committed raw recording manifest.
  const manifest = readManifest(manifestPath);

  // When: every derived aggregate is rebuilt in memory from entries.
  const byAgent = {};
  const byOutcome = {};
  const bySkill = {};
  const sessions = {};
  let totalBytes = 0;
  for (const entry of manifest.entries) {
    byAgent[entry.agent] = (byAgent[entry.agent] ?? 0) + 1;
    byOutcome[entry.outcome] = (byOutcome[entry.outcome] ?? 0) + 1;
    for (const skill of entry.skills) bySkill[skill] = (bySkill[skill] ?? 0) + 1;
    if (entry.session_id) (sessions[entry.session_id] ??= []).push(entry.trace_id);
    totalBytes += entry.bytes;
  }

  // Then: the checked-in derived fields exactly match their canonical entries.
  assert.equal(manifest.total, manifest.entries.length);
  assert.equal(manifest.total_bytes, totalBytes);
  assert.deepEqual(manifest.histograms, {
    by_agent: byAgent,
    by_outcome: byOutcome,
    by_skill: bySkill,
  });
  assert.equal(
    manifest.sessions_with_multi_turn,
    Object.values(sessions).filter((traceIds) => traceIds.length >= 2).length,
  );
  for (const entry of manifest.entries) {
    assert.equal(entry.multi_turn, Boolean(entry.session_id && sessions[entry.session_id].length >= 2));
  }
});
