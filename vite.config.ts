import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const voxelStudioRoot = fileURLToPath(new URL('../3d-generate', import.meta.url)).replaceAll('\\', '/');

export default defineConfig({
  base: './',
  resolve: {
    alias: [
      {
        find: '@voxel-studio/render-runtime/postprocess',
        replacement: `${voxelStudioRoot}/packages/voxel-render-runtime/src/postprocess.js`
      },
      {
        find: '@voxel-studio/render-runtime/outline',
        replacement: `${voxelStudioRoot}/packages/voxel-render-runtime/src/outline.js`
      },
      {
        find: '@voxel-studio/render-runtime/environment',
        replacement: `${voxelStudioRoot}/packages/voxel-render-runtime/src/environment.js`
      },
      {
        find: '@voxel-studio/render-runtime/effects',
        replacement: `${voxelStudioRoot}/packages/voxel-render-runtime/src/effects.js`
      },
      {
        find: /^@voxel-studio\/render-runtime$/,
        replacement: `${voxelStudioRoot}/packages/voxel-render-runtime/src/index.js`
      },
      {
        find: /^three$/,
        replacement: `${voxelStudioRoot}/node_modules/three/build/three.module.js`
      },
      {
        find: /^three\/examples\/jsm\/(.*)$/,
        replacement: `${voxelStudioRoot}/node_modules/three/examples/jsm/$1`
      }
    ]
  },
  server: {
    port: 5173
  },
  test: {
    include: ['tests/**/*.test.ts']
  }
});
