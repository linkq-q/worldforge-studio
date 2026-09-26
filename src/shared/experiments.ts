import type { MapSceneMode } from './map';
import type { ModelGenerationMode } from './modelGenerationMode';
import type { ChatProvider, ModelProvider, MapCodePromptMode, MapCodeRevisionMode, MapCodeSpatialPolicy } from './protocol';

export interface MapFolder { id: string; name: string; parentId: string | null }
export interface MapCatalog { folders: MapFolder[]; membership: Record<string, string> }
export const EXPERIMENT_TEMPLATES = ['repeat', 'assets', 'prompts', 'apis'] as const;
export const EXPERIMENT_API_PROFILES = ['editor', 'core10', 'placeBetween', 'foundation', 'attach', 'sampleProbabilityField', 'design'] as const;
export type ExperimentApiProfile = typeof EXPERIMENT_API_PROFILES[number];
export interface ExperimentCase { name: string; prompt: string; apiProfile: ExperimentApiProfile; systemPrompt?: string; promptMode?: MapCodePromptMode }
export interface ExperimentConfig {
  name: string;
  question: string;
  folderId: string;
  template: typeof EXPERIMENT_TEMPLATES[number];
  cases: ExperimentCase[];
  repeats: number;
  assetRepeats: number;
  provider: ChatProvider;
  assetProviders: ModelProvider[];
  size: [number, number, number];
  sceneMode: Exclude<MapSceneMode, 'mixed'>;
  assetGenerationMode: ModelGenerationMode;
  minNewAssets: number;
  maxNewAssets: number;
  promptMode: MapCodePromptMode;
  revisionMode: MapCodeRevisionMode;
  spatialPolicy: MapCodeSpatialPolicy;
}
export const REVIEW_TAGS = ['悬空', '穿插', '比例异常', '朝向错误', '连接断裂', '主体不清', '内容缺失', '资产细节差', 'API误用'] as const;
export type ReviewRating = '' | 'good' | 'fair' | 'poor' | 'unknown';
export interface ExperimentReview {
  prompt: ReviewRating; layout: ReviewRating; assets: ReviewRating; assembly: ReviewRating;
  tags: string[]; note: string;
  comparedRunId?: string;
  preference?: '' | 'this' | 'other' | 'tie' | 'unknown';
  evidence?: string;
  reviewedAt: number;
}
export type RunStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'interrupted' | 'cancelled';
export interface ExperimentRun {
  id: string; planKey: string; caseIndex: number; repeat: number; assetRepeat: number;
  assetProvider: ModelProvider; status: RunStatus;
  attempt: number; retryOf?: string; replayOf?: string;
  stage?: string; error?: string; mapId?: string; transactionId?: string;
  traceId?: string; startedAt?: number; finishedAt?: number;
  progress?: string; warnings?: string[]; objectCount?: number; assetCount?: number; functions?: string[];
  humanReview?: ExperimentReview; agentReview?: ExperimentReview;
}
export interface Experiment {
  id: string; createdAt: number; baseSeed: number; status: 'draft' | 'running' | 'paused' | 'completed';
  config: ExperimentConfig; runs: ExperimentRun[];
  sourceVersion: { commit: string; dirty: boolean; diffHash: string };
}
export function experimentTrials(config: ExperimentConfig): Omit<ExperimentRun, 'id'>[] {
  return config.cases.flatMap((_item, caseIndex) =>
    Array.from({ length: config.repeats }, (_, repeatIndex) =>
      config.assetProviders.flatMap(assetProvider =>
        Array.from({ length: config.assetRepeats }, (_, assetIndex) => ({
          planKey: config.template === 'assets'
            ? 'case-' + caseIndex + '-r' + repeatIndex
            : 'case-' + caseIndex + '-r' + repeatIndex + '-' + assetProvider + '-a' + assetIndex,
          caseIndex, repeat: repeatIndex + 1, assetRepeat: assetIndex + 1,
          assetProvider, status: 'queued' as const, attempt: 1
        }))
      )
    ).flat()
  );
}
