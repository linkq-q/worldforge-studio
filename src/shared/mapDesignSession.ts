import type { MapAiSuggestion } from './mapOperations';
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
  messages: MapDesignMessage[];
  progress: AgentProgressEvent | null;
  createdAt: number;
  updatedAt: number;
  modelCalls: number;
  operationCount: number;
  assetCalls: number;
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
  minNewAssets?: number;
  maxNewAssets?: number;
  /** Exclude pre-existing library assets from a fresh design; generated assets remain available on replay. */
  reuseExistingAssets?: boolean;
  /** Model actions per uninterrupted task run; reaching it preserves an unfinished draft. */
  maxSteps?: number;
  /** Total upstream HTTP attempts for planning and assets, including retries; Codex bridge turns are excluded. */
  maxPaidRequests?: number;
  assetIds?: string[];
}

export interface MapDesignDraft {
  session: MapDesignSessionView;
  map: EditableMap;
  suggestion: MapAiSuggestion | null;
}
