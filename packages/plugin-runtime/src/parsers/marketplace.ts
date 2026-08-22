import {
  MarketplaceManifestSchema,
  UNSUPPORTED_LEGACY_PRODUCT_V1,
  type MarketplaceManifest,
} from '@readable-studio/contracts';
import { isUnsupportedLegacyProductV1 } from './manifest.js';

export interface MarketplaceParseSuccess {
  ok: true;
  manifest: MarketplaceManifest;
}

export interface MarketplaceParseFailure {
  readonly ok: false;
  readonly code?: typeof UNSUPPORTED_LEGACY_PRODUCT_V1;
  readonly errors: string[];
}

export type MarketplaceParseResult = MarketplaceParseSuccess | MarketplaceParseFailure;

// @dsp func-8c1b17c7
export function parseMarketplace(raw: string): MarketplaceParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, errors: [`readable-studio-marketplace.json is not valid JSON: ${(err as Error).message}`] };
  }
  if (isUnsupportedLegacyProductV1(json)) {
    return { ok: false, code: UNSUPPORTED_LEGACY_PRODUCT_V1, errors: [UNSUPPORTED_LEGACY_PRODUCT_V1] };
  }
  const result = MarketplaceManifestSchema.safeParse(json);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
    };
  }
  return { ok: true, manifest: result.data };
}
