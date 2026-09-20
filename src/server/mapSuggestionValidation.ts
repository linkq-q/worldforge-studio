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
  const lint = lintMap(candidate, { repairableObjectIds: options.repairableObjectIds });
  const repairOperations = options.repair === false ? [] : lint.repairOperations;
  const operations = [...suggestion.operations, ...repairOperations];
  const lintIssues = options.repair === false
    ? lint.issues.map((issue) => ({ ...issue, repaired: false }))
    : lint.issues;
  const issues = [...(suggestion.diagnostics ?? []), ...lintIssues];
  if (repairOperations.length > 0) applyMapOperations(map, operations);
  return {
    suggestion: { ...suggestion, operations, diagnostics: issues },
    issues,
    repairCount: repairOperations.length
  };
}
