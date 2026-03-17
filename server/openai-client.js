const OpenAI = require('openai');

const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const DEFAULT_OPENROUTER_MODEL = 'deepseek/deepseek-v3.2';

function isOpenRouterKey(apiKey) {
  return Boolean(apiKey && apiKey.startsWith('sk-or-'));
}

function isOpenRouterModel(model) {
  const normalized = String(model || '').trim().toLowerCase();
  return normalized === 'openrouter/free' ||
    normalized.endsWith(':free') ||
    normalized.startsWith('openrouter/') ||
    normalized.includes('/');
}

function defaultModelForApiKey(apiKey) {
  return isOpenRouterKey(apiKey) ? DEFAULT_OPENROUTER_MODEL : DEFAULT_OPENAI_MODEL;
}

function getActualModel(apiKey, model) {
  const requested = String(model || '').trim() || defaultModelForApiKey(apiKey);
  if (isOpenRouterKey(apiKey)) {
    const openRouterMap = {
      'gpt-4o-mini': 'openai/gpt-4o-mini',
      'gpt-4o': 'openai/gpt-4o',
      'gpt-4-turbo': 'openai/gpt-4-turbo',
    };
    return openRouterMap[requested] || requested;
  }
  if (isOpenRouterModel(requested)) {
    throw new Error('OpenRouter models require an OpenRouter API key');
  }
  return requested;
}

function getFreeRouterTokenFloor(jsonMode) {
  return jsonMode ? 1200 : 900;
}

function formatRateLimitReset(value = '') {
  const resetAt = Number(value || 0);
  if (!Number.isFinite(resetAt) || resetAt <= 0) return '';
  try {
    return new Date(resetAt).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '';
  }
}

function buildChatRequest(apiKey, system, user, opts = {}, runtime = {}) {
  const {
    temperature = runtime.jsonMode === false ? 0.25 : 0.3,
    model = defaultModelForApiKey(apiKey),
    maxTokens = runtime.jsonMode === false ? 8192 : 4096,
    disableReasoning = false,
  } = opts;
  const jsonMode = runtime.jsonMode !== false;
  const actualModel = getActualModel(apiKey, model);
  const openRouter = isOpenRouterKey(apiKey);
  const freeModel = openRouter && (actualModel === 'openrouter/free' || String(actualModel).endsWith(':free'));
  const provider = freeModel ? {
    sort: 'latency',
    require_parameters: true,
    allow_fallbacks: true,
    ...(runtime.ignoredProviders?.length ? { ignore: runtime.ignoredProviders } : {}),
  } : undefined;
  const plugins = openRouter && jsonMode ? [{ id: 'response-healing' }] : undefined;
  const effectiveMaxTokens = freeModel ? Math.max(maxTokens, getFreeRouterTokenFloor(jsonMode)) : maxTokens;

  return {
    clientOptions: {
      apiKey,
      baseURL: openRouter ? 'https://openrouter.ai/api/v1' : undefined,
      defaultHeaders: openRouter ? {
        'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'http://localhost',
        'X-Title': process.env.OPENROUTER_APP_TITLE || 'CV Customizer',
      } : undefined,
    },
    requestOptions: {
      model: actualModel,
      temperature,
      max_tokens: effectiveMaxTokens,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      ...(provider ? { provider } : {}),
      ...(plugins ? { plugins } : {}),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    },
    requestMeta: {
      model: actualModel,
      requestedModel: model,
      provider: openRouter ? 'openrouter' : 'openai',
      freeModel,
      jsonMode,
      plugins: plugins || [],
      reasoningDisabled: false,
      maxTokens: effectiveMaxTokens,
      ignoredProviders: runtime.ignoredProviders || [],
    },
  };
}

function getCompletionPayload(resp) {
  const message = resp?.choices?.[0]?.message;
  function extractMessageText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((part) => extractMessageText(part)).filter(Boolean).join('\n');
    }
    if (content && typeof content.text === 'string') return content.text;
    if (content && typeof content.content === 'string') return content.content;
    if (content && Array.isArray(content.content)) {
      return content.content.map((part) => extractMessageText(part)).filter(Boolean).join('\n');
    }
    return '';
  }
  return {
    message,
    raw: extractMessageText(message?.content),
    usage: resp?.usage || {},
  };
}

function buildEmptyContentError(message) {
  return new Error(message?.reasoning
    ? 'Model returned reasoning without a final answer'
    : 'Model returned empty content');
}

function parseStructuredJson(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return null;

  const candidates = [text];
  const fencedJson = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedJson?.[1]) {
    candidates.push(String(fencedJson[1]).trim());
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  const seen = new Set();
  for (const candidate of candidates) {
    const normalized = String(candidate || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    try {
      return JSON.parse(normalized);
    } catch {}
  }

  return null;
}

function providerSlug(providerName = '') {
  return String(providerName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isDeveloperInstructionError(err) {
  const raw = String(
    err?.error?.metadata?.raw ||
    err?.error?.message ||
    err?.message ||
    ''
  );
  return /developer instruction is not enabled/i.test(raw);
}

function isRoutingParameterError(err) {
  const raw = String(
    err?.error?.metadata?.raw ||
    err?.error?.message ||
    err?.message ||
    ''
  );
  const status = Number(err?.status || err?.error?.code || 0);
  return Boolean(
    /no endpoints found that can handle the requested parameters/i.test(raw) ||
    /provider routing/i.test(raw) ||
    /unsupported parameter/i.test(raw) ||
    status === 404
  );
}

function isReasoningConstraintError(err) {
  const raw = String(
    err?.error?.metadata?.raw ||
    err?.error?.message ||
    err?.message ||
    ''
  );
  return Boolean(
    /reasoning is mandatory/i.test(raw) ||
    /cannot be disabled/i.test(raw)
  );
}

function isRecoverableProviderError(err) {
  const raw = String(
    err?.error?.metadata?.raw ||
    err?.error?.message ||
    err?.message ||
    ''
  );
  const status = Number(err?.status || err?.error?.code || 0);
  return Boolean(
    /provider returned error/i.test(raw) ||
    /spend limit exceeded/i.test(raw) ||
    /credits required/i.test(raw) ||
    (status === 402 && err?.error?.metadata?.provider_name)
  );
}

function isFreeModelRateLimitError(err) {
  const raw = String(
    err?.error?.metadata?.raw ||
    err?.error?.message ||
    err?.message ||
    ''
  );
  const status = Number(err?.status || err?.error?.code || 0);
  return status === 429 && /free-models-per-min/i.test(raw);
}

function buildFriendlyProviderError(err) {
  if (isFreeModelRateLimitError(err)) {
    const resetHeader = err?.headers?.['x-ratelimit-reset'] || err?.error?.metadata?.headers?.['x-ratelimit-reset'];
    const resetTime = formatRateLimitReset(resetHeader);
    return new Error(
      resetTime
        ? `OpenRouter free-model rate limit reached. Wait until ${resetTime} or switch to a non-free model like deepseek/deepseek-v3.2 or google/gemini-2.5-flash.`
        : 'OpenRouter free-model rate limit reached. Wait a minute or switch to a non-free model like deepseek/deepseek-v3.2 or google/gemini-2.5-flash.'
    );
  }
  return err;
}

function cloneBuiltRequest(built, label, mutateRequestOptions, mutateRequestMeta) {
  const requestOptions = { ...built.requestOptions };
  const requestMeta = { ...built.requestMeta, routingFallback: label };
  mutateRequestOptions(requestOptions);
  if (typeof mutateRequestMeta === 'function') mutateRequestMeta(requestMeta);
  return {
    clientOptions: built.clientOptions,
    requestOptions,
    requestMeta,
  };
}

function dedupeRequestVariants(variants = []) {
  const seen = new Set();
  return variants.filter((variant) => {
    const key = JSON.stringify(variant.requestOptions);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildRequestVariants(apiKey, system, user, opts, runtime) {
  const built = buildChatRequest(apiKey, system, user, opts, runtime);
  const variants = [built];
  if (built.requestMeta.provider !== 'openrouter') {
    return variants;
  }

  if (built.requestOptions.reasoning) {
    variants.push(cloneBuiltRequest(
      built,
      'with_reasoning_enabled',
      (requestOptions) => {
        delete requestOptions.reasoning;
      },
      (requestMeta) => {
        requestMeta.reasoningDisabled = false;
        requestMeta.reasoningRelaxed = true;
      }
    ));
  }

  if (built.requestOptions.plugins) {
    variants.push(cloneBuiltRequest(
      built,
      'without_plugins',
      (requestOptions) => {
        delete requestOptions.plugins;
      },
      (requestMeta) => {
        requestMeta.plugins = [];
      }
    ));
  }

  if (built.requestOptions.reasoning && built.requestOptions.plugins) {
    variants.push(cloneBuiltRequest(
      built,
      'with_reasoning_enabled_without_plugins',
      (requestOptions) => {
        delete requestOptions.reasoning;
        delete requestOptions.plugins;
      },
      (requestMeta) => {
        requestMeta.reasoningDisabled = false;
        requestMeta.reasoningRelaxed = true;
        requestMeta.plugins = [];
      }
    ));
  }

  if (built.requestOptions.response_format) {
    variants.push(cloneBuiltRequest(
      built,
      'without_plugins_or_response_format',
      (requestOptions) => {
        delete requestOptions.plugins;
        delete requestOptions.response_format;
      },
      (requestMeta) => {
        requestMeta.plugins = [];
        requestMeta.responseFormatRelaxed = true;
      }
    ));
  }

  if (built.requestOptions.reasoning && built.requestOptions.response_format) {
    variants.push(cloneBuiltRequest(
      built,
      'with_reasoning_enabled_without_plugins_or_response_format',
      (requestOptions) => {
        delete requestOptions.reasoning;
        delete requestOptions.plugins;
        delete requestOptions.response_format;
      },
      (requestMeta) => {
        requestMeta.reasoningDisabled = false;
        requestMeta.reasoningRelaxed = true;
        requestMeta.plugins = [];
        requestMeta.responseFormatRelaxed = true;
      }
    ));
  }

  if (built.requestOptions.provider) {
    variants.push(cloneBuiltRequest(
      built,
      'without_plugins_response_format_or_provider_constraints',
      (requestOptions) => {
        delete requestOptions.plugins;
        delete requestOptions.response_format;
        delete requestOptions.provider;
      },
      (requestMeta) => {
        requestMeta.plugins = [];
        requestMeta.responseFormatRelaxed = true;
        requestMeta.providerConstraintsRelaxed = true;
      }
    ));
  }

  if (built.requestOptions.reasoning && built.requestOptions.provider) {
    variants.push(cloneBuiltRequest(
      built,
      'with_reasoning_enabled_without_plugins_response_format_or_provider_constraints',
      (requestOptions) => {
        delete requestOptions.reasoning;
        delete requestOptions.plugins;
        delete requestOptions.response_format;
        delete requestOptions.provider;
      },
      (requestMeta) => {
        requestMeta.reasoningDisabled = false;
        requestMeta.reasoningRelaxed = true;
        requestMeta.plugins = [];
        requestMeta.responseFormatRelaxed = true;
        requestMeta.providerConstraintsRelaxed = true;
      }
    ));
  }

  return dedupeRequestVariants(variants);
}

async function executeWithProviderRecovery(apiKey, system, user, opts, runtime) {
  const variants = buildRequestVariants(apiKey, system, user, opts, runtime);
  let lastError;

  for (let index = 0; index < variants.length; index += 1) {
    const built = variants[index];
    const client = new OpenAI(built.clientOptions);

    try {
      const resp = await client.chat.completions.create(built.requestOptions);
      const payload = getCompletionPayload(resp);
      if (!String(payload.raw || '').trim()) {
        lastError = buildEmptyContentError(payload.message);
        if (index < variants.length - 1) {
          continue;
        }
        throw lastError;
      }
      return {
        ...payload,
        requestMeta: built.requestMeta,
      };
    } catch (err) {
      lastError = err;
      const hasMoreVariants = index < variants.length - 1;
      if (!hasMoreVariants) {
        throw err;
      }
      if (!(isRoutingParameterError(err) || isDeveloperInstructionError(err) || isReasoningConstraintError(err))) {
        throw err;
      }
    }
  }

  throw lastError;
}

/**
 * Call OpenAI chat completions with retry, structured JSON output, and token tracking.
 *
 * @param {string} apiKey   — user-supplied key (never stored server-side)
 * @param {string} system   — system prompt
 * @param {string} user     — user prompt
 * @param {object} [opts]
 * @param {number} [opts.temperature=0.3]
 * @param {string} [opts.model='gpt-4o-mini']
 * @param {number} [opts.maxTokens=4096]
 * @param {number} [opts.retries=3]
 * @returns {Promise<{data: object|string, usage: object}>}
 */
async function callOpenAI(apiKey, system, user, opts = {}) {
  const {
    retries = isOpenRouterKey(apiKey) ? 2 : 1,
  } = opts;

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const payload = await executeWithProviderRecovery(apiKey, system, user, opts, { jsonMode: true });
      const raw = payload.raw;
      const usage = payload.usage;
      const requestMeta = payload.requestMeta;

      if (!raw.trim()) {
        throw buildEmptyContentError(payload.message);
      }

      const data = parseStructuredJson(raw) ?? raw;

      return { data, usage, requestMeta };
    } catch (err) {
      lastError = err;
      console.error('OpenAI Error Trace:', JSON.stringify(err, null, 2));
      if (isFreeModelRateLimitError(err)) {
        throw buildFriendlyProviderError(err);
      }
      if (attempt >= retries || !isRecoverableProviderError(err)) {
        throw buildFriendlyProviderError(err);
      }
    }
  }
  throw lastError;
}

/**
 * Call OpenAI for LaTeX editing — uses plain text output (not JSON) to preserve LaTeX.
 */
async function callOpenAIText(apiKey, system, user, opts = {}) {
  const {
    retries = isOpenRouterKey(apiKey) ? 2 : 1,
  } = opts;

  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const payload = await executeWithProviderRecovery(apiKey, system, user, opts, { jsonMode: false });
      const raw = payload.raw;
      const usage = payload.usage;
      const requestMeta = payload.requestMeta;
      if (!raw.trim()) {
        throw buildEmptyContentError(payload.message);
      }
      return { data: raw, usage, requestMeta };
    } catch (err) {
      lastError = err;
      console.error('OpenAIText Error Trace:', JSON.stringify(err, null, 2));
      if (isFreeModelRateLimitError(err)) {
        throw buildFriendlyProviderError(err);
      }
      if (attempt >= retries || !isRecoverableProviderError(err)) {
        throw buildFriendlyProviderError(err);
      }
    }
  }
  throw lastError;
}

module.exports = {
  buildChatRequest,
  buildRequestVariants,
  callOpenAI,
  callOpenAIText,
  getActualModel,
  isOpenRouterKey,
  isOpenRouterModel,
  parseStructuredJson,
};
