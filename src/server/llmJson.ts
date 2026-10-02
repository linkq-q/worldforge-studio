/** Extracts the last complete JSON object from common LLM response wrappers. */
export function parseLlmJsonObject(content: string, errorCode: string): Record<string, unknown> {
  const candidates: string[] = [];
  const trimmed = content.trim();
  if (trimmed) candidates.push(trimmed);

  const rootedCandidates: string[] = [];
  if (trimmed.startsWith('{')) rootedCandidates.push(trimmed);
  for (const match of content.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const fenced = match[1]?.trim();
    if (fenced) {
      candidates.push(fenced);
      if (fenced.startsWith('{')) rootedCandidates.push(fenced);
    }
  }
  if (rootedCandidates.length) {
    for (const rooted of rootedCandidates) {
      const root = balancedJsonObjects(rooted).find(candidate => rooted.startsWith(candidate));
      if (root) candidates.push(root);
    }
  } else {
    candidates.push(...balancedJsonObjects(content));
  }

  let result: Record<string, unknown> | null = null;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        result = parsed as Record<string, unknown>;
      }
    } catch {
      // Only repair structural closers; never invent a value or close a string.
      const repaired = repairContainerClosers(candidate);
      if (repaired) {
        try {
          const parsed = JSON.parse(repaired) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            result = parsed as Record<string, unknown>;
          }
        } catch { /* The content is malformed beyond structural closers. */ }
      }
    }
  }
  if (!result) throw new Error(errorCode);
  return result;
}

function repairContainerClosers(content: string): string | undefined {
  const maxRepairedClosers = 4;
  if (!/[}\]]$/.test(content)) return undefined;
  const stack: string[] = [];
  let repaired = '';
  let repairedClosers = 0;
  let inString = false, escaped = false;
  for (const char of content) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{' || char === '[') stack.push(char === '{' ? '}' : ']');
    else if (char === '}' || char === ']') {
      if (stack.at(-1) === char) stack.pop();
      else if (stack.at(-1) === ']' && stack.at(-2) === char && repairedClosers < maxRepairedClosers) {
        repaired += stack.pop() as string;
        repairedClosers += 1;
        continue;
      } else return undefined;
    }
    repaired += char;
  }
  if (inString || repairedClosers + stack.length === 0
    || repairedClosers + stack.length > maxRepairedClosers) return undefined;
  return repaired + stack.reverse().join('');
}

function balancedJsonObjects(content: string): string[] {
  const results: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (start < 0) {
      if (char === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        results.push(content.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return results;
}
