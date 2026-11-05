export class LLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMError';
  }
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMResponse {
  text: string;
  toolCalls: ToolCall[];
  promptTokens: number;
  completionTokens: number;
  raw: Record<string, unknown>;
}

export interface CompleteOptions {
  tools?: Record<string, unknown>[];
  temperature?: number | null;
  maxTokens?: number | null;
  jsonMode?: boolean;
}

export abstract class LLMClient {
  abstract provider: string;
  abstract model: string;
  abstract complete(messages: Record<string, any>[], options?: CompleteOptions): Promise<LLMResponse>;
}

export function response(values: Partial<LLMResponse> = {}): LLMResponse {
  return {
    text: values.text ?? '',
    toolCalls: values.toolCalls ?? [],
    promptTokens: values.promptTokens ?? 0,
    completionTokens: values.completionTokens ?? 0,
    raw: values.raw ?? {},
  };
}

const FENCE_RE = /^\s*```(?:json|JSON)?\s*|\s*```\s*$/gm;

export function parseJsonObject(text: string): Record<string, any> {
  if (!text || !text.trim()) {
    throw new LLMError('The model returned an empty response where JSON was required.');
  }

  const cleaned = text.replace(FENCE_RE, '').trim();
  const candidates = [cleaned];
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) {
    candidates.push(cleaned.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value;
      }
    } catch {
      // Try the trailing-comma-repaired variant below.
    }
    const fixed = candidate.replace(/,\s*([}\]])/g, '$1');
    try {
      const value = JSON.parse(fixed);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value;
      }
    } catch {
      // Keep looking.
    }
  }

  const snippet = cleaned.slice(0, 500).replace(/\n/g, ' ');
  throw new LLMError(`Could not parse JSON from model response: ${snippet}`);
}

export function contentAsText(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
      } else if (
        typeof block === 'object' &&
        block !== null &&
        ['text', 'output_text'].includes(String((block as Record<string, unknown>).type))
      ) {
        parts.push(String((block as Record<string, unknown>).text ?? ''));
      }
    }
    return parts.join('');
  }
  return String(content);
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
