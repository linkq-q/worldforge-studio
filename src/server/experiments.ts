import { readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createEmptyMap, createId, type EditableMap, type MapAsset } from '../shared/map';
import { type MapAiSuggestion } from '../shared/mapOperations';
import { CHAT_PROVIDER_OPTIONS, isModelProvider } from '../shared/protocol';
import { MODEL_GENERATION_MODES } from '../shared/modelGenerationMode';
import {
  EXPERIMENT_API_PROFILES, EXPERIMENT_TEMPLATES, REVIEW_TAGS, experimentTrials,
  type Experiment, type ExperimentConfig, type ExperimentReview, type ExperimentRun
} from '../shared/experiments';
import type { MapStore } from './mapStore';
import { mapCatalog, readOptionalJson, writeJsonAtomic } from './mapCatalog';
import { generateMapCodeSuggestion, type MapCodePlannerOptions } from './mapCodePlanner';
import { createMapAssetGenerator } from './mapAssetGenerator';
import { auditApiUse, experimentPrompt } from './mapExperimentProfiles';
import { generationTraceId, recordGenerationTrace, withGenerationTrace } from './generationTrace';

export function validateExperimentConfig(value: ExperimentConfig): ExperimentConfig {
  if (!value || typeof value !== 'object') throw new Error('invalid_experiment');
  const text = (item: unknown, max: number) => typeof item === 'string' && item.trim().length > 0 && item.length <= max;
  const integer = (item: number, min: number, max: number) => Number.isInteger(item) && item >= min && item <= max;
  if (!text(value.name, 100) || !text(value.folderId, 100) || typeof value.question !== 'string' || value.question.length > 2000
    || !EXPERIMENT_TEMPLATES.includes(value.template)
    || !Array.isArray(value.cases) || !value.cases.length || value.cases.length > 50
    || value.cases.some(item => !item || !text(item.name, 100) || !text(item.prompt, 1200)
      || !EXPERIMENT_API_PROFILES.includes(item.apiProfile)
      || (item.systemPrompt !== undefined && !text(item.systemPrompt, 60000)))
    || !integer(value.repeats, 1, 50) || !integer(value.assetRepeats, 1, 20)
    || !CHAT_PROVIDER_OPTIONS.some(provider => provider.key === value.provider && !provider.disabled)
    || !Array.isArray(value.assetProviders) || !value.assetProviders.length
    || value.assetProviders.some(provider => !isModelProvider(provider))
    || new Set(value.assetProviders).size !== value.assetProviders.length
    || !Array.isArray(value.size) || value.size.length !== 3 || value.size.some(size => !Number.isFinite(size) || size < 3 || size > 512)
    || !['outdoor', 'indoor'].includes(value.sceneMode)
    || !MODEL_GENERATION_MODES.some(mode => mode.key === value.assetGenerationMode)
    || !integer(value.minNewAssets, 0, 64) || !integer(value.maxNewAssets, value.minNewAssets, 64)
    || !['standard', 'minimal', 'coupled'].includes(value.promptMode)
    || !['first-pass', 'repair'].includes(value.revisionMode)
    || !['diagnose', 'repair'].includes(value.spatialPolicy)) throw new Error('invalid_experiment_config');
  if (value.cases.some(item => item.apiProfile !== 'editor') && (value.revisionMode !== 'first-pass' || value.sceneMode !== 'outdoor')) {
    throw new Error('api_profiles_require_outdoor_first_pass');
  }
  if (value.cases.some(item => item.apiProfile !== 'editor' && item.systemPrompt)) throw new Error('api_profile_system_prompt_conflict');
  if (experimentTrials(value).length > 200) throw new Error('experiment_limit_200_runs');
  return structuredClone(value);
}

interface PlanArtifact { map: EditableMap; suggestion: MapAiSuggestion; traceId?: string }
interface RunArtifact {
  suggestion: MapAiSuggestion;
  baseVersion: number;
  assetInputs: Record<string, MapAsset>;
}
type Planner = typeof generateMapCodeSuggestion;
export class ExperimentManager {
  private readonly directory: string;
  private readonly jobs = new Map<string, Experiment>();
  private readonly initial: Promise<void>;
  private writes: Promise<unknown> = Promise.resolve();
  private working = false;
  private controller?: AbortController;
  private activeRun?: string;
  constructor(private readonly maps: MapStore, private readonly planner: Planner = generateMapCodeSuggestion) {
    this.directory = path.join(maps.rootDir, 'experiments');
    this.initial = this.recover();
  }
  private async recover(): Promise<void> {
    const files = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []; throw error;
    });
    for (const file of files.filter(file => /^experiment-[a-z0-9-]+\.json$/.test(file))) {
      const job = await readOptionalJson<Experiment | null>(path.join(this.directory, file), null);
      if (!job) continue;
      this.jobs.set(job.id, job);
      if (job.status === 'running' || job.runs.some(run => run.status === 'running')) {
        job.status = 'paused';
        for (const run of job.runs.filter(run => run.status === 'running')) {
          run.status = 'interrupted'; run.error = '服务已重启；保留检查点，请选择重试。';
        }
        await this.save(job);
      }
    }
  }
  private save(job: Experiment): Promise<void> {
    const snapshot = structuredClone(job);
    const write = this.writes.then(() => writeJsonAtomic(path.join(this.directory, job.id + '.json'), snapshot));
    this.writes = write.catch(() => {});
    return write;
  }
  private async job(id: string): Promise<Experiment> {
    await this.initial;
    const job = this.jobs.get(id);
    if (!job) throw new Error('unknown_experiment');
    return job;
  }
  async list(): Promise<Experiment[]> { await this.initial; return structuredClone([...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt)); }
  async get(id: string): Promise<Experiment> { return structuredClone(await this.job(id)); }
  async create(input: ExperimentConfig): Promise<Experiment> {
    await this.initial;
    const config = validateExperimentConfig(input);
    await mapCatalog(this.maps).requireFolder(config.folderId);
    let sourceVersion = { commit: 'unknown', dirty: true, diffHash: '' };
    try {
      const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 });
      const diff = git(['diff', 'HEAD', '--', 'src', 'scripts']);
      const status = git(['status', '--porcelain', '--', 'src', 'scripts']);
      sourceVersion = { commit: git(['rev-parse', 'HEAD']).trim(), dirty: Boolean(status.trim()), diffHash: createHash('sha256').update(diff + status + git(['ls-files', '--others', '--exclude-standard', '--', 'src', 'scripts']).trim().split('\n').filter(Boolean).map(file => readFileSync(file, 'utf8')).join('\n')).digest('hex') };
    } catch { /* The experiment remains usable outside a Git checkout. */ }
    const job: Experiment = {
      id: createId('experiment'), createdAt: Date.now(), baseSeed: createEmptyMap().seed, status: 'draft', config, sourceVersion,
      runs: experimentTrials(config).map(run => ({ ...run, id: createId('run') }))
    };
    await this.save(job); this.jobs.set(job.id, job);
    return structuredClone(job);
  }
  async control(id: string, action: string, runId?: string): Promise<Experiment> {
    const job = await this.job(id);
    if (action === 'start') {
      if (job.status !== 'running' && job.runs.some(run => run.status === 'queued')) {
        await mapCatalog(this.maps).requireFolder(job.config.folderId);
        job.status = 'running';
      }
    } else if (action === 'pause') job.status = 'paused';
    else {
      const run = job.runs.find(run => run.id === runId);
      if (!run) throw new Error('unknown_run');
      if (action === 'cancel') {
        if (run.status === 'running' && this.activeRun === run.id) this.controller?.abort();
        else if (run.status === 'queued') { run.status = 'cancelled'; run.finishedAt = Date.now(); }
      } else if (action === 'retry' || action === 'replay' || action === 'regenerate') {
        if (job.runs.length >= 400) throw new Error('experiment_attempt_limit');
        if (action === 'retry' && !['failed', 'interrupted', 'cancelled'].includes(run.status)) throw new Error('run_not_retryable');
        if ((action === 'replay' && run.status !== 'completed') || (action === 'regenerate' && !['completed', 'partial'].includes(run.status))) throw new Error('run_not_completed');
        if (action === 'retry' && job.runs.some(item => item.retryOf === run.id && ['queued', 'running', 'completed'].includes(item.status))) {
          throw new Error('retry_already_exists');
        }
        job.runs.push({
          id: createId('run'), planKey: run.planKey, caseIndex: run.caseIndex, repeat: run.repeat,
          assetRepeat: run.assetRepeat, assetProvider: run.assetProvider, status: 'queued', attempt: run.attempt + 1,
          ...(action === 'retry' ? { retryOf: run.id } : action === 'replay' ? { replayOf: run.id } : {})
        });
        if (job.status === 'completed') job.status = 'paused';
      } else throw new Error('unknown_experiment_action');
    }
    await this.save(job);
    void this.pump().catch(error => console.error('Experiment queue failed:', error));
    return structuredClone(job);
  }
  async review(id: string, runId: string, actor: 'human' | 'agent', input: ExperimentReview): Promise<Experiment> {
    const job = await this.job(id);
    const run = job.runs.find(run => run.id === runId);
    if (!run) throw new Error('unknown_run');
    if (!input || !['human', 'agent'].includes(actor)
      || ['prompt', 'layout', 'assets', 'assembly'].some(key => !['', 'good', 'fair', 'poor', 'unknown'].includes(input[key as 'prompt']))
      || !Array.isArray(input.tags) || input.tags.some(tag => !(REVIEW_TAGS as readonly string[]).includes(tag))
      || typeof input.note !== 'string' || input.note.length > 4000
      || (input.evidence !== undefined && (typeof input.evidence !== 'string' || input.evidence.length > 4000))
      || !['', 'this', 'other', 'tie', 'unknown'].includes(input.preference ?? '')
      || (input.comparedRunId && !job.runs.some(other => other.id === input.comparedRunId && other.id !== runId))
      || (input.preference && !input.comparedRunId)) throw new Error('invalid_review');
    if (actor === 'agent' && !input.evidence?.trim()) throw new Error('agent_review_requires_evidence');
    run[actor === 'human' ? 'humanReview' : 'agentReview'] = { ...structuredClone(input), reviewedAt: Date.now() };
    await this.save(job); return structuredClone(job);
  }
  private artifactPath(job: Experiment, key: string, type: string): string {
    return path.join(this.directory, job.id, key + '.' + type + '.json');
  }
  async artifact(id: string, runId: string, type: string): Promise<unknown> {
    const job = await this.job(id);
    const run = job.runs.find(run => run.id === runId);
    if (!run || !['plan', 'result', 'snapshot'].includes(type)) throw new Error('unknown_artifact');
    const artifact = await readOptionalJson(this.artifactPath(job, type === 'plan' ? run.planKey : run.id, type), null);
    if (!artifact) throw new Error('artifact_not_ready');
    return artifact;
  }
  async idle(): Promise<void> {
    await this.initial;
    while (this.working) await new Promise(resolve => setTimeout(resolve, 10));
    await this.writes;
  }
  private async pump(): Promise<void> {
    await this.initial;
    if (this.working) return;
    this.working = true;
    try {
      for (;;) {
        const job = [...this.jobs.values()].find(job => job.status === 'running' && job.runs.some(run => run.status === 'queued'));
        if (!job) break;
        const run = job.runs.find(run => run.status === 'queued')!;
        this.controller = new AbortController(); this.activeRun = run.id;
        run.status = 'running'; run.startedAt = Date.now();
        try {
          await this.save(job);
          await this.execute(job, run, this.controller.signal);
          run.status = run.warnings?.length ? 'partial' : 'completed';
        } catch (error) {
          run.status = this.controller.signal.aborted ? 'cancelled' : 'failed';
          run.error = error instanceof Error ? error.message : String(error);
        }
        run.finishedAt = Date.now();
        this.activeRun = undefined;
        if (job.status === 'running' && !job.runs.some(run => run.status === 'queued')) job.status = 'completed';
        await this.save(job);
      }
    } finally { this.working = false; }
  }
  private async execute(job: Experiment, run: ExperimentRun, signal: AbortSignal): Promise<void> {
    const config = job.config;
    const item = config.cases[run.caseIndex];
    let plan = await readOptionalJson<PlanArtifact | null>(this.artifactPath(job, run.planKey, 'plan'), null);
    const base = plan?.map ?? createEmptyMap(item.name, undefined, config.size, config.assetGenerationMode, config.sceneMode);
    base.seed = job.baseSeed;
    const systemPrompt = item.apiProfile === 'editor' ? item.systemPrompt : experimentPrompt(base, item.apiProfile, config.minNewAssets, config.maxNewAssets);
    const options: MapCodePlannerOptions = {
      provider: config.provider, scope: 'scene', minNewAssets: config.minNewAssets, maxNewAssets: config.maxNewAssets,
      promptMode: config.promptMode, revisionMode: config.revisionMode, spatialPolicy: config.spatialPolicy,
      reuseExistingAssets: false, systemPromptOverride: systemPrompt, signal,
      ...(item.apiProfile === 'editor' ? {} : { validateCode: (code: string) => auditApiUse(code, item.apiProfile as Exclude<typeof item.apiProfile, 'editor'>) }),
      onProgress: event => { run.progress = event.label; }
    };
    if (!plan) {
      run.stage = 'planning'; await this.save(job);
      plan = await withGenerationTrace(this.maps.rootDir, { experimentId: job.id, planKey: run.planKey, operation: 'experiment-plan' }, async () => {
        run.traceId = generationTraceId();
        await this.save(job);
        recordGenerationTrace('request.input', { ...config, case: item });
        const suggestion = await this.planner(item.prompt, base, [], { ...options, discoveryOnly: true });
        const result = { map: base, suggestion, traceId: generationTraceId() };
        await writeJsonAtomic(this.artifactPath(job, run.planKey, 'plan'), result);
        return result;
      });
    }
    if (!plan.suggestion.codePlan?.code) throw new Error('experiment_plan_missing_code');
    signal.throwIfAborted();
    const retry = run.retryOf ? job.runs.find(item => item.id === run.retryOf) : undefined;
    let result = retry ? await readOptionalJson<RunArtifact | null>(this.artifactPath(job, retry.id, 'result'), null) : null;
    if (retry?.mapId && result) run.mapId = retry.mapId;
    if (!run.mapId) {
      const empty = createEmptyMap(config.name + ' · ' + item.name + ' · ' + run.repeat + '-' + run.assetProvider + '-' + run.assetRepeat,
        undefined, config.size, config.assetGenerationMode, config.sceneMode);
      const saved = await this.maps.saveMap({ ...empty, seed: plan.map.seed });
      run.mapId = saved.id;
    }
    await mapCatalog(this.maps).move([run.mapId], config.folderId);
    await this.save(job);
    if (!result) {
      run.stage = run.replayOf ? 'replaying' : 'generating-assets'; await this.save(job);
      const inputAssets: Record<string, MapAsset> = {};
      const baseVersion = (await this.maps.loadMap(run.mapId)).version;
      const replay = run.replayOf ? await readOptionalJson<RunArtifact | null>(this.artifactPath(job, run.replayOf, 'result'), null) : null;
      if (run.replayOf && !replay) throw new Error('replay_source_missing');
      result = await withGenerationTrace(this.maps.rootDir, {
        experimentId: job.id, runId: run.id, parentTraceId: plan.traceId, operation: 'experiment-generate'
      }, async () => {
        run.traceId = generationTraceId();
        await this.save(job);
        recordGenerationTrace('request.input', { config, case: item, assetProvider: run.assetProvider, approvedCode: plan!.suggestion.codePlan?.code });
        const createAsset = createMapAssetGenerator(this.maps, plan!.map, [], run.assetProvider, null, signal);
        const suggestion = await this.planner(item.prompt, plan!.map, [], {
          ...options, approvedCode: replay?.suggestion.codePlan?.code ?? plan!.suggestion.codePlan?.code,
          ...(replay ? { revisionMode: 'first-pass' as const } : {}),
          createAsset: async (request, report) => {
            const key = JSON.stringify(request);
            const previous = replay?.assetInputs[key];
            if (replay && !previous) throw new Error('replay_asset_request_changed');
            const asset = previous
              ? await this.maps.saveAsset({ name: previous.name, prompt: previous.prompt, modelJson: previous.modelJson, tags: previous.tags, light: previous.light, mode: request.mode, provider: run.assetProvider })
              : await createAsset(request, report);
            inputAssets[key] = asset;
            return asset;
          }
        });
        suggestion.generationTraceId = run.traceId;
        recordGenerationTrace('generation.result', { suggestion });
        const result = { suggestion, baseVersion, assetInputs: inputAssets };
        await writeJsonAtomic(this.artifactPath(job, run.id, 'result'), result);
        return result;
      });
    } else {
      run.traceId = result.suggestion.generationTraceId;
      await writeJsonAtomic(this.artifactPath(job, run.id, 'result'), result);
    }
    signal.throwIfAborted();
    if (result.suggestion.blocked) throw new Error('experiment_generation_blocked');
    run.stage = 'saving'; await this.save(job);
    const previous = await this.maps.getUndoTransaction(run.mapId);
    // A crash after commit but before saving the job must not apply the operations twice.
    const committed = previous?.ai?.generationTraceId && previous.ai.generationTraceId === result.suggestion.generationTraceId
      ? { map: await this.maps.loadMap(run.mapId), transaction: previous }
      : await this.maps.commitTransaction(run.mapId, {
        source: 'agent', label: config.name, operations: result.suggestion.operations,
        ai: { prompt: item.prompt, generationTraceId: result.suggestion.generationTraceId,
          codePlan: result.suggestion.codePlan, generatedAssets: result.suggestion.generatedAssets }
      }, result.baseVersion);
    run.transactionId = committed.transaction.id;
    run.stage = 'archiving'; await this.save(job);
    await writeJsonAtomic(this.artifactPath(job, run.id, 'snapshot'), committed.map);
    run.objectCount = committed.map.objects.length; run.assetCount = committed.map.assets?.length ?? 0;
    run.functions = result.suggestion.codePlan?.functions ?? [];
    run.warnings = (result.suggestion.diagnostics ?? []).filter(item => item.code === 'asset.generation-degraded').map(item => item.message);
    if (run.warnings.length) run.progress = run.warnings.join('；');
    run.stage = 'completed';
  }
}
const managers = new WeakMap<MapStore, ExperimentManager>();
export function experiments(store: MapStore): ExperimentManager {
  let manager = managers.get(store);
  if (!manager) { manager = new ExperimentManager(store); managers.set(store, manager); }
  return manager;
}
