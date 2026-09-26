import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error('Pass an absolute output directory');
const only = process.argv.find(arg => arg.startsWith('--name='))?.slice('--name='.length);
const runs = (JSON.parse(readFileSync('scripts/groundCoverComparison.json', 'utf8')) as {
  runs: { name: string; status: string; mapId?: string }[]
}).runs;
const baseline = (JSON.parse(readFileSync('scripts/mainModeComparison.json', 'utf8')) as {
  runs: { name: string; full: string; minimal: string; mapId?: string; status: string }[]
}).runs;
const retests = new Map((JSON.parse(readFileSync('scripts/mainModeRetest.json', 'utf8')) as {
  runs: { name: string; mapId?: string; status: string }[]
}).runs.map(run => [run.name, run]));
const improved = new Map((JSON.parse(readFileSync('scripts/mainModeImprovedComparison.json', 'utf8')) as {
  runs: { name: string; mapId?: string; status: string }[]
}).runs.map(run => [run.name, run]));
const modulePath = process.env.STUDY_PLAYWRIGHT
  ?? 'C:/Users/31483/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const { chromium } = await import(pathToFileURL(modulePath).href);
const browser = await chromium.launch({ headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'] });
mkdirSync(path.join(output, 'images'), { recursive: true });
try {
  for (const run of runs) {
    if (only && run.name !== only) continue;
    if (run.status !== 'saved' || !run.mapId) continue;
    const index = baseline.findIndex(item => item.name === run.name);
    if (index < 0) throw new Error(`Missing baseline: ${run.name}`);
    const prior = baseline[index];
    const retest = retests.get(run.name);
    const mainId = retest?.status === 'saved' ? retest.mapId : prior.status === 'saved' ? prior.mapId : undefined;
    const improvedRun = improved.get(run.name);
    const maps = [{ mode: 'full', id: prior.full }, { mode: 'minimal', id: prior.minimal },
      ...(mainId ? [{ mode: 'main', id: mainId }] : []),
      ...(improvedRun?.status === 'saved' && improvedRun.mapId ? [{ mode: 'improved', id: improvedRun.mapId }] : []),
      { mode: 'ground', id: run.mapId }];
    for (const { mode, id } of maps) for (const view of ['top', 'oblique'] as const) {
      const file = path.join(output, 'images', `${String(index + 1).padStart(2, '0')}-${mode}-${view}.png`);
      const page = await browser.newPage({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 1 });
      try {
        await page.goto(`http://127.0.0.1:5180/scripts/apiAblationPreview.html?map=${id}&view=${view}&framing=study`,
          { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForFunction(() => (window as any).apiAblationReady || (window as any).apiAblationError,
          { timeout: 60_000 });
        const error = await page.evaluate(() => (window as any).apiAblationError);
        if (error) throw new Error(String(error));
        await page.screenshot({ path: file });
        console.log(`${run.name} ${mode} ${view}: ${file}`);
      } finally { await page.close(); }
    }
  }
} finally { await browser.close(); }
