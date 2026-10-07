import type { MapAiSuggestion, CodePlanPreviewPayload } from './mapOperations';
import type { EditableMap } from './map';
import type { AgentProgressEvent, ChatProvider, ModelProvider } from './protocol';

export type MapDesignSessionStatus = 'idle' | 'running' | 'paused' | 'failed' | 'committed';

export interface MapDesignMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  createdAt: number;
  action?: string;
  draftRevision?: number;
  interrupted?: boolean;
}

export interface MapDesignSessionView {
  id: string;
  mapId: string;
  baseVersion: number;
  draftRevision: number;
  version: number;
  status: MapDesignSessionStatus;
  stage?: 'planning' | 'awaiting-plan-approval' | 'generating-assets' | 'completed';
  messages: MapDesignMessage[];
  progress: AgentProgressEvent | null;
  createdAt: number;
  updatedAt: number;
  modelCalls: number;
  operationCount: number;
  assetCalls: number;
  /** Whole design tasks and whole asset batches, independent of model turns and individual assets. */
  generationCounts?: {planning: number; assets: number};
  generationCallLimit?: number;
  paidRequests?: number;
  paidRequestLimit?: number;
  paidRequestCounts?: {planning: number; assets: number};
  /** Planned source colors survive applying a draft and remain available to the conversation. */
  appearancePlan?: import('./sceneAppearance').SceneAppearancePlan;
  stepsUsed?: number;
  stepLimit?: number;
  outcome?: 'completed' | 'unchanged' | 'blocked';
  error?: string;
}

export interface MapDesignSessionOptions {
  prompt: string;
  expectedVersion: number;
  provider?: ChatProvider;
  assetProvider?: ModelProvider;
  /** The editor uses its configured GPT API, without substituting a Codex executor. */
  backendPlanning?: boolean;
  /** New conversations stop at a whitebox; only explicit revision-bound approval starts assets. */
  requirePlanApproval?: boolean;
  minNewAssets?: number;
  maxNewAssets?: number;
  /** Exclude pre-existing library assets from a fresh design; generated assets remain available on replay. */
  reuseExistingAssets?: boolean;
  /** Model actions per uninterrupted task run; reaching it preserves an unfinished draft. */
  maxSteps?: number;
  /** Whole planning tasks plus whole asset batches; all model turns/assets within a task share its count. */
  maxGenerationCalls?: number;
  /** Optional explicit technical HTTP-attempt cap, separate from user-facing generation counts. */
  maxPaidRequests?: number;
  assetIds?: string[];
}

export interface MapDesignDraft {
  session: MapDesignSessionView;
  map: EditableMap;
  suggestion: MapAiSuggestion | null;
  planPreview?: CodePlanPreviewPayload;
}
