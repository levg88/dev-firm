/**
 * Factory for building an {@link LLMClient} from {@link Settings}, including
 * per-role model/base-URL overrides.
 *
 * @module llm/index
 */
import { Settings } from '../config';
import { AnthropicClient } from './anthropic';
import { LLMClient, LLMError, LLMResponse } from './base';
import { MockClient } from './mock';
import { OpenAICompatClient } from './openai-compat';

export { LLMClient, LLMError } from './base';
export type { CompleteOptions, LLMResponse, ToolCall } from './base';
export { MockClient } from './mock';
export { OpenAICompatClient } from './openai-compat';
export { AnthropicClient } from './anthropic';
export { parseJsonObject } from './base';

/** Build an LLM client using default settings. */
export function buildLlm(settings: Settings): LLMClient {
  return buildLlmForRole(settings, undefined);
}

/**
 * Build an LLM client for a specific agent role.
 * Falls back to the default settings.model / ollamaBaseUrl when no role override is set.
 * Enables multiple Ollama instances (e.g. beam-free for developers, deepseek for tech lead/QA).
 */
export function buildLlmForRole(settings: Settings, role: string | undefined): LLMClient {
  const provider = settings.provider;
  if (provider === 'mock') {
    return new MockClient('Offline mode selected');
  }

  const roleModel = role && settings.roleModels?.[role] ? settings.roleModels[role] : settings.model;
  const roleBaseUrl = role && settings.roleBaseUrls?.[role] ? settings.roleBaseUrls[role] : undefined;

  if (provider === 'anthropic') {
    if (!settings.anthropicApiKey) {
      return new MockClient('No Anthropic API key is configured');
    }
    return new AnthropicClient({
      apiKey: settings.anthropicApiKey,
      baseUrl: settings.anthropicBaseUrl,
      model: roleModel,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      timeout: settings.timeout,
    });
  }

  if (provider === 'ollama') {
    return new OpenAICompatClient({
      apiKey: 'ollama',
      baseUrl: roleBaseUrl ?? settings.ollamaBaseUrl,
      model: roleModel,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      timeout: settings.timeout,
      provider: 'ollama',
    });
  }

  if (provider === 'openai') {
    if (!settings.apiKey) {
      return new MockClient('No OpenAI API key is configured');
    }
    return new OpenAICompatClient({
      apiKey: settings.apiKey,
      baseUrl: roleBaseUrl ?? settings.baseUrl,
      model: roleModel,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      timeout: settings.timeout,
      provider: 'openai',
    });
  }

  if (provider === 'opencode') {
    if (!settings.opencodeApiKey) {
      return new MockClient('No OpenCode API key is configured');
    }
    return new OpenAICompatClient({
      apiKey: settings.opencodeApiKey,
      baseUrl: roleBaseUrl ?? settings.opencodeBaseUrl,
      model: roleModel,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      timeout: settings.timeout,
      provider: 'opencode',
    });
  }

  throw new LLMError(`Unknown provider: ${provider}`);
}

/**
 * An LLM client that tries several underlying clients in order, falling back
 * to the next one when the current model is rate-limited or unavailable.
 * Used by the chat concierge to rotate across free hosted models.
 */
export class FallbackLlmClient extends LLMClient {
  readonly provider: string;
  readonly model: string;
  private candidates: LLMClient[];
  private disabled = new Map<number, number>(); // index -> re-enable timestamp

  constructor(candidates: LLMClient[]) {
    super();
    if (candidates.length === 0) throw new LLMError('No LLM candidates provided');
    this.candidates = candidates;
    this.provider = candidates[0].provider;
    this.model = candidates[0].model;
  }

  async complete(messages: any[], options?: any): Promise<LLMResponse> {
    const now = Date.now();
    let lastError: unknown = null;
    for (let i = 0; i < this.candidates.length; i++) {
      const until = this.disabled.get(i);
      if (until && until > now) continue;
      const client = this.candidates[i];
      try {
        const result = await client.complete(messages, options);
        // Update advertised model/provider to the one that actually worked.
        (this as any).provider = client.provider;
        (this as any).model = client.model;
        return result;
      } catch (error) {
        lastError = error;
        const msg = error instanceof Error ? error.message : String(error);
        if (/429|rate.?limit|FreeUsageLimit|usage limit|throttl/i.test(msg)) {
          // Disable this candidate for 5 minutes.
          this.disabled.set(i, now + 5 * 60 * 1000);
          continue;
        }
        // Non-rate-limit error: try next candidate anyway.
        continue;
      }
    }
    throw (lastError instanceof Error ? lastError : new Error(String(lastError)));
  }
}

/**
 * Build the LLM client used by the chat concierge. Supports per-model fallback
 * rotation across the configured free/paid models.
 */
export function buildAgentLlm(settings: Settings, role?: string): LLMClient {
  // Per-role model override (e.g. DEV_FIRM_MODEL_ARCHITECT) takes precedence.
  const roleModel = role && settings.roleModels?.[role] ? settings.roleModels[role] : undefined;
  const roleBaseUrl = role && settings.roleBaseUrls?.[role] ? settings.roleBaseUrls[role] : undefined;

  const provider = settings.agentProvider || settings.provider;
  const model = roleModel || settings.agentModel || settings.model;
  const baseUrl = roleBaseUrl || settings.agentBaseUrl || (provider === 'opencode' ? settings.opencodeBaseUrl : (provider === 'ollama' ? settings.ollamaBaseUrl : settings.baseUrl));
  const apiKey = settings.agentApiKey || (provider === 'opencode' ? settings.opencodeApiKey : (provider === 'openai' ? settings.apiKey : (provider === 'anthropic' ? settings.anthropicApiKey : 'ollama')));

  const buildOne = (m: string): LLMClient => {
    if (provider === 'mock') return new (require('./mock').MockClient)('Offline mode');
    if (provider === 'anthropic') {
      if (!apiKey) return new (require('./mock').MockClient)('No Anthropic API key');
      return new AnthropicClient({ apiKey, baseUrl, model: m, temperature: settings.temperature, maxTokens: settings.maxTokens, timeout: settings.timeout });
    }
    return new OpenAICompatClient({ apiKey: apiKey || 'ollama', baseUrl, model: m, temperature: settings.temperature, maxTokens: settings.maxTokens, timeout: settings.timeout, provider: provider as any });
  };

  // Offline guard.
  if (provider === 'opencode' && !apiKey) return new (require('./mock').MockClient)('No OpenCode API key');
  if (provider === 'openai' && !apiKey) return new (require('./mock').MockClient)('No OpenAI API key');
  if (provider === 'anthropic' && !apiKey) return new (require('./mock').MockClient)('No Anthropic API key');

  const candidates: LLMClient[] = [];
  const seen = new Set<string>();
  const add = (m: string) => {
    const mm = (m || '').trim();
    if (!mm || seen.has(mm)) return;
    seen.add(mm);
    candidates.push(buildOne(mm));
  };
  add(model);
  for (const m of settings.agentFallbackModels ?? []) add(m);

  // Last-resort fallback: local Ollama (slow but always available).
  if (provider !== 'ollama' && settings.ollamaBaseUrl) {
    const ollamaClient = new OpenAICompatClient({
      apiKey: 'ollama',
      baseUrl: settings.ollamaBaseUrl,
      model: settings.model || 'qwen2.5-coder:14b',
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      timeout: settings.timeout,
      provider: 'ollama',
    });
    candidates.push(ollamaClient);
  }

  if (candidates.length === 1) return candidates[0];
  return new FallbackLlmClient(candidates);
}

export function buildConciergeLlm(settings: Settings): LLMClient {
  const provider = settings.conciergeProvider || settings.provider;
  const model = settings.conciergeModel || settings.model;

  // No key for a hosted provider -> offline.
  if (provider === 'opencode' && !settings.conciergeApiKey && !settings.opencodeApiKey) {
    return new MockClient('No OpenCode API key is configured');
  }
  if (provider === 'openai' && !settings.conciergeApiKey && !settings.apiKey) {
    return new MockClient('No OpenAI API key is configured');
  }
  if (provider === 'anthropic' && !settings.conciergeApiKey && !settings.anthropicApiKey) {
    return new MockClient('No Anthropic API key is configured');
  }
  const baseUrl = settings.conciergeBaseUrl || (provider === 'opencode' ? settings.opencodeBaseUrl : (provider === 'ollama' ? settings.ollamaBaseUrl : settings.baseUrl));
  const apiKey = settings.conciergeApiKey || (provider === 'opencode' ? settings.opencodeApiKey : (provider === 'openai' ? settings.apiKey : (provider === 'anthropic' ? settings.anthropicApiKey : 'ollama')));

  const buildOne = (m: string): LLMClient => {
    if (provider === 'mock') return new (require('./mock').MockClient)('Offline mode');
    if (provider === 'anthropic') {
      if (!apiKey) return new (require('./mock').MockClient)('No Anthropic API key');
      return new AnthropicClient({ apiKey, baseUrl, model: m, temperature: settings.temperature, maxTokens: settings.maxTokens, timeout: settings.timeout });
    }
    return new OpenAICompatClient({ apiKey: apiKey || 'ollama', baseUrl, model: m, temperature: settings.temperature, maxTokens: settings.maxTokens, timeout: settings.timeout, provider: provider as any });
  };

  const candidates: LLMClient[] = [];
  const seen = new Set<string>();
  const add = (m: string) => {
    const mm = (m || '').trim();
    if (!mm || seen.has(mm)) return;
    seen.add(mm);
    candidates.push(buildOne(mm));
  };
  add(model);
  for (const m of settings.conciergeFallbackModels ?? []) add(m);

  // Last-resort fallback: local Ollama (slow but always available) so the
  // chat keeps working when every hosted model is rate-limited.
  if (provider !== 'ollama' && settings.ollamaBaseUrl) {
    const ollamaClient = new OpenAICompatClient({
      apiKey: 'ollama',
      baseUrl: settings.ollamaBaseUrl,
      model: settings.model || 'qwen2.5-coder:14b',
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      timeout: settings.timeout,
      provider: 'ollama',
    });
    candidates.push(ollamaClient);
  }

  if (candidates.length === 1) return candidates[0];
  return new FallbackLlmClient(candidates);
}
