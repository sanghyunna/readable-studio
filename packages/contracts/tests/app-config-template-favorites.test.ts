import { describe, expect, it } from 'vitest';
import {
  TEMPLATE_FAVORITES_MAX,
  type AppConfigPrefs,
  type UpdateAppConfigRequest,
} from '../src/index.js';

describe('templateFavorites contract', () => {
  it('exposes the list cap shared by daemon validation', () => {
    expect(TEMPLATE_FAVORITES_MAX).toBe(200);
  });

  it('types templateFavorites on the config and its update request', () => {
    const config: AppConfigPrefs = { templateFavorites: ['plugin-a', 'plugin-b'] };
    const ids: string[] = config.templateFavorites ?? [];
    const update: UpdateAppConfigRequest = { templateFavorites: ids };
    expect(update.templateFavorites).toEqual(['plugin-a', 'plugin-b']);
  });
});
