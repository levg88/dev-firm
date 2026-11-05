import {
  CompleteOptions,
  LLMClient,
  LLMError,
  LLMResponse,
  ToolCall,
  contentAsText,
  response,
  sleep,
} from './base';

export class OpenAICompatClient extends LLMClient {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  temperature: number;
  maxTokens: number;
  timeout: number;

  constructor(options: {
    apiKey: string;
    baseUrl: string;
    model: string;
    temperature?: number;
    maxTokens?: number;
    timeout?: number;
    provider?: string;
  }) {
    super();
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.model = options.model;
    this.temperature = options.temperature ?? 0.2;
    this.maxTokens = options.maxTokens ?? 8192;
    this.timeout = options.timeout ?? 180;
    this.provider = options.provider ?? 'openai';
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  async complete(messages: Record<string, any>[], options: CompleteOptions = {}): Promise<LLMResponse> {
    let payload: Record<string, any> = {
      model: this.model,
      messages,
      temperature: options.temperature ?? this.temperature,
      max_tokens: options.maxTokens ?? this.maxTokens,
    };
    if (options.tools?.length) {
      payload.tools = options.tools;
      payload.tool_choice = 'auto';
    }
    if (options.jsonMode) {
      payload.response_format = { type: 'json_object' };
    }

    const data = await this.post(payload);
    const choices = Array.isArray(data.choices) ? (data.choices as any[]) : [];
    const message = choices[0]?.message ?? {};
    const text = contentAsText(message.content);
    const toolCalls: ToolCall[] = [];
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      const fn = call.function ?? {};
      const rawArgs = fn.arguments ?? '{}';
      let args: unknown = {};
      try {
        args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
      } catch {
        args = {};
      }
      toolCalls.push({
        id: String(call.id ?? `call_${toolCalls.length}`),
        name: String(fn.name ?? ''),
        arguments:
          typeof args === 'object' && args !== null && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {},
      });
    }
    const usage = data.usage ?? {};
    return response({
      text,
      toolCalls,
      promptTokens: Number(usage.prompt_tokens ?? 0),
      completionTokens: Number(usage.completion_tokens ?? 0),
      raw: data,
    });
  }

  private async post(initialPayload: Record<string, any>): Promise<Record<string, any>> {
    const url = `${this.baseUrl}/chat/completions`;
    let payload = initialPayload;
    let lastError = '';

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let httpResponse: Response;
      try {
        httpResponse = await fetch(url, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.timeout * 1000),
        });
      } catch (error) {
        lastError = `network error: ${error instanceof Error ? error.message : String(error)}`;
        if (attempt < 2) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        throw new LLMError(`Could not reach ${url}: ${lastError}`);
      }

      const body = await httpResponse.text();
      if (httpResponse.status < 400) {
        try {
          return JSON.parse(body) as Record<string, any>;
        } catch (error) {
          throw new LLMError(
            `Model returned invalid JSON (${this.provider}/${this.model}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      lastError = `HTTP ${httpResponse.status}: ${body.slice(0, 1500)}`;

      // Some newer OpenAI models renamed max_tokens / reject temperature.
      if (httpResponse.status === 400 && body.includes('max_tokens') && body.includes('max_completion_tokens')) {
        const next = { ...payload };
        next.max_completion_tokens = next.max_tokens ?? this.maxTokens;
        delete next.max_tokens;
        payload = next;
        continue;
      }
      if (httpResponse.status === 400 && body.includes('temperature') && body.toLowerCase().includes('unsupported')) {
        const next = { ...payload };
        delete next.temperature;
        payload = next;
        continue;
      }
      if (httpResponse.status === 400 && body.includes('response_format')) {
        const next = { ...payload };
        delete next.response_format;
        payload = next;
        continue;
      }
      if ([408, 409, 429, 500, 502, 503, 504].includes(httpResponse.status) && attempt < 2) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw new LLMError(`Model request failed (${this.provider}/${this.model}): ${lastError}`);
    }

    throw new LLMError(`Model request failed (${this.provider}/${this.model}): ${lastError}`);
  }
}
