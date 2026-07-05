import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: process.env.BASE_URL ?? 'https://upload.tylercash.dev',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
});
