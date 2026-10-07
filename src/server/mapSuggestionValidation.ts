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

export function validateMapSuggestion(
  map: EditableMap,
  suggestion: MapAiSuggestion,
  options: { repairableObjectIds?: ReadonlySet<string>; repair?: boolean } = {}
): ValidatedMapSuggestion {
  const candidate = applyMapOperations(map, suggestion.operations);
  const lint = lintMap(candidate, { repairableObjectIds: options.repairableObjectIds, repair: options.repair });
  const repairOperations = lint.repairOperations;
  const operations = [...suggestion.operations, ...repairOperations];
  const issues = [...(suggestion.diagnostics ?? []), ...lint.issues];
  if (repairOperations.length > 0) applyMapOperations(map, operations);
  return {
    suggestion: { ...suggestion, operations, diagnostics: issues },
    issues,
    repairCount: repairOperations.length
  };
}
