import { HOSTED_CSRF_HEADER } from '@readable-studio/contracts';
import express, { type Express, type RequestHandler } from 'express';

import type { createHostedCatalogueAdapter } from '../hosted-catalogue-adapter.js';
import type { createHostedDesignSystemToolAdapter } from '../hosted-design-system-tool-adapter.js';
import { hostedApiFailure } from './hosted-http.js';

export interface HostedCatalogueRouteDependencies {
  readonly authenticateIdentity: RequestHandler;
  readonly catalogue: ReturnType<typeof createHostedCatalogueAdapter>;
  readonly designSystemTool: ReturnType<typeof createHostedDesignSystemToolAdapter>;
  readonly noInput: RequestHandler;
  readonly rejectAuthorityMetadata: RequestHandler;
}

export function registerHostedCatalogueRoutes(
  app: Express,
  dependencies: HostedCatalogueRouteDependencies,
): void {
  const {
    authenticateIdentity,
    catalogue,
    designSystemTool,
    noInput,
    rejectAuthorityMetadata,
  } = dependencies;

  app.get('/api/agents/catalog', authenticateIdentity, rejectAuthorityMetadata, noInput, (_request, response) => {
    response.json(catalogue.dispatch({ kind: 'agents.list' }));
  });
  app.get('/api/skills', authenticateIdentity, rejectAuthorityMetadata, noInput, (_request, response) => {
    response.json(catalogue.dispatch({ kind: 'skills.list' }));
  });
  app.get('/api/skills/:id', authenticateIdentity, rejectAuthorityMetadata, noInput, (request, response) => {
    response.json(catalogue.dispatch({ kind: 'skill.get', id: request.params.id }));
  });
  app.get('/api/skills/:id/files', authenticateIdentity, rejectAuthorityMetadata, noInput, (request, response) => {
    response.json(catalogue.dispatch({ kind: 'skill.files', id: request.params.id }));
  });
  app.get('/api/design-systems', authenticateIdentity, rejectAuthorityMetadata, noInput, (_request, response) => {
    response.json(catalogue.dispatch({ kind: 'designSystems.list' }));
  });
  app.get('/api/design-systems/:id', authenticateIdentity, rejectAuthorityMetadata, noInput, (request, response) => {
    response.json(catalogue.dispatch({ kind: 'designSystem.get', id: request.params.id }));
  });

  const toolJson = express.json({ limit: 8 * 1024, strict: true });
  app.post('/api/tools/design-systems/read', async (request, response) => {
    const authorization = request.get('authorization');
    const token = authorization?.match(/^Bearer ([^\s]+)$/u)?.[1] ?? null;
    const carrierToken = request.get('x-readable-studio-tool-token') ?? null;
    if (token == null || carrierToken == null || carrierToken.length === 0) {
      hostedApiFailure(response, 403, 'TOOL_TOKEN_MISSING', 'hosted tool token is required');
      return;
    }
    response.json(await designSystemTool.read({
      auth: {
        token,
        carrierToken,
        cookiePresent: request.headers.cookie != null,
        csrfPresent: request.get(HOSTED_CSRF_HEADER) != null,
        origin: request.get('origin') ?? null,
      },
      readBody: () => new Promise((resolve, reject) => {
        toolJson(request, response, (error) => {
          if (error != null) reject(error);
          else resolve(request.body);
        });
      }),
    }));
  });
}
