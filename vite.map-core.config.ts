import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/**
 * Bundles `src/shared` into one dependency-free ESM file. Bundling (rather than
 * `tsc` emit) is what makes the output runnable in plain Node: the sources use
 * extensionless relative imports, which Node ESM refuses to resolve.
 */
export default defineConfig({
  build: {
    outDir: 'dist-map-core',
    emptyOutDir: true,
    target: 'es2022',
    minify: false,
    lib: {
      entry: fileURLToPath(new URL('src/shared/index.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'index.js'
    }
  }
});
