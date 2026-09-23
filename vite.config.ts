import { defineConfig } from 'vite';
import { voxelStudioAliases } from './voxelStudioVite.mjs';

// An unset variable must stay `undefined` in the bundle: the shared/ limit
// helpers treat undefined as "use the lifted raw-codeplan default" (512 grass
// layers / 50k operations), while any other invalid value — including the ''
// this used to bake — falls back to the legacy caps (8 / 2k) and makes
// applyMapOperations reject raw-codeplan scenes client-side.
const clientEnv = (value: string | undefined): string => value === undefined ? 'undefined' : JSON.stringify(value);

export default defineConfig(({ command }) => ({
  base: './',
  define: {
    // Raw-codeplan experiment: bake server env limits into the client bundle
    // so the editor renders unbounded AI scenes exactly as stored.
    'process.env.WORLDFORGE_RAW_CODEPLAN': clientEnv(process.env.WORLDFORGE_RAW_CODEPLAN),
    'process.env.WORLDFORGE_MAX_GRASS_LAYERS': clientEnv(process.env.WORLDFORGE_MAX_GRASS_LAYERS),
    'process.env.WORLDFORGE_MAX_OPERATIONS': clientEnv(process.env.WORLDFORGE_MAX_OPERATIONS)
  },
  resolve: {
    alias: voxelStudioAliases(undefined, command === 'serve' ? Date.now().toString(36) : undefined)
  },
  optimizeDeps: {
    exclude: ['@voxel-studio/render-runtime']
  },
  server: {
    port: 5174,
    headers: {
      'Cache-Control': 'no-store'
    }
  },
  test: {
    include: ['tests/**/*.test.ts']
  }
}));
