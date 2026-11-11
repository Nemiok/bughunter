import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  outputDir: process.env.BUGHUNTER_PLAYWRIGHT_OUTPUT ?? '.playwright-output',
  use: {
    baseURL: process.env.BUGHUNTER_BASE_URL,
    channel: 'chrome',
    headless: true,
    launchOptions: { slowMo: Number(process.env.BUGHUNTER_SLOW_MO ?? 0) },
  },
});
