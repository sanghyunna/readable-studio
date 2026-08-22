import type { Express } from 'express';

import type { RouteDeps } from '../server-context.js';
import { listSystemFonts } from '../system-fonts.js';

export interface RegisterSystemFontsRoutesDeps extends RouteDeps<'http'> {}

/**
 * `GET /api/system/fonts` — the fonts installed on the machine running the
 * daemon, for the manual-edit typography picker and the export font-embed
 * step. `?refresh=1` rescans (fonts rarely change mid-session, so the result
 * is otherwise cached for the daemon lifetime). Windows-only enumeration;
 * other platforms return `{ fonts: [], platform: 'unsupported' }`.
 */
export function registerSystemFontsRoutes(app: Express, ctx: RegisterSystemFontsRoutesDeps) {
  const { sendApiError } = ctx.http;

  app.get('/api/system/fonts', async (req, res) => {
    try {
      const refresh = ['1', 'true', 'yes', 'on'].includes(
        String(req.query.refresh ?? '').trim().toLowerCase(),
      );
      const result = await listSystemFonts({ refresh });
      res.json(result);
    } catch (err: any) {
      sendApiError(res, 500, 'SYSTEM_FONTS_FAILED', String(err?.message || err));
    }
  });
}
