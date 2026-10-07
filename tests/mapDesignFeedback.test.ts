import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MapDesignFeedbackCollector, readMapDesignFeedback } from '../src/server/mapDesignFeedback';

const directories: string[] = [];
const metadata = { mapId: 'map-test', baseVersion: 2, draftRevision: 3, applied: true };
const directory = async () => { const value = await mkdtemp(path.join(os.tmpdir(), 'worldforge-feedback-')); directories.push(value); return value; };
afterEach(async () => { for (const value of directories.splice(0)) await rm(value, { recursive: true, force: true }); });

describe('persisted execution feedback', () => {
  it('snapshots automatic facts, marks non-finite readings and restores them without the collector', async () => {
    const collector = new MapDesignFeedbackCollector(), root = await directory();
    const result = { height: 12, waterDistance: Infinity };
    collector.record({ phase: 'discovery', step: 1, tool: 'environmentSample', args: [[1, 2]], result });
    result.height = 99;
    collector.record({ phase: 'final', step: 1, tool: 'environmentSample', args: [[1, 2]], result });
    const summary = await collector.save(root, metadata);
    expect(summary.recordCount).toBe(2);
    const restored = await readMapDesignFeedback(root, { ref: summary.ref });
    expect(restored).toMatchObject({ metadata, total: 2, nextOffset: null, items: [
      { observation: { phase: 'discovery', result: { height: 12, waterDistance: { $nonFinite: 'Infinity' } } } },
      { observation: { phase: 'final', result: { height: 99 } } }
    ] });
  });

  it('rejects invalid explicit reports instead of losing values during JSON serialization', () => {
    const collector = new MapDesignFeedbackCollector(), cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    for (const result of [NaN, Infinity, { callback() {} }, cyclic, undefined, 1n]) {
      expect(() => collector.record({ phase: 'final', step: 1, tool: 'report', args: { label: 'bad' }, result })).toThrow();
    }
  });

  it('returns whole small environment readings and admits when middle measurements are omitted', async () => {
    const collector = new MapDesignFeedbackCollector(), root = await directory();
    const result = { x: -94, z: 107, height: 20.901971298311548, slope: 1.248674891208517,
      waterDistance: 108.29571201155436, guideDistance: 2.779861295241842 };
    collector.record({ phase: 'final', step: 56, tool: 'environmentSample', args: [[-94, 107]], result });
    const one = await collector.save(root, metadata);
    expect(one.summaryTruncated).toBe(false);
    expect(one.groups[0].first).toMatchObject({ truncated: false, observation: { result } });
    collector.record({ phase: 'final', step: 57, tool: 'environmentSample', args: [[10, 20]], result: { slope: 47 } });
    collector.record({ phase: 'final', step: 58, tool: 'environmentSample', args: [[30, 40]], result: { slope: 2 } });
    const many = await collector.save(root, metadata);
    expect(many.summaryTruncated).toBe(true);
    expect(await readMapDesignFeedback(root, many.read)).toMatchObject({ items: [
      { index: 0 }, { index: 1, observation: { result: { slope: 47 } } }, { index: 2 }
    ] });
  });

  it('identifies an omitted large record without returning a misleading partial JSON value', async () => {
    const collector = new MapDesignFeedbackCollector(), root = await directory();
    collector.record({ phase: 'final', step: 1, tool: 'assetSpace', args: ['asset-a'], result: { parts: 'x'.repeat(3000) } });
    const summary = await collector.save(root, metadata), first = summary.groups[0].first;
    expect(summary.summaryTruncated).toBe(true);
    expect(first).toMatchObject({ truncated: true, tool: 'assetSpace', read: { recordIndex: 0 } });
    expect(first).not.toHaveProperty('text');
    expect(await readMapDesignFeedback(root, first.read)).toMatchObject({ nextCharacterOffset: null });
  });

  it('does not call removing duplicate group previews a loss of fully returned reports', async () => {
    const collector = new MapDesignFeedbackCollector(), root = await directory();
    for (let step = 0; step < 6; step++) {
      collector.record({ phase: 'final', step, tool: 'report', args: ['measurements'], result: 'x'.repeat(900) });
    }
    const summary = await collector.save(root, { ...metadata, error: 'e'.repeat(1300) });
    expect(JSON.stringify(summary).length).toBeLessThanOrEqual(10_000);
    expect(summary.reports).toHaveLength(6);
    expect(summary.groups).toHaveLength(0);
    expect(summary.summaryTruncated).toBe(false);
  });

  it('returns a summary matching the saved snapshot even if another fact arrives during the disk write', async () => {
    const collector = new MapDesignFeedbackCollector(), root = await directory();
    collector.record({ phase: 'final', step: 1, tool: 'environmentSample', args: {}, result: 1 });
    const saving = collector.save(root, metadata);
    collector.record({ phase: 'final', step: 2, tool: 'environmentSample', args: {}, result: 2 });
    const summary = await saving;
    expect(summary.recordCount).toBe(1);
    expect(summary.groups[0].count).toBe(1);
    expect(await readMapDesignFeedback(root, { ref: summary.ref })).toMatchObject({ total: summary.recordCount });
  });

  it('keeps even a dense mixed-tool summary within 10000 characters with explicit reports first', async () => {
    const root = await directory(), collector = new MapDesignFeedbackCollector();
    for (let step = 0; step < 30; step++) {
      collector.record({ phase: 'final', step, tool: `query-${step}`, args: {}, result: 'x'.repeat(4000) });
      collector.record({ phase: 'final', step, tool: 'report', args: { label: step }, result: 'r'.repeat(4000) });
    }
    const summary = await collector.save(root, { ...metadata, error: 'e'.repeat(3000) });
    expect(JSON.stringify(summary).length).toBeLessThanOrEqual(10000);
    expect(summary.reports.length).toBeGreaterThan(0);
    expect(summary.summaryTruncated).toBe(true);
  });

  it('keeps large explicit reports readable in complete chunks while bounding summaries and pages', async () => {
    const root = await directory(), collector = new MapDesignFeedbackCollector();
    const result = { measurements: 'abc'.repeat(20_000) };
    for (let step = 0; step < 120; step++) collector.record({ phase: 'final', step, tool: `query-${step % 12}`, args: {}, result: { height: step } });
    collector.record({ phase: 'final', step: 120, tool: 'report', args: { label: 'all measurements' }, result });
    const summary = await collector.save(root, metadata);
    expect(JSON.stringify(summary).length).toBeLessThan(10_000);
    expect(summary.summaryTruncated).toBe(true);
    expect(summary.reports[0].index).toBe(120);
    const page = await readMapDesignFeedback(root, { ref: summary.ref, offset: 120 });
    expect(page).toMatchObject({ total: 121, items: [{ index: 120, truncated: true }] });
    let offset = 0, text = '';
    do {
      const chunk = await readMapDesignFeedback(root, { ref: summary.ref, recordIndex: 120, characterOffset: offset, characterLimit: 8000 });
      expect('text' in chunk && chunk.text.length).toBeLessThanOrEqual(8000);
      if (!('text' in chunk)) throw new Error('missing chunk');
      text += chunk.text; offset = chunk.nextCharacterOffset as number;
    } while (offset !== null);
    expect(JSON.parse(text)).toMatchObject({ tool: 'report', result });
  });

  it('signals budget exhaustion and persists all previously captured facts as an incomplete failed execution', async () => {
    const root = await directory(), collector = new MapDesignFeedbackCollector({ maxRecords: 1 });
    collector.record({ phase: 'final', step: 1, tool: 'environmentSample', args: {}, result: { height: 5 } });
    expect(() => collector.record({ phase: 'final', step: 2, tool: 'environmentSample', args: {}, result: {} })).toThrow('design_feedback_budget_exceeded');
    const summary = await collector.save(root, { ...metadata, applied: false, error: 'design_feedback_budget_exceeded' });
    expect(summary).toMatchObject({ complete: false, recordCount: 1, overflow: { step: 2 } });
    expect(await readMapDesignFeedback(root, { ref: summary.ref })).toMatchObject({ metadata: { applied: false }, total: 1 });
    const byteBound = new MapDesignFeedbackCollector({ maxBytes: 100 });
    expect(() => byteBound.record({ phase: 'final', step: 1, tool: 'report', args: {}, result: '中'.repeat(100) })).toThrow('design_feedback_budget_exceeded');
  });

  it('rejects cross-session references, paths and invalid paging options', async () => {
    const root = await directory(), other = await directory(), collector = new MapDesignFeedbackCollector();
    const summary = await collector.save(root, metadata);
    await expect(readMapDesignFeedback(other, { ref: summary.ref })).rejects.toThrow('unknown_design_feedback');
    for (const query of [{ ref: '../other' }, { ref: summary.ref, path: root }, { ref: summary.ref, limit: 65 },
      { ref: summary.ref, offset: -1 }, { ref: summary.ref, recordIndex: 0, offset: 0 }, { ref: summary.ref, characterOffset: 0 }]) {
      await expect(readMapDesignFeedback(root, query)).rejects.toThrow();
    }
  });
});
