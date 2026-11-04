import { defineConfig } from 'vitest/config';

// Unit + jsdom screen tests. The anvil end-to-end suite lives in e2e/ and runs with `npm run e2e`
// (vitest.e2e.config.ts) because it needs a local chain.
export default defineConfig({
  define: { __PIT_DEV__: 'false' },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    testTimeout: 20000,
  },
});
