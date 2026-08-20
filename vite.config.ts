import { defineConfig } from 'vite';
import { voxelStudioAliases } from './voxelStudioVite.mjs';

export default defineConfig(({ command }) => ({
  base: './',
  resolve: {
    alias: voxelStudioAliases(undefined, command === 'serve' ? Date.now().toString(36) : undefined)
  },
  optimizeDeps: {
    exclude: ['@voxel-studio/render-runtime']
  },
  server: {
    port: 5180,
    headers: {
      'Cache-Control': 'no-store'
    }
  },
  test: {
    include: ['tests/**/*.test.ts']
  }
}));
