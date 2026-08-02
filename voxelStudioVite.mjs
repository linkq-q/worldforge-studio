import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('.', import.meta.url));

/**
 * Voxel Studio (`3d-generate`) ships the render runtime *and* the one `three`
 * build both repos must share — two copies of three break `instanceof` checks
 * inside the runtime and silently corrupt materials. It is a separate checkout,
 * so its location is configurable instead of assumed to be a sibling directory.
 */
export function resolveVoxelStudioRoot(override = process.env.VOXEL_STUDIO_ROOT) {
  const root = path.resolve(REPO_ROOT, override ?? '../3d-generate').replaceAll('\\', '/');
  const missing = [
    `${root}/packages/voxel-render-runtime/src/index.js`,
    `${root}/node_modules/three/build/three.module.js`
  ].filter((file) => !existsSync(file));
  if (missing.length > 0) {
    throw new Error([
      `找不到 Voxel Studio 运行时：${root}`,
      ...missing.map((file) => `  缺少 ${file}`),
      '',
      'WorldForge Studio 需要一份可用的 3d-generate 检出（并已在其中运行过 npm install）。',
      '目录不同时用环境变量指定，例如：VOXEL_STUDIO_ROOT=../../3d-generate npm run dev'
    ].join('\n'));
  }
  return root;
}

/**
 * Vite `resolve.alias` entries for the shared runtime and its `three` build.
 * Downstream projects that consume `worldforge-studio/viewer` need the exact
 * same aliases, so they import this instead of copying the table.
 */
export function voxelStudioAliases(override) {
  const root = resolveVoxelStudioRoot(override);
  const runtime = `${root}/packages/voxel-render-runtime`;
  return [
    {
      find: '@voxel-studio/render-runtime/model/material-tags-v1.json',
      replacement: `${runtime}/model/material-tags-v1.json`
    },
    { find: '@voxel-studio/render-runtime/postprocess', replacement: `${runtime}/src/postprocess.js` },
    { find: '@voxel-studio/render-runtime/outline', replacement: `${runtime}/src/outline.js` },
    { find: '@voxel-studio/render-runtime/environment', replacement: `${runtime}/src/environment.js` },
    { find: '@voxel-studio/render-runtime/effects', replacement: `${runtime}/src/effects.js` },
    { find: /^@voxel-studio\/render-runtime$/, replacement: `${runtime}/src/index.js` },
    { find: /^three$/, replacement: `${root}/node_modules/three/build/three.module.js` },
    { find: /^three\/examples\/jsm\/(.*)$/, replacement: `${root}/node_modules/three/examples/jsm/$1` }
  ];
}
