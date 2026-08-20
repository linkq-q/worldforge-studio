import { defineConfig } from 'vite';
import { voxelStudioAliases } from './voxelStudioVite.mjs';

export default defineConfig({
  base: './',
  resolve: {
    alias: voxelStudioAliases()
  },
  server: {
    port: 5180
  },
  test: {
    include: ['tests/**/*.test.ts']
  }
});
