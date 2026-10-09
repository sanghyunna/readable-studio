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
    && !emittedRenderableQuestionForm(text)
    && !/<!-- readable:no-document-required reason="(?:read-only|no-file-changes|question)" -->\s*$/.test(text);
}

export function documentIntentPrompt(): string {
  return `Document delivery is conditional on the user's actual request, not the selected template or session type. Explicit user instructions, including not modifying files, take precedence over template, skill, and delivery instructions. If the user asks only a question, requests read-only inspection, or forbids file changes, do not create or update index.html or any other file. Answer the request and end with the hidden HTML comment <!-- readable:no-document-required reason="read-only" --> (use reason="no-file-changes" for an explicit prohibition or reason="question" for a question). Use this machine-readable completion signal only when no document is requested; never use it to excuse a failed or omitted write for a requested document.`;
}

export function documentRecoveryPrompt(artifact: string): string {
  return `${documentIntentPrompt()} First re-evaluate the original user request. A non-empty document was not saved at ${artifact}. If the user actually requested document creation or an update and allows file changes, review failed tool results, correct the write, and verify the file on disk before claiming completion. In that case, continue the original document request rather than stopping at a receipt or a plain-text question; if required user information is genuinely missing, ask using a question-form instead. Otherwise, answer without changing files and emit the artifact-free completion signal above.`;
}
