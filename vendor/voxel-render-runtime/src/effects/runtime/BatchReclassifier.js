import { EffectBatchKeyBuilder } from './EffectBatchKeyBuilder.js';

export class BatchReclassifier {
  constructor(options = {}) {
    this.keyBuilder = options.keyBuilder || new EffectBatchKeyBuilder();
    this.logger = options.logger || null;
  }

  classify({ target, layers = [], geometryFamily, allowStandalonePreferredBatch = false } = {}) {
    const materialLayers = layers.filter(layer => layer.batchPolicy !== 'notMaterialRelated');
    if (materialLayers.length === 0) {
      const result = { result: 'notMaterialRelated', effectBatchKey: null };
      this._log('[BatchReclassify] result=notMaterialRelated');
      return result;
    }

    if (materialLayers.some(layer => layer.batchPolicy === 'standaloneOnly')) {
      const result = { result: 'standalone', effectBatchKey: null, reason: 'standaloneOnly' };
      this._log('[BatchReclassify] result=standalone');
      return result;
    }

    if (!allowStandalonePreferredBatch && materialLayers.some(layer => layer.batchPolicy === 'standalonePreferred')) {
      const result = { result: 'standalone', effectBatchKey: null, reason: 'standalonePreferred' };
      this._log('[BatchReclassify] result=standalone');
      return result;
    }

    const keys = [];
    for (const layer of materialLayers) {
      const key = this.keyBuilder.build({ target, layer, geometryFamily });
      this._log(`[BatchPolicy] layer=${layer.type} policy=${layer.batchPolicy} key=${key || 'null'}`);
      if (!key) {
        const preferred = layer.batchPolicy === 'standalonePreferred';
        return {
          result: 'standalone',
          effectBatchKey: null,
          reason: preferred ? 'preferred-without-safe-key' : 'missing-effect-batch-key',
        };
      }
      keys.push(key);
    }

    const result = {
      result: 'effectBatch',
      effectBatchKey: keys.join('::'),
    };
    this._log('[BatchReclassify] result=effectBatch');
    return result;
  }

  _log(message) {
    if (this.logger?.enabled && Array.isArray(this.logger.entries)) this.logger.entries.push(message);
    if (this.logger?.enabled && this.logger.console === true) console.log(message);
  }
}
