import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import ts from 'typescript';
import { TERRAIN_PROGRAM_DEFAULT_RESOLUTION, validateTerrainProgramResolution,
  validateTerrainProgramField, type TerrainProgramField } from '../shared/terrainProgramField';

// Compile the same erosion implementation used by the editor, without passing
// host functions into generated code. The worker has a heap limit and a deadline.
const kernelSource = ['terrainErosion', 'terrainProgramKernel'].map(name =>
  readFileSync(new URL(`../shared/${name}.ts`, import.meta.url), 'utf8')
    .replace(/^import .* from .*;\r?\n/gm, '').replace(/^export /gm, '')).join('\n');
const kernel = ts.transpileModule(`const TERRAIN_MIN_HEIGHT = -16;\n${kernelSource}`, {
  compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}
}).outputText;

export async function compileTerrainProgram(source: string,
  options: {seed: number; size: number; resolution?: number}, timeoutMs = 12000): Promise<TerrainProgramField> {
  const resolution = validateTerrainProgramResolution(options.resolution === undefined
    ? TERRAIN_PROGRAM_DEFAULT_RESOLUTION : options.resolution);
  if (typeof source !== 'string' || !source.trim() || source.length > 60000
    || !Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff
    || !Number.isFinite(options.size) || options.size < 500 || options.size > 256000) throw new Error('invalid_terrain_program');
  const setup = `const terrain = (() => {
      const {Float64Array, Float32Array, Int32Array} = globalThis;
      ${kernel}
      return Object.freeze(createTerrainProgramApi(${options.seed}, ${options.size}, ${resolution}));
    })();
    for (const name of Object.getOwnPropertyNames(globalThis)) {
      if (/^(?:(?:Uint|Int|Float|BigInt|BigUint)\\d+(?:Clamped)?Array|ArrayBuffer|SharedArrayBuffer|DataView|WebAssembly)$/.test(name)) {
        Object.defineProperty(globalThis, name, {value:undefined, writable:false, configurable:false});
      }
    }
    Math.random = () => { throw new Error('use_seeded_noise'); }; Date = undefined;`;
  const script = `${source}
    if (typeof generate !== 'function') throw new Error('terrain_generate_function_missing');
    const returned = generate(terrain);
    if (returned && typeof returned.then === 'function') throw new Error('async_terrain_program_not_supported');
    JSON.stringify(terrain.result());`;
  const output = await new Promise<string>((resolve, reject) => {
    const worker = new Worker(`const {parentPort, workerData} = require('node:worker_threads');
      const vm = require('node:vm');
      try {
        const context = vm.createContext(Object.create(null), {
          codeGeneration: {strings: false, wasm: false}, microtaskMode: 'afterEvaluate'
        });
        vm.runInContext(workerData.setup, context, {timeout:workerData.timeout});
        const value = vm.runInContext(workerData.script, context, {timeout:workerData.timeout});
        if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 8 * 1024 * 1024) throw new Error('terrain_program_output_too_large');
        parentPort.postMessage({value});
      } catch (error) {parentPort.postMessage({error:String(error.message).slice(0,1000)});}`,
      {eval: true, workerData: {setup, script, timeout: timeoutMs}, resourceLimits: {maxOldGenerationSizeMb: 128, stackSizeMb: 4}});
    const timer = setTimeout(() => {void worker.terminate(); reject(new Error('terrain_program_timeout'));}, timeoutMs + 1000);
    worker.once('message', result => {
      clearTimeout(timer); void worker.terminate();
      if (result.error) reject(new Error(result.error)); else resolve(result.value);
    });
    worker.once('error', error => {clearTimeout(timer); reject(error);});
    worker.once('exit', code => {clearTimeout(timer); if (code !== 0) reject(new Error(`terrain_program_worker_exit:${code}`));});
  });
  return validateTerrainProgramField({version: 1, source, resolution, ...JSON.parse(output)});
}
