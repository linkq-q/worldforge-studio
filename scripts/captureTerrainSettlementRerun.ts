import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error('Pass an absolute output directory');
const runs = (JSON.parse(readFileSync('scripts/terrainSettlementRerun.json', 'utf8')) as {
  runs: { name: string; status: string; mapId?: string }[]
}).runs;
const baseline = (JSON.parse(readFileSync('scripts/mainModeComparison.json', 'utf8')) as {
  runs: { name: string }[]
}).runs;
const modulePath = process.env.STUDY_PLAYWRIGHT
  ?? 'C:/Users/31483/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const { chromium } = await import(pathToFileURL(modulePath).href);
const browser = await chromium.launch({ headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'] });
mkdirSync(path.join(output, 'images'), { recursive: true });
try {
  for (const run of runs) {
    if (run.status !== 'saved' || !run.mapId) continue;
    const baselineIndex = baseline.findIndex(item => item.name === run.name);
    const index = baselineIndex < 0 ? 12 : baselineIndex;
    for (const view of ['top', 'oblique'] as const) {
      const name = `${String(index + 1).padStart(2, '0')}-terrain-${view}.png`;
      const file = path.join(output, 'images', name);
      if (existsSync(file)) continue;
      const page = await browser.newPage({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 1 });
      try {
        await page.goto(`http://127.0.0.1:5180/scripts/apiAblationPreview.html?map=${run.mapId}&view=${view}&framing=study`,
          { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForFunction(() => (window as any).apiAblationReady || (window as any).apiAblationError,
          { timeout: 60_000 });
        const error = await page.evaluate(() => (window as any).apiAblationError);
        if (error) throw new Error(String(error));
        await page.screenshot({ path: file });
        console.log(`${run.name} ${view}: ${file}`);
      } finally { await page.close(); }
    }
  }
} finally { await browser.close(); }
