import type { Express, Response } from 'express';
import type { UpdateSystemPromptRequest } from '@readable-studio/contracts';
import type { RouteDeps } from './server-context.js';
import {
  listEditableSystemPrompts,
  readEditableSystemPrompt,
  resetSystemPromptOverride,
  SystemPromptValidationError,
  UnknownSystemPromptError,
  updateSystemPromptOverride,
} from './prompts/user-overrides.js';

export interface RegisterSystemPromptRoutesDeps extends RouteDeps<'paths'> {}

function sendError(res: Response, error: unknown) {
  if (error instanceof UnknownSystemPromptError) {
    return res.status(404).json({ error: { code: 'SYSTEM_PROMPT_NOT_FOUND', message: error.message } });
  }
  if (error instanceof SystemPromptValidationError) {
    return res.status(400).json({
      error: {
        code: error.code,
        message: error.message,
        missingPlaceholders: error.missingPlaceholders,
        duplicatePlaceholders: error.duplicatePlaceholders,
      },
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message } });
}

export function registerSystemPromptRoutes(app: Express, ctx: RegisterSystemPromptRoutesDeps): void {
  const dataDir = ctx.paths.RUNTIME_DATA_DIR;

  app.get('/api/system-prompts', async (_req, res) => {
    try {
      res.json({ prompts: await listEditableSystemPrompts(dataDir) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/system-prompts/:id', async (req, res) => {
    try {
      res.json({ prompt: await readEditableSystemPrompt(dataDir, req.params.id) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put('/api/system-prompts/:id', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Partial<UpdateSystemPromptRequest>;
      res.json({ prompt: await updateSystemPromptOverride(dataDir, req.params.id, body.content) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.delete('/api/system-prompts/:id', async (req, res) => {
    try {
      res.json({ prompt: await resetSystemPromptOverride(dataDir, req.params.id) });
    } catch (error) {
      sendError(res, error);
    }
  });
}
