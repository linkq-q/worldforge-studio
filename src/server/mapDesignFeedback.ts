import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MapDesignToolObservation } from '../shared/mapDesignFeedback';

export interface MapDesignFeedbackMetadata {
  mapId: string;
  baseVersion: number;
  draftRevision: number;
  applied: boolean;
  programHash?: string;
  error?: string;
}

type StoredObservation = MapDesignToolObservation;
type Overflow = { reason: string; tool: string; phase: string; step: number };
const REF_PATTERN = /^feedback-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const preview = (value: unknown, size: number) => {
  const text = JSON.stringify(value);
  return { text: text.slice(0, size), totalCharacters: text.length, truncated: text.length > size };
};

/** One execution's immutable facts. Large facts stay outside the conversation, readable by reference. */
export class MapDesignFeedbackCollector {
  private readonly observations: StoredObservation[] = [];
  private bytes = 0;
  private overflow: Overflow | null = null;
  private readonly maxRecords: number;
  private readonly maxBytes: number;

  constructor(options: { maxRecords?: number; maxBytes?: number } = {}) {
    this.maxRecords = options.maxRecords ?? 16_384;
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    if (!Number.isInteger(this.maxRecords) || this.maxRecords < 1 || !Number.isInteger(this.maxBytes) || this.maxBytes < 1) {
      throw new Error('invalid_design_feedback_budget');
    }
  }

  record(observation: MapDesignToolObservation): void {
    if (!observation || !['discovery', 'final'].includes(observation.phase)
      || !Number.isInteger(observation.step) || observation.step < 0
      || typeof observation.tool !== 'string' || !observation.tool.trim() || observation.tool.length > 80) {
      throw new Error('invalid_design_feedback_observation');
    }
    if (this.overflow) throw new Error(this.overflow.reason);
    const snapshot = snapshotJson(observation, observation.tool === 'report') as StoredObservation;
    const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
    if (this.observations.length >= this.maxRecords || this.bytes + bytes > this.maxBytes) {
      this.overflow = { reason: 'design_feedback_budget_exceeded', tool: observation.tool,
        phase: observation.phase, step: observation.step };
      throw new Error(this.overflow.reason);
    }
    this.observations.push(snapshot);
    this.bytes += bytes;
  }

  async save(directory: string, metadata: MapDesignFeedbackMetadata) {
    if (!metadata || typeof metadata.mapId !== 'string' || !Number.isInteger(metadata.baseVersion)
      || !Number.isInteger(metadata.draftRevision) || typeof metadata.applied !== 'boolean') throw new Error('invalid_design_feedback_metadata');
    const identity = { schemaVersion: 1, ref: `feedback-${randomUUID()}`, createdAt: Date.now(),
      metadata: snapshotJson(metadata, true) as MapDesignFeedbackMetadata };
    if (JSON.stringify(identity).length > 4000) throw new Error('design_feedback_metadata_out_of_budget');
    const observations = [...this.observations], overflow = this.overflow ? { ...this.overflow } : null, capturedBytes = this.bytes;
    const payload = { ...identity, complete: !overflow, overflow, observations };
    // Serialize before yielding: later callbacks cannot alter a save already in flight.
    const content = JSON.stringify(payload);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${identity.ref}.json`), content, { encoding: 'utf8', flag: 'wx' });
    const groups = new Map<string, { tool: string; phase: string; count: number; firstIndex: number; lastIndex: number }>();
    const explicit: number[] = [];
    observations.forEach((item, index) => {
      const key = `${item.phase}:${item.tool}`, group = groups.get(key);
      if (group) { group.count++; group.lastIndex = index; }
      else groups.set(key, { tool: item.tool, phase: item.phase, count: 1, firstIndex: index, lastIndex: index });
      if (item.tool === 'report') explicit.push(index);
    });
    const allGroups = [...groups.values()];
    const summary = { ...identity, complete: !overflow, overflow, recordCount: observations.length,
      capturedBytes, budgets: { maxRecords: this.maxRecords, maxBytes: this.maxBytes },
      explicitReportCount: explicit.length, reports: explicit.slice(-6).map(index => ({ index,
        phase: observations[index].phase, step: observations[index].step, ...preview(observations[index], 550) })),
      groups: allGroups.slice(0, 10).map(group => ({ ...group,
        first: preview(observations[group.firstIndex], 180), last: preview(observations[group.lastIndex], 180) })),
      summaryTruncated: explicit.length > 6 || allGroups.length > 10,
      read: { kind: 'feedback', ref: identity.ref, offset: 0, limit: 16 },
      limits: ['Discovery facts can use provisional assets. Only applied metadata binds the execution to a completed draft.',
        'Preview text may end mid-JSON; read the reference for complete records. Non-finite automatic readings use explicit $nonFinite markers.'] };
    while (JSON.stringify(summary).length > 10_000 && (summary.groups.length || summary.reports.length)) {
      if (summary.groups.length) summary.groups.pop();
      else summary.reports.shift();
      summary.summaryTruncated = true;
    }
    return summary;
  }
}

/** directory is supplied by the session manager; callers can supply a ref, never a path. */
export async function readMapDesignFeedback(directory: string, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_design_feedback_query');
  const query = input as Record<string, unknown>;
  if (Object.keys(query).some(key => !['kind', 'ref', 'offset', 'limit', 'recordIndex', 'characterOffset', 'characterLimit'].includes(key))
    || query.kind !== undefined && query.kind !== 'feedback'
    || typeof query.ref !== 'string' || !REF_PATTERN.test(query.ref)) throw new Error('invalid_design_feedback_query');
  let stored: { schemaVersion: number; ref: string; createdAt: number; metadata: MapDesignFeedbackMetadata;
    complete: boolean; overflow: Overflow | null; observations: StoredObservation[] };
  try { stored = JSON.parse(await readFile(path.join(directory, `${query.ref}.json`), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('unknown_design_feedback'); throw error; }
  if (stored.schemaVersion !== 1 || stored.ref !== query.ref || !Array.isArray(stored.observations)) throw new Error('invalid_design_feedback_file');
  const { observations, ...identity } = stored;
  if (query.recordIndex !== undefined) {
    if (query.offset !== undefined || query.limit !== undefined) throw new Error('invalid_design_feedback_query');
    const index = integer(query.recordIndex, 0, Math.max(0, observations.length - 1), 0);
    if (!observations[index]) throw new Error('unknown_design_feedback_record');
    const text = JSON.stringify(observations[index]);
    const offset = integer(query.characterOffset, 0, 16 * 1024 * 1024, 0);
    const limit = integer(query.characterLimit, 1, 8000, 4000), chunk = text.slice(offset, offset + limit);
    return { ...identity, recordIndex: index, characterOffset: offset, totalCharacters: text.length, text: chunk,
      nextCharacterOffset: offset + chunk.length < text.length ? offset + chunk.length : null, encoding: 'JSON with explicit non-finite markers' };
  }
  if (query.characterOffset !== undefined || query.characterLimit !== undefined) throw new Error('invalid_design_feedback_query');
  const offset = integer(query.offset, 0, 1_000_000, 0), limit = integer(query.limit, 1, 64, 16);
  const items: unknown[] = [];
  let characters = 0;
  for (let index = offset; index < Math.min(observations.length, offset + limit); index++) {
    const observation = observations[index], text = JSON.stringify(observation);
    const item = text.length <= 3000 ? { index, observation, truncated: false }
      : { index, phase: observation.phase, step: observation.step, tool: observation.tool, ...preview(observation, 500),
        read: { kind: 'feedback', ref: stored.ref, recordIndex: index, characterOffset: 0, characterLimit: 4000 } };
    const size = JSON.stringify(item).length;
    if (characters + size > 18_000) break;
    characters += size;
    items.push(item);
  }
  return { ...identity, total: observations.length, offset, limit, items,
    nextOffset: offset + items.length < observations.length ? offset + items.length : null };
}

function integer(value: unknown, min: number, max: number, fallback: number) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error('invalid_design_feedback_query');
  return value;
}

function snapshotJson(value: unknown, strict: boolean, ancestors = new Set<object>(), depth = 0): unknown {
  if (depth > 64) throw new Error('design_feedback_json_depth_exceeded');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    if (strict) throw new Error('design_report_non_finite');
    return { $nonFinite: String(value) };
  }
  if (typeof value !== 'object') {
    if (strict) throw new Error('design_report_requires_json');
    return { $unsupported: typeof value };
  }
  if (ancestors.has(value)) throw new Error('design_report_circular');
  ancestors.add(value);
  try {
    return Array.isArray(value) ? value.map(item => snapshotJson(item, strict, ancestors, depth + 1))
      : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshotJson(item, strict, ancestors, depth + 1)]));
  } finally { ancestors.delete(value); }
}
