import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error('Pass an absolute output directory');
const oldOnly = process.argv.includes('--old-only');
const improvedOnly = process.argv.includes('--improved-only');
const limitArg = process.argv.find(arg => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;
const ledger = JSON.parse(readFileSync('scripts/mainModeComparison.json', 'utf8')) as {
  runs: { name: string; status: string; full: string; minimal: string; mapId?: string }[]
};
const retestFile = 'scripts/mainModeRetest.json';
const retests = existsSync(retestFile)
  ? new Map((JSON.parse(readFileSync(retestFile, 'utf8')) as typeof ledger).runs.map(run => [run.name, run]))
  : new Map<string, (typeof ledger.runs)[number]>();
const improvedFile = 'scripts/mainModeImprovedComparison.json';
const improved = existsSync(improvedFile)
  ? new Map((JSON.parse(readFileSync(improvedFile, 'utf8')) as typeof ledger).runs.map(run => [run.name, run]))
  : new Map<string, (typeof ledger.runs)[number]>();
const modulePath = process.env.STUDY_PLAYWRIGHT ?? 'C:/Users/31483/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const { chromium } = await import(pathToFileURL(modulePath).href);
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'] });
mkdirSync(path.join(output, 'images'), { recursive: true });
let captured = 0;
try {
  outer: for (const [index, run] of ledger.runs.entries()) {
    const retest = retests.get(run.name);
    const mainId = retest?.status === 'saved' ? retest.mapId : run.status === 'saved' ? run.mapId : undefined;
    const improvedRun = improved.get(run.name);
    const maps = improvedOnly
      ? improvedRun?.status === 'saved' && improvedRun.mapId ? [{ mode: 'improved', id: improvedRun.mapId }] : []
      : [{ mode: 'full', id: run.full }, { mode: 'minimal', id: run.minimal },
        ...(!oldOnly && mainId ? [{ mode: 'main', id: mainId }] : [])];
    for (const { mode, id } of maps) for (const view of ['top', 'oblique']) {
      const name = `${String(index + 1).padStart(2, '0')}-${mode}-${view}.png`;
      const file = path.join(output, 'images', name);
      if (existsSync(file)) continue;
      if (captured >= limit) break outer;
      const page = await browser.newPage({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 1 });
      try {
        if (id === 'map-515e68b5-68cc-4bb9') {
          // This archived DeepSeek asset contains 26 nodes with null numeric geometry.
          // Omit only those unrenderable nodes in the screenshot response; keep the saved map intact.
          await page.route(`**/api/editor/maps/${id}`, async route => {
            const response = await route.fetch();
            const body = await response.json();
            for (const asset of body.map.assets ?? []) {
              if (asset.name !== '防雷塔') continue;
              asset.modelJson.nodes = asset.modelJson.nodes.filter((node: any) =>
                [...(node.transform?.pos ?? []), ...(node.transform?.quat ?? []), ...Object.values(node.mesh?.params ?? {})]
                  .every(value => value !== null));
            }
            await route.fulfill({ response, json: body });
          });
        }
        await page.goto(`http://127.0.0.1:5180/scripts/apiAblationPreview.html?map=${id}&view=${view}&framing=study`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForFunction(() => (window as any).apiAblationReady || (window as any).apiAblationError, { timeout: 60_000 });
        const error = await page.evaluate(() => (window as any).apiAblationError);
        if (error) throw new Error(String(error));
        await page.screenshot({ path: file });
        captured++;
        console.log(`${captured} ${run.name} ${mode} ${view}`);
      } catch (error) {
        console.error(`CAPTURE_FAILED ${name}: ${error}`);
      } finally { await page.close(); }
    }
  }
} finally { await browser.close(); }
console.log(`CAPTURED ${captured}`);
