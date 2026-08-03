/** Extracts the last complete JSON object from common LLM response wrappers. */
export function parseLlmJsonObject(content: string, errorCode: string): Record<string, unknown> {
  const candidates: string[] = [];
  const trimmed = content.trim();
  if (trimmed) candidates.push(trimmed);

  for (const match of content.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]?.trim()) candidates.push(match[1].trim());
  }
  candidates.push(...balancedJsonObjects(content));

  let result: Record<string, unknown> | null = null;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        result = parsed as Record<string, unknown>;
      }
    } catch {
      // Continue: LLMs commonly wrap a valid object in prose or add one stray brace.
    }
  }
  if (!result) throw new Error(errorCode);
  return result;
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
