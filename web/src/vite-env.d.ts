/// <reference types="vite/client" />

/** Compile-time flag set in vite.config.ts from VITE_ENV=dev; false in production so the dev branch is tree-shaken. */
declare const __PIT_DEV__: boolean;
