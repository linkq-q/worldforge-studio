import * as THREE from 'three';
import {
  pickPaletteColor,
  pickPaletteColorForSource,
  normalizePaletteRole,
  type ColorPalette,
  type ColorPaletteRole
} from '../shared/colorPalette';

export interface PalettePartResolution {
  role: ColorPaletteRole | string | null;
  variantKey: string;
  assetId?: string;
  assetTags?: string[];
  technical?: boolean;
  sourceColor?: string;
}

export interface PaletteCoverageReport {
  strictMaterials: number;
  approximateMaterials: number;
  technicalMaterials: number;
  unmatchedMaterials: number;
  usedColors: string[];
  roleCounts: Record<string, number>;
}

interface RuntimeIndexLike {
  partToRender: Map<string, unknown>;
  getRenderRef(partId: string): {
    mode?: string;
    object?: THREE.Object3D & { material?: THREE.Material | THREE.Material[] };
    instanceId?: number;
  } | null;
}

const EMPTY_REPORT: PaletteCoverageReport = {
  strictMaterials: 0,
  approximateMaterials: 0,
  technicalMaterials: 0,
  unmatchedMaterials: 0,
  usedColors: [],
  roleCounts: {}
};

export class PaletteMaterialRuntime {
  private restores: Array<() => void> = [];
  private currentReport: PaletteCoverageReport = { ...EMPTY_REPORT };

  constructor(
    private readonly runtimeIndex: RuntimeIndexLike,
    private readonly resolvePart: (partId: string) => PalettePartResolution | null
  ) {}

  apply(palette: ColorPalette): PaletteCoverageReport {
    this.clear();
    const report: PaletteCoverageReport = { ...EMPTY_REPORT, usedColors: [], roleCounts: {} };
    const usedColors = new Set<string>();
    const handledMaterials = new Set<THREE.Material>();
    for (const partId of this.runtimeIndex.partToRender.keys()) {
      const resolution = this.resolvePart(partId);
      if (!resolution) {
        report.unmatchedMaterials += 1;
        continue;
      }
      if (resolution.technical) {
        report.technicalMaterials += 1;
        continue;
      }
      if ((resolution.assetId && palette.excludedAssetIds.includes(resolution.assetId.toLowerCase()))
        || resolution.assetTags?.some((tag) => palette.excludedTags.includes(tag.toLowerCase()))) {
        report.technicalMaterials += 1;
        continue;
      }
      const ref = this.runtimeIndex.getRenderRef(partId);
      const role = normalizePaletteRole(resolution.role) ?? 'unclassified';
      const target = resolution.sourceColor
        ? pickPaletteColorForSource(palette, resolution.role, resolution.sourceColor, resolution.variantKey)
        : pickPaletteColor(palette, resolution.role, resolution.variantKey);
      if (!ref?.object) {
        report.unmatchedMaterials += 1;
        continue;
      }
      const instanced = ref.object as THREE.InstancedMesh;
      if (instanced.isInstancedMesh && Number.isInteger(ref.instanceId)) {
        const instanceId = ref.instanceId as number;
        const previous = new THREE.Color(1, 1, 1);
        if (instanced.instanceColor) instanced.getColorAt(instanceId, previous);
        instanced.setColorAt(instanceId, new THREE.Color(target));
        if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
        this.restores.push(() => {
          instanced.setColorAt(instanceId, previous);
          if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
        });
        report.strictMaterials += 1;
        report.roleCounts[role] = (report.roleCounts[role] ?? 0) + 1;
        usedColors.add(target);
        continue;
      }
      const materials = Array.isArray(ref.object.material) ? ref.object.material : [ref.object.material];
      const colorMaterials = materials.filter((material): material is THREE.Material & { color: THREE.Color; map?: THREE.Texture | null } => (
        Boolean(material && 'color' in material && (material as { color?: unknown }).color instanceof THREE.Color)
      ));
      if (colorMaterials.length === 0) {
        report.unmatchedMaterials += 1;
        continue;
      }
      for (const material of colorMaterials) {
        if (handledMaterials.has(material)) continue;
        handledMaterials.add(material);
        const previous = material.color.clone();
        material.color.set(target);
        this.restores.push(() => material.color.copy(previous));
        if (material.map) report.approximateMaterials += 1;
        else report.strictMaterials += 1;
        report.roleCounts[role] = (report.roleCounts[role] ?? 0) + 1;
        usedColors.add(target);
      }
    }
    report.usedColors = [...usedColors].sort();
    this.currentReport = report;
    return this.report();
  }

  clear(): void {
    for (let index = this.restores.length - 1; index >= 0; index -= 1) this.restores[index]();
    this.restores = [];
    this.currentReport = { ...EMPTY_REPORT, usedColors: [], roleCounts: {} };
  }

  report(): PaletteCoverageReport {
    return { ...this.currentReport, usedColors: [...this.currentReport.usedColors], roleCounts: { ...this.currentReport.roleCounts } };
  }
}
