import { defineConfig } from 'vite';

// Relative base so the build works from any path (hamsterpit.xyz/ or a sub-folder).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: false,
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        // one chunk: simpler size accounting, no preload tags
        manualChunks: undefined,
        inlineDynamicImports: true,
      },
    },
  },
  define: {
    // Dev deployment branch is a compile-time constant so prod tree-shakes it out.
    __PIT_DEV__: JSON.stringify(process.env.VITE_ENV === 'dev'),
  },
});
