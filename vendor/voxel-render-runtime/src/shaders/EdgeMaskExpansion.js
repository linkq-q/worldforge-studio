/**
 * Shared screen-space stroke expansion.
 *
 * Edge detection always produces a stable one-pixel mask. Consumers expand
 * that mask afterwards, so increasing line width cannot change which edges
 * were detected or turn a smooth contour into a large-step Sobel staircase.
 */
export const EDGE_MASK_EXPANSION_GLSL = /* glsl */ `
  float edgeMaskRing(
    sampler2D edgeTexture,
    vec2 uv,
    vec2 texel,
    float radius
  ) {
    vec2 axis = texel * radius;
    vec2 diagonal = axis * 0.70710678;
    float edge = 0.0;
    edge = max(edge, texture2D(edgeTexture, uv + vec2( axis.x, 0.0)).r);
    edge = max(edge, texture2D(edgeTexture, uv + vec2(-axis.x, 0.0)).r);
    edge = max(edge, texture2D(edgeTexture, uv + vec2(0.0,  axis.y)).r);
    edge = max(edge, texture2D(edgeTexture, uv + vec2(0.0, -axis.y)).r);
    edge = max(edge, texture2D(edgeTexture, uv + vec2( diagonal.x,  diagonal.y)).r);
    edge = max(edge, texture2D(edgeTexture, uv + vec2(-diagonal.x,  diagonal.y)).r);
    edge = max(edge, texture2D(edgeTexture, uv + vec2( diagonal.x, -diagonal.y)).r);
    edge = max(edge, texture2D(edgeTexture, uv + vec2(-diagonal.x, -diagonal.y)).r);
    return edge;
  }

  float expandEdgeMask(
    sampler2D edgeTexture,
    vec2 uv,
    vec2 resolution,
    float strokeWidth
  ) {
    vec2 texel = 1.0 / max(resolution, vec2(1.0));
    float width = clamp(strokeWidth, 0.5, 5.0);
    float edge = texture2D(edgeTexture, uv).r;

    float ring1 = clamp(width + 0.5 - 1.0, 0.0, 1.0);
    float ring2 = clamp(width + 0.5 - 2.0, 0.0, 1.0);
    float ring3 = clamp(width + 0.5 - 3.0, 0.0, 1.0);
    float ring4 = clamp(width + 0.5 - 4.0, 0.0, 1.0);
    float ring5 = clamp(width + 0.5 - 5.0, 0.0, 1.0);

    edge = max(edge, edgeMaskRing(edgeTexture, uv, texel, 1.0) * ring1);
    edge = max(edge, edgeMaskRing(edgeTexture, uv, texel, 2.0) * ring2);
    edge = max(edge, edgeMaskRing(edgeTexture, uv, texel, 3.0) * ring3);
    edge = max(edge, edgeMaskRing(edgeTexture, uv, texel, 4.0) * ring4);
    edge = max(edge, edgeMaskRing(edgeTexture, uv, texel, 5.0) * ring5);

    float aa = max(fwidth(edge) * 1.25, 1.0 / 255.0);
    return smoothstep(0.12 - aa, 0.12 + aa, edge);
  }
`;
