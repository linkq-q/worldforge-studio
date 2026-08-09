/**
 * FountainChain — fountain system coordinator (Water Dynamic v1 Phase J).
 *
 * Routes data between fountain parts so the visual system reads as one connected
 * flow rather than independent pieces:
 *   spout particles → tier foam brightness → curtain density → pool ripple intensity
 *
 * Pure data routing — no rendering, no Three.js dependency. The caller feeds
 * per-frame observables (particle counts, water levels) and FountainChain
 * outputs adjusted uniform targets.
 */

export class FountainChain {
  constructor() {
    /** @type {Map<string, FountainNode>} partId → node */
    this.nodes = new Map();
  }

  /**
   * Register a fountain part with its role and spatial info.
   * @param {{ partId:string, role:'spout'|'tier'|'basin', worldY:number }} cfg
   */
  register(cfg) {
    this.nodes.set(cfg.partId, {
      partId: cfg.partId,
      role: cfg.role,
      worldY: cfg.worldY,
      above: null,  // FountainNode supplying water from above
      below: null,  // FountainNode receiving water below
      particleCount: 0,
      foamModifier: 1.0,
      rippleModifier: 1.0,
    });
  }

  /**
   * Link nodes after registration — sorts by Y (high→low) and chains adjacent
   * nodes that represent tier-to-tier or spout-to-tier flow.
   */
  link() {
    const sorted = [...this.nodes.values()].sort((a, b) => b.worldY - a.worldY);
    for (let i = 0; i < sorted.length - 1; i++) {
      sorted[i].below = sorted[i + 1];
      sorted[i + 1].above = sorted[i];
    }
  }

  /**
   * Call each frame with current particle counts. Routes downstream modifiers.
   * @param {{ partId:string, aliveCount:number }[]} particleCounts
   */
  tick(particleCounts = []) {
    // Apply incoming particle counts to each node
    for (const pc of particleCounts) {
      const node = this.nodes.get(pc.partId);
      if (node) node.particleCount = pc.aliveCount;
    }

    // Route downstream: spout density → tier foam → curtain → basin ripple
    for (const [, node] of this.nodes) {
      if (node.role === 'spout' && node.below?.role === 'tier') {
        // More spout particles hitting tier → brighter foam
        node.below.foamModifier = 0.5 + Math.min(1.0, node.particleCount / 200) * 0.5;
      }
      if (node.role === 'tier' && node.below) {
        // Tier overflow density → receiver ripple strength
        node.below.rippleModifier = 0.5 + Math.min(1.0, node.particleCount / 300) * 0.5;
      }
    }
  }

  /** @returns {{ partId:string, foamModifier:number, rippleModifier:number }[]} */
  getModifiers() {
    return [...this.nodes.values()].map(n => ({
      partId: n.partId,
      foamModifier: n.foamModifier,
      rippleModifier: n.rippleModifier,
    }));
  }

  dispose() {
    this.nodes.clear();
  }
}
