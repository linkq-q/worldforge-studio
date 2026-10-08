import type {MapDesignToolObservation} from '../shared/mapDesignFeedback';

const observed = new Set(['environmentSample', 'assetSpace', 'sightline', 'passage', 'connectionGap', 'waterPoint', 'worldRef', 'worldEntities']);

/** Preserve getters and synchronously snapshot facts before authored code can mutate them. */
export function mapCodeObservedApi<T extends object>(api: T, phase: MapDesignToolObservation['phase'],
  emit?: (observation: MapDesignToolObservation) => void): T {
  let step = 0;
  const descriptors = Object.getOwnPropertyDescriptors(api);
  for (const [tool, descriptor] of Object.entries(descriptors)) {
    if (typeof descriptor.value !== 'function') continue;
    const run = descriptor.value as (...args: unknown[]) => unknown;
    descriptor.value = (...args: unknown[]) => {
      const order = ++step;
      const result = run(...args);
      if (emit && observed.has(tool)) emit(structuredClone({phase, step: order, tool, args, result}));
      if (emit && tool === 'report') emit(structuredClone({phase, step: order, tool, args: [args[0]], result: args[1]}));
      if (emit && tool === 'worldState') {
        const world = result as {bundle:{plan:{id:string;revision:number;recipe:{size:number;seed:number}}}};
        emit({phase, step: order, tool, args: [], result: {worldId:world.bundle.plan.id,
          revision:world.bundle.plan.revision, size:world.bundle.plan.recipe.size, seed:world.bundle.plan.recipe.seed,
          note:'Full mutable copy remains inside execution. Use observe or report for bounded details.'}});
      }
      return result;
    };
  }
  return Object.freeze(Object.defineProperties({}, descriptors)) as T;
}

export function validateMapCodeReport(label: unknown, value: unknown): void {
  if (typeof label !== 'string' || !label.trim() || label.length > 160) throw new Error('invalid_map_code_report_label');
  const seen = new Set<object>();
  let count = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++count > 100_000 || depth > 32) throw new Error('map_code_report_too_large');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || !item || seen.has(item)) throw new Error('invalid_map_code_report_json');
    seen.add(item);
    for (const child of Object.values(item)) visit(child, depth + 1);
    seen.delete(item);
  };
  visit(value, 0);
  if (JSON.stringify(value).length > 256_000) throw new Error('map_code_report_too_large');
}
