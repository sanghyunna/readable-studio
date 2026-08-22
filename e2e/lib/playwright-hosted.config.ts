import { defineConfig } from '@playwright/test';

import baseConfig from '../playwright.config.ts';

const { webServer: _webServer, ...hostedConfig } = baseConfig;

export default defineConfig(hostedConfig);
