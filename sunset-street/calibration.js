// [M01] Measured image landmarks; depths/scale are estimates, not recovered facts.
export const FRAME = { width: 1672, height: 941, cx: 954, cy: 550, fov: 52, cameraHeight: 1.8, slope: 0.12 };
export const focal = FRAME.height / (2 * Math.tan(FRAME.fov * Math.PI / 360));
export const landmarks = { sun: [954,529], leftPoleFoot: [459,792], rightPoleFoot: [1377,752], signal: [765,258], roadSign: [610,248] };
export const groundY = z => FRAME.slope * z;
// [M02] Invert pinhole projection at an assumed positive camera depth d.
export function atDepth(u, v, d) { return [(u-FRAME.cx)*d/focal, FRAME.cameraHeight-(v-FRAME.cy)*d/focal, -d]; }
// Ground ray intersection: v-cy = f*(cameraHeight/d + slope).
export function onGround(u,v) {
  const denominator=(v-FRAME.cy)/focal-FRAME.slope;
  if(denominator<=0) throw new RangeError('Pixel is above the sloping ground horizon');
  return atDepth(u,v,FRAME.cameraHeight/denominator);
}
export function project([x,y,z]) { const d=-z;return [FRAME.cx+focal*x/d, FRAME.cy+focal*(FRAME.cameraHeight-y)/d]; }
