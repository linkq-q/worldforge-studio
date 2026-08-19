import type { MapSceneMode } from './map';

export type MapVisualFindingCode =
  | 'overlap' | 'occlusion' | 'floating' | 'embedded' | 'dark-corner' | 'composition'
  | 'sparse' | 'hierarchy' | 'route';
export type MapVisualFindingSeverity = 'minor' | 'major';

export interface MapVisualFinding {
  code: MapVisualFindingCode;
  severity: MapVisualFindingSeverity;
  message: string;
  objectIds: string[];
}

export interface MapVisualReview {
  status: 'pass' | 'revise';
  summary: string;
  findings: MapVisualFinding[];
  repairPrompt: string;
}

export function mapVisualReviewAction(review: MapVisualReview): 'pass' | 'repair' {
  return review.status === 'revise' && Boolean(review.repairPrompt) ? 'repair' : 'pass';
}

export type IndoorVisualFindingCode = MapVisualFindingCode;
export type IndoorVisualFindingSeverity = MapVisualFindingSeverity;
export type IndoorVisualFinding = MapVisualFinding;
export type IndoorVisualReview = MapVisualReview;

const FINDING_CODES = new Set<MapVisualFindingCode>([
  'overlap', 'occlusion', 'floating', 'embedded', 'dark-corner', 'composition',
  'sparse', 'hierarchy', 'route'
]);

export function normalizeMapVisualReview(
  value: unknown,
  validObjectIds: ReadonlySet<string>,
  sceneMode: MapSceneMode
): MapVisualReview {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const findings = (Array.isArray(input.findings) ? input.findings : [])
    .slice(0, 8)
    .flatMap((item): MapVisualFinding[] => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const finding = item as Record<string, unknown>;
      const code = typeof finding.code === 'string' && FINDING_CODES.has(finding.code as MapVisualFindingCode)
        ? finding.code as MapVisualFindingCode
        : null;
      const message = typeof finding.message === 'string' ? finding.message.trim().slice(0, 240) : '';
      if (!code || !message) return [];
      return [{
        code,
        severity: finding.severity === 'major' ? 'major' : 'minor',
        message,
        objectIds: (Array.isArray(finding.objectIds) ? finding.objectIds : [])
          .filter((id): id is string => typeof id === 'string' && validObjectIds.has(id))
          .slice(0, 6)
      }];
    });
  const majorFindings = findings.filter((finding) => finding.severity === 'major');
  const status = majorFindings.length > 0 ? 'revise' : 'pass';
  const summary = typeof input.summary === 'string' && input.summary.trim()
    ? input.summary.trim().slice(0, 320)
    : status === 'pass' ? '轻量终检未发现必须自动修复的问题。' : '轻量终检发现需要修复的严重问题。';
  const repairPrompt = status === 'revise'
    ? [
        sceneMode === 'indoor'
          ? '只调整现有物体和室内灯光，不生成新资产，不改动已经合理的区域。'
          : '只调整现有物体、地形表面和灯光，不生成新资产，不改动已经合理的区域。保留连贯建筑组和有意留白。',
        ...majorFindings.map((finding) => {
          const targets = finding.objectIds.length > 0 ? ` 对象ID：${finding.objectIds.join(', ')}。` : '';
          return `修复 ${finding.code}：${finding.message}。${targets}`;
        })
      ].join('\n')
    : '';
  return { status, summary, findings, repairPrompt };
}

export function normalizeIndoorVisualReview(value: unknown, validObjectIds: ReadonlySet<string>): IndoorVisualReview {
  return normalizeMapVisualReview(value, validObjectIds, 'indoor');
}
