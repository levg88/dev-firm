import type { ZodType } from 'zod';
import { toJSONSchema } from 'zod';

import { Settings } from '../config';
import { LLMClient, LLMError, LLMResponse, ToolCall, parseJsonObject, response, sleep } from '../llm/base';

export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentError';
  }
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, any>) => unknown;
}

export function toolSchema(tool: Tool): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor(tools: Tool[] = []) {
    for (const tool of tools) this.add(tool);
  }

  add(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  schemas(): Record<string, unknown>[] {
    return [...this.tools.values()].map(toolSchema);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return JSON.stringify({ ok: false, error: `Unknown tool: ${name}` });
    }
    try {
      const result = await tool.handler(args);
      if (typeof result === 'string') return result.slice(0, 120000);
      return JSON.stringify(result ?? null).slice(0, 120000);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return JSON.stringify({ ok: false, error: `${err.constructor.name}: ${err.message}` }).slice(0, 120000);
    }
  }
}

export interface AgentSpec {
  name: string;
  role: string;
  systemPrompt: string;
  temperature?: number;
  maxTokens?: number | null;
}

export interface AgentResult {
  text: string;
  data: Record<string, any> | null;
  steps: number;
  promptTokens: number;
  completionTokens: number;
  response: LLMResponse | null;
}

function extractBracedObject(text: string, startIndex: number): string | null {
  let i = text.indexOf('{', startIndex);
  if (i === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === '\\\\') {
      escaped = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(i, j + 1);
    }
  }
  return null;
}

function repairJsonStrings(s: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) {
      result += c;
      escaped = false;
      continue;
    }
    if (c === '\\\\') {
      result += c;
      escaped = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      result += c;
      continue;
    }
    if (inString) {
      if (c === '\n') {
        result += '\\\\n';
        continue;
      }
      if (c === '\r') {
        result += '\\\\r';
        continue;
      }
      if (c === '\t') {
        result += '\\\\t';
        continue;
      }
    }
    result += c;
  }
  return result;
}

const KNOWN_TOOLS = new Set(['write_file', 'read_file', 'list_files', 'run_command']);

/** Some weaker models emit tool calls as text instead of using the function-calling API. */
function extractTextToolCall(text: string): ToolCall | null {
  const nameMatch = text.match(/"name"\s*:\s*"([a-zA-Z_][a-zA-Z0-9_]*)"/);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  if (!KNOWN_TOOLS.has(name)) return null;

  // Find args under "parameters" or "arguments".
  let args: Record<string, unknown> = {};
  const keyMatch = text.match(/"(?:parameters|arguments)"\s*:/);
  if (keyMatch && keyMatch.index !== undefined) {
    const obj = extractBracedObject(text, keyMatch.index + keyMatch[0].length);
    if (obj) {
      try {
        const parsed = JSON.parse(obj);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        try {
          const parsed = JSON.parse(repairJsonStrings(obj));
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>;
          }
        } catch {
          // Give up on args; the tool will report the missing fields.
        }
      }
    }
  }
  return { id: `text_${Date.now()}`, name, arguments: args };
}

function schemaJson(schema: ZodType): string {
  try {
    return JSON.stringify(toJSONSchema(schema, { io: 'input' }), null, 2);
  } catch {
    return '{}';
  }
}

/** A small provider-agnostic tool-calling agent. */
export class Agent {
  spec: AgentSpec;
  llm: LLMClient;
  settings: Settings;
  tools: ToolRegistry;

  constructor(spec: AgentSpec, llm: LLMClient, settings: Settings, tools?: ToolRegistry) {
    this.spec = spec;
    this.llm = llm;
    this.settings = settings;
    this.tools = tools ?? new ToolRegistry();
  }

  async run(
    task: string,
    options: { context?: string; schema?: ZodType; maxSteps?: number } = {},
  ): Promise<AgentResult> {
    let system = this.spec.systemPrompt.trim();
    if (options.schema) {
      system +=
        '\n\nOUTPUT JSON\n' +
        'Return only one valid JSON object, with no prose before or after it. ' +
        'It must conform to this JSON Schema:\n' +
        schemaJson(options.schema);
    }

    let user = task.trim();
    if (options.context?.trim()) {
      user += '\n\nCONTEXT\n' + options.context.trim();
    }
    const messages: Record<string, any>[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];

    const toolSchemas = this.tools.schemas();
    let promptTokens = 0;
    let completionTokens = 0;
    let jsonAttempts = 0;
    let steps = 0;
    const limit = options.maxSteps ?? this.settings.maxAgentSteps;

    for (let step = 1; step <= limit; step += 1) {
      steps = step;
      let llmResponse: LLMResponse;
      try {
        llmResponse = await this.llm.complete(messages, {
          tools: toolSchemas.length ? toolSchemas : undefined,
          temperature: this.spec.temperature ?? 0.2,
          maxTokens: this.spec.maxTokens ?? null,
          jsonMode: Boolean(options.schema && !toolSchemas.length),
        });
      } catch (error) {
        // Retry once on transient failures (e.g., token repeat limits, timeouts).
        if (step < limit) {
          await sleep(2000);
          try {
            llmResponse = await this.llm.complete(messages, {
              tools: toolSchemas.length ? toolSchemas : undefined,
              temperature: this.spec.temperature ?? 0.2,
              maxTokens: Math.min(this.spec.maxTokens ?? 2048, 2048),
              jsonMode: Boolean(options.schema && !toolSchemas.length),
            });
          } catch {
            throw new AgentError(error instanceof Error ? error.message : String(error));
          }
        } else {
          throw new AgentError(error instanceof Error ? error.message : String(error));
        }
      }
      promptTokens += llmResponse.promptTokens;
      completionTokens += llmResponse.completionTokens;

      // Some weaker local models emit tool calls as text instead of using the
      // function-calling API. Detect and recover those so the run can proceed.
      if (llmResponse.toolCalls.length === 0 && toolSchemas.length > 0) {
        const extracted = extractTextToolCall(llmResponse.text);
        if (extracted) {
          llmResponse.toolCalls.push(extracted);
        }
      }

      if (llmResponse.toolCalls.length) {
        const assistantCalls = llmResponse.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        }));
        messages.push({
          role: 'assistant',
          content: llmResponse.text || '',
          tool_calls: assistantCalls,
        });
        for (const call of llmResponse.toolCalls) {
          const result = await this.tools.execute(call.name, call.arguments);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: result,
          });
        }
        continue;
      }

      if (!options.schema) {
        return {
          text: llmResponse.text.trim(),
          data: null,
          steps,
          promptTokens,
          completionTokens,
          response: llmResponse,
        };
      }

      try {
        const data = parseJsonObject(llmResponse.text);
        return {
          text: llmResponse.text,
          data,
          steps,
          promptTokens,
          completionTokens,
          response: llmResponse,
        };
      } catch (error) {
        jsonAttempts += 1;
        if (jsonAttempts > 2) {
          throw new AgentError(error instanceof Error ? error.message : String(error));
        }
        messages.push({ role: 'assistant', content: llmResponse.text });
        messages.push({
          role: 'user',
          content:
            'That response was not valid JSON. Return ONLY the JSON object, ' +
            'with no markdown fences or commentary.',
        });
      }
    }

    throw new AgentError(`Agent '${this.spec.name}' exceeded ${limit} steps without a final answer.`);
  }
}
