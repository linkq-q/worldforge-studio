import { describe, expect, it } from 'vitest';
import { compileSimpleShaderExpression } from '../src/shared/simpleShader';

describe('simple shader expression boundary', () => {
  it('compiles typed bounded expressions into a fixed shader template', () => {
    expect(compileSimpleShaderExpression('mix(color, vec3(1, 0.5, 0), 0.2 * abs(sin(position.x + time)))')).toContain('vec3(1.0, 0.5, 0.0)');
  });
  it.each(['for(;;){}', '#include <common>', 'texture2D(map, uv).rgb', 'color; discard;', 'color / 0.0', 'unknown(color)', 'vec3(1,2)', 'sin(color, time)', 'time', 'color + vec2(1,2)', 'color /* comment */', 'vec3(smoothstep(1, 1, time))', 'vec3(smoothstep(time, time, time))'])('rejects %s', expression => {
    expect(() => compileSimpleShaderExpression(expression)).toThrow();
  });
  it('bounds depth and expression size', () => {
    expect(() => compileSimpleShaderExpression('constructor.rgb')).toThrow();
    expect(() => compileSimpleShaderExpression('sin('.repeat(30) + 'color' + ')'.repeat(30))).toThrow();
    expect(() => compileSimpleShaderExpression('color' + ' + color'.repeat(200))).toThrow();
  });
});
