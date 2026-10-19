import { describe, expect, it } from 'vitest';
import type {
  DesignTemplateImportManifest,
  DesignTemplateType,
  DesignTemplateUploadAnalysisResponse,
  DesignTemplateUploadCancelResponse,
  DesignTemplateUploadFinalizeRequest,
  DesignTemplateUploadFinalizeResponse,
  UserDesignTemplateSummary,
} from '../src/index';

// Compile-time pins for the upload-wizard contract shared by daemon, web and
// CLI (tsconfig.tests.json typechecks this file); runtime asserts keep the
// example payloads honest.
const thumbnail = { status: 'pending', source: null, updatedAt: '2026-10-19T00:00:00.000Z' } as const;

describe('design template upload contract', () => {
  it('describes analysis, finalize and cancel payloads', () => {
    const analysis: DesignTemplateUploadAnalysisResponse = {
      sessionId: 'a'.repeat(32),
      expiresAt: '2026-10-19T01:00:00.000Z',
      originalFileName: 'kit.zip',
      prompt: { file: 'PROMPT.md' },
      suggestedName: 'Kit Pack',
      suggestedCoverPageId: 'page-1',
      pages: [{
        id: 'page-1',
        file: 'kit/cover.html',
        use: 'Cover',
        previewUrl: '/api/design-template-uploads/x/pages/kit/cover.html',
        thumbnailUrl: '/api/design-template-uploads/x/thumbnails/page-1',
        thumbnail,
      }],
    };
    const types: DesignTemplateType[] = ['deck', 'report', 'website'];
    const request: DesignTemplateUploadFinalizeRequest = { type: types[1]!, name: 'Kit', coverPageId: analysis.suggestedCoverPageId };
    const cancel: DesignTemplateUploadCancelResponse = { ok: true };
    expect(analysis.pages[0]!.id).toBe(request.coverPageId);
    expect(cancel.ok).toBe(true);
  });

  it('keeps the template type optional on manifests and summaries', () => {
    const legacy: DesignTemplateImportManifest = {
      schemaVersion: 1, id: 'user-a', name: 'A', originalFileName: 'a.zip', importedAt: '', sha256: '',
      pages: [{ file: 'a.html' }], cover: 'a.html', thumbnail,
    };
    const typed: DesignTemplateImportManifest = { ...legacy, type: 'website' };
    const finalized: DesignTemplateUploadFinalizeResponse = {
      template: { id: 'user-a', userImported: true, thumbnail, templateType: 'report' } as UserDesignTemplateSummary,
    };
    expect(legacy.type ?? 'deck').toBe('deck');
    expect(typed.type).toBe('website');
    expect(finalized.template.templateType).toBe('report');
  });
});
