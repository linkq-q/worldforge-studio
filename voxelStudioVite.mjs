import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('.', import.meta.url));

/**
 * WorldForge vendors a fixed Voxel Render Runtime snapshot. Both it and Three
 * resolve from this checkout's node_modules tree, preventing split Three.js
 * identities that would break runtime material checks.
 */
export function resolveVoxelStudioRoot(override) {
  const root = path.resolve(override || REPO_ROOT).replaceAll('\\', '/');
  const missing = [
    `${root}/node_modules/@voxel-studio/render-runtime/src/index.js`,
    `${root}/node_modules/three/build/three.module.js`
  ].filter((file) => !existsSync(file));
  if (missing.length > 0) {
    throw new Error([
      `WorldForge runtime is not installed: ${root}`,
      ...missing.map((file) => `  missing ${file}`),
      '',
      'Run npm install in the WorldForge Studio checkout first.'
    ].join('\n'));
  }
  return root;
}

/** Vite aliases keep application and runtime imports on the same Three.js build. */
export function voxelStudioAliases(override, cacheKey) {
  const root = resolveVoxelStudioRoot(override);
  const runtime = `${root}/node_modules/@voxel-studio/render-runtime`;
  const version = cacheKey ? `?v=${encodeURIComponent(cacheKey)}` : '';
  return [
    {
      find: '@voxel-studio/render-runtime/model/material-tags-v1.json',
      replacement: `${runtime}/model/material-tags-v1.json${version}`
    },
    { find: '@voxel-studio/render-runtime/postprocess', replacement: `${runtime}/src/postprocess.js${version}` },
    { find: '@voxel-studio/render-runtime/outline', replacement: `${runtime}/src/outline.js${version}` },
    { find: '@voxel-studio/render-runtime/environment', replacement: `${runtime}/src/environment.js${version}` },
    { find: '@voxel-studio/render-runtime/effects', replacement: `${runtime}/src/effects.js${version}` },
    { find: /^@voxel-studio\/render-runtime$/, replacement: `${runtime}/src/index.js${version}` },
    { find: /^three$/, replacement: `${root}/node_modules/three/build/three.module.js` },
    { find: /^three\/examples\/jsm\/(.*)$/, replacement: `${root}/node_modules/three/examples/jsm/$1` }
  ];
}
