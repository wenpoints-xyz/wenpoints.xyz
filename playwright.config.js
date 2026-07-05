const { defineConfig, devices } = require('@playwright/test');

// Serves the static site/ dir and runs the guestbook E2E suite against it.
module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:8099',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'python3 -m http.server 8099 --directory site',
    port: 8099,
    reuseExistingServer: !process.env.CI,
  },
});
