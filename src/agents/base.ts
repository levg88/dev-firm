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
    if (c === '\\') {
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
        result += '\\n';
        continue;
      }
      if (c === '\r') {
        result += '\\r';
        continue;
      }
      if (c === '\t') {
        result += '\\t';
        continue;
      }
    }
    result += c;
  }
  return result;
}

const KNOWN_TOOLS = new Set(['write_file', 'read_file', 'list_files', 'run_command']);

function parseLooseJson(text: string): unknown {
  const candidates = [
    text,
    repairJsonStrings(text),
    text.replace(/,\s*([}\]])/g, '$1'),
    repairJsonStrings(text).replace(/,\s*([}\]])/g, '$1'),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next repair.
    }
  }
  return undefined;
}

function findMatchingParen(text: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = openIndex; i < text.length; i++) {
    const c = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === '\\') {
      escaped = true;
      continue;
    }
    if (inString) {
      if (c === quote) inString = false;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = true;
      quote = c;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function firstTopLevelArgument(inner: string): string {
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === '\\') {
      escaped = true;
      continue;
    }
    if (inString) {
      if (c === quote) inString = false;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = true;
      quote = c;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ',' && depth === 0) return inner.slice(0, i);
  }
  return inner;
}

/**
 * Local models often write `"content": JSON.stringify({...}, null, 2)` inside a
 * text tool call. That is JavaScript, not JSON. Turn each call into the JSON
 * string it would have produced so the arguments parse.
 */
function replaceStringifyCalls(text: string): string {
  const marker = 'JSON.stringify';
  let out = '';
  let index = 0;
  while (true) {
    const found = text.indexOf(marker, index);
    if (found === -1) {
      out += text.slice(index);
      break;
    }
    out += text.slice(index, found);
    let open = found + marker.length;
    while (open < text.length && /\s/.test(text[open])) open++;
    if (text[open] !== '(') {
      out += marker;
      index = found + marker.length;
      continue;
    }
    const close = findMatchingParen(text, open);
    if (close === -1) {
      out += text.slice(found);
      break;
    }
    const inner = text.slice(open + 1, close);
    const first = firstTopLevelArgument(inner).trim();
    const parsed = parseLooseJson(first);
    if (parsed === undefined) {
      out += text.slice(found, close + 1);
    } else {
      out += JSON.stringify(JSON.stringify(parsed));
    }
    index = close + 1;
  }
  return out;
}

/** Extract every top-level JSON object, ignoring braces inside strings. */
function scanTopLevelObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === '\\') {
      escaped = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

interface CollectedTextCalls {
  calls: ToolCall[];
  failures: string[];
}

/** Some weaker models emit tool calls as text instead of using the function-calling API. */
function collectTextToolCalls(text: string): CollectedTextCalls {
  const calls: ToolCall[] = [];
  const failures: string[] = [];
  const seen = new Set<string>();
  for (const objectText of scanTopLevelObjects(text)) {
    const parsed = parseLooseJson(objectText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      if (/["'](?:name|function|arguments|parameters)["']/.test(objectText)) {
        failures.push(objectText);
      }
      continue;
    }
    const record = parsed as Record<string, unknown>;
    const candidate =
      record.function && typeof record.function === 'object' && !Array.isArray(record.function)
        ? (record.function as Record<string, unknown>)
        : record;
    const name = typeof candidate.name === 'string' ? candidate.name : '';
    if (!KNOWN_TOOLS.has(name)) continue;
    let args = candidate.arguments ?? candidate.parameters ?? {};
    if (typeof args === 'string') {
      const inner = parseLooseJson(args);
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) args = inner;
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
    const key = `${name}:${JSON.stringify(args)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push({
      id: `text_${Date.now()}_${calls.length}`,
      name,
      arguments: args as Record<string, unknown>,
    });
  }
  return { calls, failures };
}

function extractTextToolCalls(text: string): ToolCall[] {
  // Parse the text as-is first. Only repair failed objects with
  // `JSON.stringify(...)`: the repair rewrites text and must not touch valid
  // JSON content that happens to contain JSON.stringify inside a string.
  const direct = collectTextToolCalls(text);
  if (!direct.failures.length) return direct.calls;
  const repaired = collectTextToolCalls(direct.failures.map(replaceStringifyCalls).join('\n'));
  const merged = [...direct.calls];
  const seen = new Set(merged.map((call) => `${call.name}:${JSON.stringify(call.arguments)}`));
  for (const call of repaired.calls) {
    const key = `${call.name}:${JSON.stringify(call.arguments)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(call);
  }
  return merged;
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
    const debug = process.env.DEV_FIRM_DEBUG === '1';

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

      if (debug) {
        const names = llmResponse.toolCalls.map((call) => call.name).join(',') || 'none';
        process.stderr.write(
          `[${this.spec.name}] step ${step}/${limit} tools=${names} text=${llmResponse.text.length}\n`,
        );
      }

      // Some weaker local models emit tool calls as text instead of using the
      // function-calling API. Detect and recover those so the run can proceed.
      if (llmResponse.toolCalls.length === 0 && toolSchemas.length > 0) {
        const extractedCalls = extractTextToolCalls(llmResponse.text);
        if (extractedCalls.length) {
          llmResponse.toolCalls.push(...extractedCalls);
          if (debug) {
            for (const extracted of extractedCalls) {
              process.stderr.write(
                `[${this.spec.name}] recovered text call ${extracted.name} ${JSON.stringify(
                  extracted.arguments,
                ).slice(0, 300)}\n`,
              );
            }
            process.stderr.write(
              `[${this.spec.name}] raw text ${llmResponse.text.slice(0, 1200).replace(/\n/g, '\\n')}\n`,
            );
          }
        } else if (debug) {
          process.stderr.write(
            `[${this.spec.name}] no tool call; text ${llmResponse.text
              .slice(0, 800)
              .replace(/\n/g, '\\n')}\n`,
          );
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
          if (debug) {
            process.stderr.write(
              `[${this.spec.name}] ${call.name} ${JSON.stringify(call.arguments).slice(0, 400)}\n`,
            );
          }
          const result = await this.tools.execute(call.name, call.arguments);
          if (debug) {
            process.stderr.write(
              `[${this.spec.name}] -> ${String(result).slice(0, 300).replace(/\n/g, ' ')}\n`,
            );
          }
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
