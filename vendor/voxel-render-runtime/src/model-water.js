// Dedicated entry for the model-water feature closure. Keeping this separate
// from the long-lived environment barrel prevents Vite's immutable dev cache
// from hiding newly added water exports in an already-open editor session.
export { FountainChain } from './environment/water/FountainChain.js';
export {
  ModelWaterInstances,
  classifyFallShape,
  getWaterPartShapeSize,
  inferFountainRoles,
  inferWaterStreamGuide,
  selectMergedPoolReference,
} from './environment/water/ModelWaterInstances.js';
export {
  WaterStreamSurface,
  createBallisticPath,
  getBallisticDuration,
} from './environment/water/WaterFaucetStream.js';
export { WaterWrapSurface } from './environment/water/WaterWrapSurface.js';
