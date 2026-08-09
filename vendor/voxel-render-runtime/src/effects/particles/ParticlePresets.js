/**
 * ParticlePresets.js — 预制粒子效果（任务书 particle-system-v1 Phase 1）
 *
 * 纯数据：每个预设就是一份 ParticleEngine emitter config + 元信息。
 * 词汇表对齐 motion-plan emit 轨道（rate/lifetime/velocity/colorStart...），
 * 曲线字段见 ParticleEngine.CURVES。改这里不需要动引擎；新预设 = 加一个对象。
 *
 * stateBindings 是声明性标注（哪个游戏状态该驱动哪个参数），Phase 1 仅记录，
 * 实际绑定 GameStateUniformBus 在 Phase 3 做。
 */

export const PARTICLE_PRESETS = Object.freeze({
  // ── 火系：flame + smoke + embers 三层叠出篝火/火把 ──
  flame: {
    label: 'Flame',
    description: 'Chunky voxel-style fire body, shrinks and cools as it rises.',
    config: {
      renderMode: 'mesh', mesh: 'box',
      rate: 24, lifetime: [0.4, 0.8],
      emitShape: 'box', shapeSize: [0.15, 0.05, 0.15],
      velocity: { dir: [0, 1, 0], speed: [0.8, 1.6], spread: 0.25 },
      acceleration: [0, 0.4, 0],
      meshSize: 0.22, scaleStart: 1, scaleEnd: 0.05, sizeCurve: 'easeOut',
      colorStart: [1, 0.62, 0.12], colorEnd: [0.55, 0.06, 0.02], colorCurve: 'easeOut',
    },
  },
  smoke: {
    label: 'Smoke',
    description: 'Slow rising smoke, expands then fades out.',
    config: {
      renderMode: 'mesh', mesh: 'box',
      rate: 7, lifetime: [1.2, 2.2],
      offset: [0, 0.4, 0],
      velocity: { dir: [0, 1, 0], speed: [0.4, 0.8], spread: 0.2 },
      acceleration: [0, 0.15, 0],
      wobble: [0.08, 1.5],
      meshSize: 0.3, scaleStart: 0.6, scaleEnd: 1.6, sizeCurve: 'easeIn',
      colorStart: [0.25, 0.25, 0.28], colorEnd: [0.5, 0.5, 0.55],
      alphaStart: 0.5, alphaEnd: 0, alphaCurve: 'holdFade',
    },
  },
  embers: {
    label: 'Embers',
    description: 'Sparse drifting sparks with flicker.',
    config: {
      renderMode: 'point', additive: true,
      rate: 6, lifetime: [1, 2],
      velocity: { dir: [0, 1, 0], speed: [0.5, 1.2], spread: 0.5 },
      acceleration: [0, 0.3, 0],
      wobble: [0.15, 2], flicker: 0.8,
      meshSize: 0.06, scaleStart: 1, scaleEnd: 0.3, sizeCurve: 'easeOut',
      colorStart: [1, 0.75, 0.25], colorEnd: [1, 0.3, 0.05],
      alphaStart: 0, alphaEnd: 1, alphaCurve: 'bell',
    },
  },

  // ── 打击系 ──
  hit_spark: {
    label: 'Hit Spark',
    description: 'One-shot radial spark burst on impact.',
    stateBindings: ['uHitFlash'],
    config: {
      renderMode: 'point', additive: true,
      burst: 18, rate: 0, lifetime: [0.15, 0.35],
      velocity: { mode: 'radial', speed: [3, 6] },
      acceleration: [0, -6, 0],
      meshSize: 0.08, scaleStart: 1, scaleEnd: 0, sizeCurve: 'easeOut',
      colorStart: [1, 0.95, 0.6], colorEnd: [1, 0.5, 0.1], colorCurve: 'easeOut',
      alphaStart: 1, alphaEnd: 0.6,
    },
  },
  hit_debris: {
    label: 'Hit Debris',
    description: 'Voxel chunks thrown out by impact, gravity + ground kill.',
    stateBindings: ['uHitFlash'],
    config: {
      renderMode: 'mesh', mesh: 'box',
      burst: 10, rate: 0, lifetime: [0.6, 1.0],
      velocity: { mode: 'radial', speed: [2, 4] },
      acceleration: [0, -9.8, 0], groundKill: true,
      meshSize: 0.12, scaleStart: 1, scaleEnd: 0.6, sizeCurve: 'linear',
      colorStart: [0.6, 0.5, 0.4], colorEnd: [0.35, 0.3, 0.25],
    },
  },

  // ── 魔法/能量系 ──
  charge_motes: {
    label: 'Charge Motes',
    description: 'Motes converging inward from a ring while drifting up.',
    stateBindings: ['uChargeLevel'],
    config: {
      renderMode: 'point', additive: true,
      rate: 18, lifetime: [0.6, 1.0],
      emitShape: 'ring', shapeSize: [0.9],
      velocity: { mode: 'radial', speed: [-1.2, -0.8] },
      acceleration: [0, 0.6, 0],
      meshSize: 0.08, scaleStart: 0.6, scaleEnd: 1, sizeCurve: 'smooth',
      colorStart: [0.4, 0.8, 1], colorEnd: [0.9, 1, 1],
      alphaStart: 0, alphaEnd: 1, alphaCurve: 'bell',
    },
  },
  sparkle: {
    label: 'Sparkle',
    description: 'Twinkling stardust inside a volume, for enchanted gear.',
    config: {
      renderMode: 'point', additive: true,
      rate: 10, lifetime: [0.5, 1.0],
      emitShape: 'box', shapeSize: [0.5, 0.5, 0.5],
      velocity: { speed: [0, 0.1] },
      flicker: 1,
      meshSize: 0.07, scaleStart: 1, scaleEnd: 0.4, sizeCurve: 'easeOut',
      colorStart: [1, 1, 0.8], colorEnd: [0.8, 0.9, 1],
      alphaStart: 0, alphaEnd: 1, alphaCurve: 'bell',
    },
  },

  // ── 拖尾 ──
  slash_trail: {
    label: 'Slash Trail',
    description: 'World-space afterimage trail left behind a moving emitter.',
    config: {
      renderMode: 'point', additive: true,
      rate: 120, lifetime: [0.12, 0.18], maxCount: 64,
      velocity: { speed: [0, 0.05] },
      meshSize: 0.12, scaleStart: 1, scaleEnd: 0.2, sizeCurve: 'easeOut',
      colorStart: [0.7, 0.9, 1], colorEnd: [0.3, 0.5, 1],
      alphaStart: 0.9, alphaEnd: 0,
    },
  },
});

export const PARTICLE_PRESET_NAMES = Object.freeze(Object.keys(PARTICLE_PRESETS));
