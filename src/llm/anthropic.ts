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

export class AnthropicClient extends LLMClient {
  provider = 'anthropic';
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
  }) {
    super();
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.model = options.model;
    this.temperature = options.temperature ?? 0.2;
    this.maxTokens = options.maxTokens ?? 8192;
    this.timeout = options.timeout ?? 180;
  }

  private convertMessages(messages: Record<string, any>[]): [string, Record<string, any>[]] {
    const systemParts: string[] = [];
    const converted: Record<string, any>[] = [];
    let pendingToolResults: Record<string, any>[] = [];

    const flushTools = (): void => {
      if (pendingToolResults.length) {
        converted.push({ role: 'user', content: pendingToolResults });
        pendingToolResults = [];
      }
    };

    for (const msg of messages) {
      const role = msg.role;
      if (role === 'system') {
        systemParts.push(contentAsText(msg.content));
        continue;
      }
      if (role === 'tool') {
        pendingToolResults.push({
          type: 'tool_result',
          tool_use_id: msg.tool_call_id ?? '',
          content: contentAsText(msg.content),
        });
        continue;
      }

      flushTools();
      if (role === 'user') {
        converted.push({
          role: 'user',
          content: [{ type: 'text', text: contentAsText(msg.content) }],
        });
      } else if (role === 'assistant') {
        const blocks: Record<string, any>[] = [];
        const text = contentAsText(msg.content);
        if (text) blocks.push({ type: 'text', text });
        for (const call of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
          const fn = call.function ?? {};
          let args: unknown = {};
          try {
            args = JSON.parse(fn.arguments || '{}');
          } catch {
            args = {};
          }
          blocks.push({
            type: 'tool_use',
            id: call.id ?? '',
            name: fn.name ?? '',
            input: args,
          });
        }
        if (blocks.length) converted.push({ role: 'assistant', content: blocks });
      }
    }

    flushTools();
    return [systemParts.filter(Boolean).join('\n\n'), converted];
  }

  async complete(messages: Record<string, any>[], options: CompleteOptions = {}): Promise<LLMResponse> {
    const [system, converted] = this.convertMessages(messages);
    const payload: Record<string, any> = {
      model: this.model,
      messages: converted,
      max_tokens: options.maxTokens ?? this.maxTokens,
      temperature: options.temperature ?? this.temperature,
    };
    if (system) payload.system = system;
    if (options.tools?.length) {
      payload.tools = options.tools.map((tool) => {
        const fn = tool.function as Record<string, any>;
        return {
          name: fn.name,
          description: fn.description ?? '',
          input_schema: fn.parameters ?? { type: 'object' },
        };
      });
    }

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    };
    const url = `${this.baseUrl}/messages`;
    let lastError = '';

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let httpResponse: Response;
      try {
        httpResponse = await fetch(url, {
          method: 'POST',
          headers,
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
        const data = JSON.parse(body) as Record<string, any>;
        const textParts: string[] = [];
        const toolCalls: ToolCall[] = [];
        for (const block of Array.isArray(data.content) ? data.content : []) {
          if (block.type === 'text') {
            textParts.push(String(block.text ?? ''));
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: String(block.id ?? `call_${toolCalls.length}`),
              name: String(block.name ?? ''),
              arguments:
                typeof block.input === 'object' && block.input !== null
                  ? (block.input as Record<string, unknown>)
                  : {},
            });
          }
        }
        const usage = data.usage ?? {};
        return response({
          text: textParts.join(''),
          toolCalls,
          promptTokens: Number(usage.input_tokens ?? 0),
          completionTokens: Number(usage.output_tokens ?? 0),
          raw: data,
        });
      }

      lastError = `HTTP ${httpResponse.status}: ${body.slice(0, 1500)}`;
      if ([408, 409, 429, 500, 502, 503, 504].includes(httpResponse.status) && attempt < 2) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw new LLMError(`Model request failed (anthropic/${this.model}): ${lastError}`);
    }

    throw new LLMError(`Model request failed (anthropic/${this.model}): ${lastError}`);
  }
}
