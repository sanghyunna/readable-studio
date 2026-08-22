import type { Request } from 'express';
import type { RouteInputContext } from './types.js';

export function rawInput(req: Request): RouteInputContext {
  return {
    body: req.body,
    query: (req.query ?? {}) as Record<string, unknown>,
    params: (req.params ?? {}) as Record<string, string>,
  };
}
