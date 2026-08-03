import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { decodeWorldForgeTransfer, replaceRenderSchemeHdriFile } from '../src/shared/scenePackage';
import { MapStore } from '../src/server/mapStore';

interface GoldenPackManifest {
  kind: 'worldforge-golden-pack';
  scenes: Array<{ file: string; name: string }>;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input) throw new Error('usage: npm run handoff:verify -- <golden-pack.zip>');
  const files = unzipSync(new Uint8Array(await readFile(input)));
  const manifest = parseManifest(files['manifest.json']);
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'worldforge-golden-import-'));
  try {
    const store = new MapStore({ rootDir });
    await store.ensureReady();
    const verified: Array<{ name: string; assets: number; hdri: string | null }> = [];
    for (const entry of manifest.scenes) {
      const bytes = files[entry.file];
      if (!bytes) throw new Error(`golden_scene_missing:${entry.file}`);
      const transfer = decodeWorldForgeTransfer(bytes);
      if (transfer.kind !== 'scene') throw new Error(`golden_scene_invalid:${entry.file}`);
      let renderScheme = transfer.renderScheme;
      let hdri: string | null = null;
      if (transfer.hdri) {
        hdri = await store.importHdri(transfer.hdri.file, transfer.hdri.bytes);
        renderScheme = replaceRenderSchemeHdriFile(renderScheme, hdri);
      }
      const savedScheme = await store.saveRenderScheme(renderScheme);
      const imported = await store.importMap(transfer.map, savedScheme.id);
      const referencedAssets = new Set(imported.objects.map((object) => object.assetId).filter((id): id is string => Boolean(id)));
      if (referencedAssets.size !== imported.assets?.length) throw new Error(`golden_asset_hydration_failed:${entry.name}`);
      if (hdri && !await store.resolveHdriFile(hdri)) throw new Error(`golden_hdri_import_failed:${entry.name}`);
      verified.push({ name: imported.name, assets: imported.assets?.length ?? 0, hdri });
    }
    console.log(JSON.stringify({ ok: true, importedInto: rootDir, verified }, null, 2));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

function parseManifest(bytes: Uint8Array | undefined): GoldenPackManifest {
  if (!bytes) throw new Error('golden_manifest_missing');
  const manifest = JSON.parse(strFromU8(bytes)) as Partial<GoldenPackManifest>;
  if (manifest.kind !== 'worldforge-golden-pack' || !Array.isArray(manifest.scenes)) {
    throw new Error('golden_manifest_invalid');
  }
  return manifest as GoldenPackManifest;
}
