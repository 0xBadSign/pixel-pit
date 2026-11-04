import { defineConfig } from 'vitest/config';

// Anvil end-to-end suite (e2e/anvil.test.ts). Compiles the DEV branch of config.ts (deployment.dev.json,
// chainId 31337, http://127.0.0.1:8545) exactly like `VITE_ENV=dev vite build` does. See e2e/README.md.
export default defineConfig({
  define: { __PIT_DEV__: 'true' },
  test: {
    environment: 'node',
    include: ['e2e/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
