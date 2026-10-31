// Bundles our own TypeScript for the desktop app; npm packages stay external and are shipped by electron-builder.
import { build } from 'esbuild';

const common = { bundle: true, platform: 'node', target: 'node22', sourcemap: false, logLevel: 'info' };

// main process + the server it embeds (ESM: the code uses import.meta.dirname and top-level await)
await build({
  ...common,
  entryPoints: ['electron/main.ts'],
  outfile: 'dist-electron/main.js',
  format: 'esm',
  packages: 'external',
  external: ['electron'],
});

// preload must be CommonJS to run in the sandbox
await build({
  ...common,
  entryPoints: ['electron/preload.cts'],
  outfile: 'dist-electron/preload.cjs',
  format: 'cjs',
  external: ['electron'],
});
