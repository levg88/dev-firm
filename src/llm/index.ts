import { Settings } from '../config';
import { AnthropicClient } from './anthropic';
import { LLMClient, LLMError } from './base';
import { MockClient } from './mock';
import { OpenAICompatClient } from './openai-compat';

export { LLMClient, LLMError } from './base';
export type { CompleteOptions, LLMResponse, ToolCall } from './base';
export { MockClient } from './mock';
export { OpenAICompatClient } from './openai-compat';
export { AnthropicClient } from './anthropic';
export { parseJsonObject } from './base';

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
