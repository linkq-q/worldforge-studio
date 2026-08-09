export const COMIC_LOOK_PRESET_IDS = ['custom', 'clean', 'print'];

export const COMIC_LOOK_PRESETS = Object.freeze({
  clean: Object.freeze({
    comicHalftoneEnabled: false,
    comicHalftoneStrength: 0.0,
    comicHalftoneCellSize: 7,
    comicHalftoneInkColor: '#171824',
    comicHalftoneOpacity: 0.7,
    comicHalftoneAngle: 45,
    comicPrintOffsetEnabled: false,
    comicPrintOffsetAmount: 0.0,
    comicPrintOffsetAngle: 20,
    comicPrintOffsetColorA: '#e94a5d',
    comicPrintOffsetColorB: '#36a7b8',
    comicPosterizeEnabled: false,
    comicColorLevels: 6,
    comicLineBoost: 0.34,
    comicLineColor: '#171824',
    comicLineWidth: 1.5,
    comicLineThreshold: 0.05,
  }),
  print: Object.freeze({
    comicHalftoneEnabled: true,
    comicHalftoneStrength: 0.32,
    comicHalftoneCellSize: 7,
    comicHalftoneInkColor: '#17131c',
    comicHalftoneOpacity: 0.6,
    comicHalftoneAngle: 38,
    comicPrintOffsetEnabled: true,
    comicPrintOffsetAmount: 0.45,
    comicPrintOffsetAngle: 20,
    comicPrintOffsetColorA: '#e94a5d',
    comicPrintOffsetColorB: '#36a7b8',
    comicPosterizeEnabled: false,
    comicColorLevels: 10,
    comicLineBoost: 0.2,
    comicLineColor: '#17131c',
    comicLineWidth: 1.5,
    comicLineThreshold: 0.05,
  }),
});

export function getComicLookPreset(presetId) {
  return COMIC_LOOK_PRESETS[String(presetId)] ?? null;
}
