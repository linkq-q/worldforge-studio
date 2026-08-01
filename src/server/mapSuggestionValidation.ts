import { lintMap, type MapLintIssue } from '../shared/mapLint';
import {
  applyMapOperations,
  type MapAiSuggestion
} from '../shared/mapOperations';
import type { EditableMap } from '../shared/map';

export interface ValidatedMapSuggestion {
  suggestion: MapAiSuggestion;
  issues: MapLintIssue[];
  repairCount: number;
}

export function validateMapSuggestion(map: EditableMap, suggestion: MapAiSuggestion): ValidatedMapSuggestion {
  const candidate = applyMapOperations(map, suggestion.operations);
  const lint = lintMap(candidate);
  const operations = [...suggestion.operations, ...lint.repairOperations];
  if (lint.repairOperations.length > 0) applyMapOperations(map, operations);
  return {
    suggestion: { ...suggestion, operations, diagnostics: lint.issues },
    issues: lint.issues,
    repairCount: lint.repairOperations.length
  };
}
