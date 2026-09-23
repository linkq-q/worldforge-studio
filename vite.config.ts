import { defineConfig } from 'vite';
import { voxelStudioAliases } from './voxelStudioVite.mjs';

// An unset variable must stay `undefined` in the bundle so the raw-codeplan
// gate keeps its branch default (raw pipeline on); baking '' would count as a
// set value instead. The former cap mirrors (WORLDFORGE_MAX_GRASS_LAYERS /
// _MAX_OPERATIONS) are gone: shared/ no longer caps AI-authored content.
const clientEnv = (value: string | undefined): string => value === undefined ? 'undefined' : JSON.stringify(value);

export default defineConfig(({ command }) => ({
  base: './',
  define: {
    // Raw-codeplan experiment: bake server env limits into the client bundle
    // so the editor renders unbounded AI scenes exactly as stored.
    'process.env.WORLDFORGE_RAW_CODEPLAN': clientEnv(process.env.WORLDFORGE_RAW_CODEPLAN)
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
