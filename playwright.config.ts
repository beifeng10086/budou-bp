import { defineConfig } from '@playwright/test'

const externalBaseURL = process.env.BP_BASE_URL

export default defineConfig({
  testDir: './tests/browser',
  timeout: 60000,
  workers: 1,
  use: {
    baseURL: externalBaseURL ?? 'http://127.0.0.1:8790',
    launchOptions: { executablePath: process.env.BP_BROWSER_PATH || undefined },
  },
  webServer: externalBaseURL ? undefined : {
    command: 'npm run server',
    env: { PORT: '8790' },
    url: 'http://127.0.0.1:8790/health',
    reuseExistingServer: false,
  },
})
