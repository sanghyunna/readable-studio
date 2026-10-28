import { describe, expect, it } from 'vitest';
import type {
  DesignTemplateImportManifest,
  DesignTemplateType,
  DesignTemplateTypeDetection,
  DesignTemplateUploadAnalyseResponse,
  DesignTemplateUploadAnalysisResponse,
  DesignTemplateUploadBundleCancelResponse,
  DesignTemplateUploadCancelResponse,
  DesignTemplateUploadFinalizeRequest,
  DesignTemplateUploadFinalizeResponse,
  UploadableDesignTemplateType,
  UserDesignTemplateSummary,
} from '../src/index';

// Compile-time pins for the upload-wizard contract shared by daemon, web and
// CLI (tsconfig.tests.json typechecks this file); runtime asserts keep the
// example payloads honest.
const thumbnail = { status: 'pending', source: null, updatedAt: '2026-10-19T00:00:00.000Z' } as const;

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

describe('design template upload contract', () => {
  it('describes analysis, finalize and cancel payloads', () => {
    const request: DesignTemplateUploadFinalizeRequest = { type: 'report', name: 'Kit', coverPageId: analysis.suggestedCoverPageId };
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

  it('uploads deck or report only while reads keep website', () => {
    const uploadable: UploadableDesignTemplateType[] = ['deck', 'report'];
    const readable: DesignTemplateType[] = [...uploadable, 'website'];
    // @ts-expect-error website templates can no longer be uploaded
    const website: UploadableDesignTemplateType = 'website';
    // @ts-expect-error finalize accepts deck|report overrides only
    const websiteFinalize: DesignTemplateUploadFinalizeRequest = { type: 'website', name: 'Site', coverPageId: 'page-1' };
    expect(readable).toEqual(['deck', 'report', 'website']);
    expect([website, websiteFinalize.type]).toEqual(['website', 'website']);
  });

  it('carries an optional detection and an optional finalize type override', () => {
    const detection: DesignTemplateTypeDetection = { type: 'report', confidence: 'low', ambiguous: true, signals: ['no-signal'] };
    const detected: DesignTemplateUploadAnalysisResponse = { ...analysis, kind: 'single', detectedType: detection.type, detection };
    const detectedOnly: DesignTemplateUploadFinalizeRequest = { name: 'Kit', coverPageId: 'page-1' };
    expect(detected.detection?.ambiguous).toBe(true);
    expect(detectedOnly.type ?? detected.detectedType ?? 'deck').toBe('report');
    expect(analysis.detection).toBeUndefined();
  });

  it('narrows the analyse response to a single session or a bundle with per-item results', () => {
    const responses: DesignTemplateUploadAnalyseResponse[] = [
      analysis,
      { ...analysis, kind: 'single' },
      {
        kind: 'bundle',
        bundleId: 'b'.repeat(32),
        expiresAt: '2026-10-19T01:00:00.000Z',
        originalFileName: 'bundle.zip',
        templates: [
          { index: 0, entryName: 'a.zip', ok: true, analysis: { ...analysis, kind: 'single', bundleId: 'b'.repeat(32) } },
          { index: 1, entryName: 'b.zip', ok: false, reason: 'nested bundles are not supported' },
        ],
      },
    ];
    const sessions = responses.flatMap((response) => {
      if (response.kind === 'bundle') {
        return response.templates.map((item) => (item.ok ? item.analysis.sessionId : `failed:${item.reason}`));
      }
      return [response.sessionId];
    });
    expect(sessions).toEqual(['a'.repeat(32), 'a'.repeat(32), 'a'.repeat(32), 'failed:nested bundles are not supported']);
    const cancelled: DesignTemplateUploadBundleCancelResponse = { ok: true, cancelledSessionIds: ['a'.repeat(32)] };
    expect(cancelled.cancelledSessionIds).toHaveLength(1);
  });
});
