type ValueType = 1 | 2 | 3;
interface Expression { source: string; type: ValueType; literal?: number }

/** Shader ladder level 2: expressions only, never statements, resources or user functions. */
export function compileSimpleShaderExpression(input: string): string {
  const fail = (): never => { throw new Error('invalid_simple_shader_expression'); };
  if (typeof input !== 'string' || !input.trim() || input.length > 1024) return fail();
  const tokens = input.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[a-zA-Z_]\w*|[().,+*\-]/g) ?? [];
  if (tokens.join('') !== input.replace(/\s/g, '') || tokens.length > 192) return fail();
  let index = 0;
  let nodes = 0;
  const variables: Record<string, ValueType> = { color: 3, position: 3, normal: 3, uv: 2, time: 1 };
  const next = () => tokens[index++];
  const expect = (token: string) => { if (next() !== token) fail(); };
  const compatible = (a: ValueType, b: ValueType): ValueType => {
    if (a !== b && a !== 1 && b !== 1) return fail();
    return Math.max(a, b) as ValueType;
  };
  const expression = (depth: number, minimum = 0): Expression => {
    if (depth > 16 || ++nodes > 96) return fail();
    let value: Expression;
    const token = next();
    if (token === '-' || token === '+') {
      const child = expression(depth + 1, 3);
      value = { source: `(${token}${child.source})`, type: child.type, ...(child.literal === undefined ? {} : { literal: token === '-' ? -child.literal : child.literal }) };
    } else if (token === '(') {
      value = expression(depth + 1);
      expect(')');
    } else if (/^(?:\d|\.)/.test(token ?? '')) {
      const number = Number(token);
      if (!Number.isFinite(number) || Math.abs(number) > 10000) return fail();
      value = { source: Number.isInteger(number) ? `${number}.0` : String(number), type: 1, literal: number };
    } else if (tokens[index] === '(') {
      next();
      const args: Expression[] = [];
      if (tokens[index] !== ')') {
        do {
          if (args.length) expect(',');
          args.push(expression(depth + 1));
          if (args.length > 3) fail();
        } while (tokens[index] === ',');
      }
      expect(')');
      let type: ValueType;
      if (token === 'vec2' || token === 'vec3') {
        type = token === 'vec2' ? 2 : 3;
        if (!(args.length === 1 && args[0].type === 1) && args.reduce((sum, arg) => sum + arg.type, 0) !== type) fail();
      } else if (['sin', 'cos', 'abs', 'fract'].includes(token)) {
        if (args.length !== 1) fail();
        type = args[0].type;
      } else if (['min', 'max'].includes(token)) {
        if (args.length !== 2) fail();
        type = args[0].type;
        if (args[1].type !== type && args[1].type !== 1) fail();
      } else if (token === 'mix') {
        if (args.length !== 3 || args[0].type !== args[1].type) fail();
        type = args[0].type;
        if (args[2].type !== type && args[2].type !== 1) fail();
      } else if (token === 'clamp' || token === 'smoothstep') {
        if (args.length !== 3) fail();
        type = token === 'clamp' ? args[0].type : args[2].type;
        if (token === 'clamp') {
          if (args[1].type !== args[2].type || (args[1].type !== 1 && args[1].type !== type)) fail();
        } else if (args[0].literal === undefined || args[1].literal === undefined || args[1].literal - args[0].literal < 0.0001) fail();
      } else return fail();
      // Finite inputs remain bounded, including nested multiplication.
      value = { source: `${token}(${args.map(arg => arg.source).join(', ')})`, type };
    } else {
      const type = Object.hasOwn(variables, token) ? variables[token] : undefined;
      if (!type) return fail();
      value = { source: `wf_${token}`, type };
    }
    if (tokens[index] === '.') {
      next();
      const swizzle = next();
      if (!swizzle || !/^(?:[xyz]{1,3}|[rgb]{1,3})$/.test(swizzle) || value.type === 1) fail();
      if (value.type === 2 && /[zb]/.test(swizzle)) fail();
      value = { source: `(${value.source}).${swizzle}`, type: swizzle.length as ValueType };
    }
    while (true) {
      const operator = tokens[index];
      const precedence = operator === '*' ? 2 : operator === '+' || operator === '-' ? 1 : 0;
      if (!precedence || precedence <= minimum) break;
      next();
      const right = expression(depth + 1, precedence);
      const type = compatible(value.type, right.type);
      value = { source: `clamp((${value.source} ${operator} ${right.source}), ${type === 1 ? '-10000.0, 10000.0' : `vec${type}(-10000.0), vec${type}(10000.0)`})`, type };
    }
    return value;
  };
  const result = expression(0);
  if (index !== tokens.length || result.type !== 3) return fail();
  return result.source;
}
