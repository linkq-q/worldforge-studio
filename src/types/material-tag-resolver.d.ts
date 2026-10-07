declare module '@voxel-studio/render-runtime/effects' {
  export function resolveModelMaterialTags(model: { parts: Array<Record<string, unknown>> }, vocabulary: Record<string, unknown>): {
    byPartId: Map<string, Array<{ tag: string; value: string | number; variant?: string }>>;
    diagnostics: unknown[];
  };
}
