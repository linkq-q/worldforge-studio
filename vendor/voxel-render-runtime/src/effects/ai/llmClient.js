/**
 * llmClient.js — 可注入的 LLM 补全接口 + 文本 provider 路由（Phase 2B）
 *
 * 整个 AI pipeline 只依赖一个抽象函数：
 *   complete({ system, user, temperature, maxTokens, signal }) => Promise<string>  // 返回模型原始文本（期望 JSON）
 *
 * 这样：
 *   - 单测注入 fake complete（不打网络，确定性）；
 *   - 运行时用 createLLMComplete({ provider, apiKey }) 选 DeepSeek 或 GLM（智谱）——两家都 OpenAI 兼容。
 *
 * 视觉模型（glm-5v-turbo / glm-4.6v，content 数组里走 image_url）暂不接入——
 *   生成路径（意图→IR）是纯文本任务，不需要视觉；视觉留给 Phase 3 的 VLM 评审。
 *
 * 硬约束：纯逻辑，禁止 import three。fetch 由运行时/node18+ 提供（可经 opts.fetchImpl 注入以自测）。
 */

// 文本 LLM provider 注册表（均 OpenAI 兼容 /chat/completions：Bearer 鉴权、messages、choices[0].message.content）
export const LLM_PROVIDERS = Object.freeze({
  deepseek: {
    label: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/chat/completions',
    defaultModel: 'deepseek-v4-pro',
  },
  glm: {
    label: 'GLM (智谱)',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    defaultModel: 'glm-5.2', // 文本模型；视觉模型 glm-5v-turbo 留待 Phase 3 VLM 评审
  },
});

export const DEFAULT_PROVIDER = 'glm';

/**
 * OpenAI 兼容 /chat/completions 的通用补全工厂。DeepSeek / GLM 都走它。
 * @param {object} cfg
 * @param {string} cfg.endpoint
 * @param {string} cfg.model
 * @param {string} cfg.apiKey
 * @param {number} [cfg.timeoutMs=30000]
 * @param {Function} [cfg.fetchImpl] - 注入 fetch（自测用），默认全局 fetch
 * @returns {(req:object)=>Promise<string>}
 */
function createOpenAICompatibleComplete({ endpoint, model, apiKey, timeoutMs = 30000, fetchImpl } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new Error('createLLMComplete: no fetch available (pass opts.fetchImpl)');

  return async function complete({ system, user, temperature = 0.2, maxTokens = 1024, signal } = {}) {
    if (!apiKey) throw new Error(`LLM complete: missing apiKey for ${endpoint}`);
    const response = await doFetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
        temperature,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: signal || (typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(timeoutMs) : undefined),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown error');
      throw new Error(`LLM HTTP ${response.status}: ${text}`);
    }
    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM returned empty content');
    return content;
  };
}

/**
 * 造一个走 DeepSeek 的 complete 函数。
 * @param {string} apiKey
 * @param {object} [opts] - { model, endpoint, timeoutMs, fetchImpl }
 */
export function createDeepSeekComplete(apiKey, opts = {}) {
  return createOpenAICompatibleComplete({
    endpoint: opts.endpoint || LLM_PROVIDERS.deepseek.endpoint,
    model: opts.model || LLM_PROVIDERS.deepseek.defaultModel,
    apiKey,
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  });
}

/**
 * 造一个走 GLM（智谱 bigmodel，glm-5.2 文本）的 complete 函数。
 * @param {string} apiKey
 * @param {object} [opts] - { model, endpoint, timeoutMs, fetchImpl }
 */
export function createGLMComplete(apiKey, opts = {}) {
  return createOpenAICompatibleComplete({
    endpoint: opts.endpoint || LLM_PROVIDERS.glm.endpoint,
    model: opts.model || LLM_PROVIDERS.glm.defaultModel,
    apiKey,
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  });
}

/**
 * 文本 provider 路由：按 provider 选 DeepSeek / GLM，统一出口。
 * @param {object} cfg
 * @param {'deepseek'|'glm'} [cfg.provider='glm']
 * @param {string} cfg.apiKey
 * @param {string} [cfg.model] - 覆盖默认 model
 * @param {number} [cfg.timeoutMs]
 * @param {Function} [cfg.fetchImpl]
 * @returns {(req:object)=>Promise<string>}
 */
export function createLLMComplete({ provider = DEFAULT_PROVIDER, apiKey, model, timeoutMs, fetchImpl } = {}) {
  const conf = LLM_PROVIDERS[provider];
  if (!conf) {
    throw new Error(`createLLMComplete: unknown provider "${provider}" (expected one of ${Object.keys(LLM_PROVIDERS).join(', ')})`);
  }
  return createOpenAICompatibleComplete({
    endpoint: conf.endpoint,
    model: model || conf.defaultModel,
    apiKey,
    timeoutMs,
    fetchImpl,
  });
}

/**
 * 宽松解析 LLM 返回的 JSON：容忍 ```json fenced``` 包裹与前后噪声。
 * 失败抛错（供上层走 repair / fallback）。
 * @param {string} raw
 * @returns {object}
 */
export function parseLLMJson(raw) {
  if (typeof raw !== 'string') throw new Error('parseLLMJson: not a string');
  let text = raw.trim();
  // 去 markdown 代码围栏
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  try {
    return JSON.parse(text);
  } catch {
    // 兜底：截取第一个 { 到最后一个 }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error('parseLLMJson: no valid JSON object found');
  }
}
