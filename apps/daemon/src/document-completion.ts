import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { emittedRenderableQuestionForm } from './question-form-detect.js';

export function expectedDocumentArtifact(options: {
  cwd: string | null;
  metadata?: { kind?: string; intent?: string; templateRef?: unknown };
  sessionMode: string;
  pluginAuthoring: boolean;
  appliedPluginSnapshotId?: string;
}): string | undefined {
  if (!options.cwd || options.pluginAuthoring || options.sessionMode === 'chat') return;
  const artifact = path.join(options.cwd, 'index.html');
  const metadata = options.metadata;
  const document = ['deck', 'report', 'website', 'prototype', 'template'].includes(metadata?.kind ?? '')
    || metadata?.intent === 'report' || !!metadata?.templateRef;
  if (document && !existsSync(artifact)) return artifact;
}

export function missingDocumentArtifact(artifact: string | undefined, text: string): boolean {
  return !!artifact && (!existsSync(artifact) || statSync(artifact).size === 0)
    && !emittedRenderableQuestionForm(text);
}

export function documentRecoveryPrompt(artifact: string): string {
  return `The required deliverable is missing: ${artifact}. Your previous turn did not save a non-empty index.html in the project root. Review failed tool results, correct the write, and verify the file on disk before claiming completion. Continue the original document request now; do not stop at a receipt or a plain-text question. If required user information is genuinely missing, ask using a question-form instead.`;
}
