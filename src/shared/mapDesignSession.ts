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
  error?: string;
}

export interface MapDesignSessionOptions {
  prompt: string;
  expectedVersion: number;
  provider?: ChatProvider;
  assetProvider?: ModelProvider;
  maxNewAssets?: number;
  assetIds?: string[];
}

export interface MapDesignDraft {
  session: MapDesignSessionView;
  map: EditableMap;
  suggestion: MapAiSuggestion | null;
}
