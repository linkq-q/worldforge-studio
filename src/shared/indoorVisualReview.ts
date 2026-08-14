export type IndoorVisualFindingCode = 'overlap' | 'occlusion' | 'floating' | 'embedded' | 'dark-corner' | 'composition';
export type IndoorVisualFindingSeverity = 'minor' | 'major';

export interface IndoorVisualFinding {
  code: IndoorVisualFindingCode;
  severity: IndoorVisualFindingSeverity;
  message: string;
  objectIds: string[];
}

export interface IndoorVisualReview {
  status: 'pass' | 'revise';
  summary: string;
  findings: IndoorVisualFinding[];
  repairPrompt: string;
}

const FINDING_CODES = new Set<IndoorVisualFindingCode>([
  'overlap', 'occlusion', 'floating', 'embedded', 'dark-corner', 'composition'
]);

export function normalizeIndoorVisualReview(value: unknown, validObjectIds: ReadonlySet<string>): IndoorVisualReview {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const findings = (Array.isArray(input.findings) ? input.findings : [])
    .slice(0, 8)
    .flatMap((item): IndoorVisualFinding[] => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const finding = item as Record<string, unknown>;
      const code = typeof finding.code === 'string' && FINDING_CODES.has(finding.code as IndoorVisualFindingCode)
        ? finding.code as IndoorVisualFindingCode
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
    : status === 'pass' ? '室内轻量终检未发现必须自动修复的问题。' : '室内轻量终检发现需要修复的严重问题。';
  const repairPrompt = status === 'revise'
    ? [
        '只调整现有物体和室内灯光，不生成新资产，不改动已经合理的区域。',
        ...majorFindings.map((finding) => {
          const targets = finding.objectIds.length > 0 ? ` 对象ID：${finding.objectIds.join(', ')}。` : '';
          return `修复 ${finding.code}：${finding.message}。${targets}`;
        })
      ].join('\n')
    : '';
  return { status, summary, findings, repairPrompt };
}
