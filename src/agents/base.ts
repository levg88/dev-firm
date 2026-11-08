/**
 * @fileoverview Provider-agnostic tool-calling agent runtime.
 *
 * This module is the heart of the firm's agent layer. It defines the `Agent`
 * class that drives a multi-step LLM conversation, dispatches tool calls to a
 * `ToolRegistry`, recovers tool calls that weaker local models emit as plain
 * text, repairs malformed JSON arguments, and (optionally) coerces the final
 * answer into a validated JSON object matching a Zod schema.
 *
 * It also contains the text-tool-call recovery helpers (`extractTextToolCalls`,
 * `repairJsonStrings`, etc.) used to keep small/local models productive even
 * when they do not use the function-calling API.
 */

import type { ZodType } from 'zod';
import { toJSONSchema } from 'zod';

import { Settings } from '../config';
import * as db from '../db';
import {
  LLMClient,
  LLMError,
  LLMResponse,
  ToolCall,
  parseJsonObject,
  response,
  sleep,
} from '../llm/base';
import { saveAgentStep, listAgentSteps } from '../db';
import type { AgentDefinition } from './definitions';

/**
 * Error thrown when an agent run fails unrecoverably (LLM error, invalid JSON
 * after retries, or exceeding the step limit).
 */
export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentError';
  }
}

/**
 * A single tool exposed to an agent. The `parameters` field is a JSON Schema
 * describing the tool's arguments; `handler` performs the work and returns a
 * value that is serialized back to the model.
 */
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, any>) => unknown;
}

/**
 * Wrap a {@link Tool} in the OpenAI-style function schema the LLM API expects.
 */
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

/**
 * Registry of tools available to an agent. Holds the tool definitions, exposes
 * their JSON schemas to the LLM, and dispatches calls by name with argument
 * validation and error handling.
 */
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

/**
 * Static description of an agent role: its identity, system prompt, and
 * sampling parameters. One `AgentSpec` is created per agent instance.
 */
export interface AgentSpec {
  name: string;
  role: string;
  systemPrompt: string;
  temperature?: number;
  maxTokens?: number | null;
}

/**
 * Result of a completed agent run: the final text, any parsed JSON payload,
 * step count, token usage, and the last raw LLM response.
 */
export interface AgentResult {
  text: string;
  data: Record<string, any> | null;
  steps: number;
  promptTokens: number;
  completionTokens: number;
  response: LLMResponse | null;
}

/**
 * Escape raw newlines, carriage returns and tabs that appear *inside* JSON
 * string literals so the value becomes valid JSON. Models often emit pretty
 * multi-line strings without escaping them.
 */
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

/**
 * Try several increasingly lenient repairs to parse `text` as JSON. Returns
 * `undefined` if every attempt fails.
 */
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

/**
 * Find the index of the closing parenthesis matching the one at `openIndex`,
 * accounting for strings and nesting. Returns -1 if no match exists.
 */
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

/**
 * Return the first top-level argument of a comma-separated argument list,
 * respecting string literals and nested braces/brackets/parens.
 */
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

/**
 * Some models wrap file content in a JavaScript template literal instead of a
 * JSON string. Convert an unquoted `...` block to a JSON string literal.
 */
function replaceTemplateLiterals(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const quote = c;
      out += c;
      i++;
      while (i < text.length) {
        const d = text[i];
        out += d;
        i++;
        if (d === '\\') {
          if (i < text.length) {
            out += text[i];
            i++;
          }
          continue;
        }
        if (d === quote) break;
      }
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let inner = '';
      let close = -1;
      while (j < text.length) {
        const d = text[j];
        if (d === '\\') {
          inner += d;
          j++;
          if (j < text.length) {
            inner += text[j];
            j++;
          }
          continue;
        }
        if (d === '`') {
          let k = j + 1;
          while (k < text.length && /\s/.test(text[k])) k++;
          const next = k >= text.length ? '' : text[k];
          if (!next || next === ',' || next === '}' || next === ']') {
            close = j;
            break;
          }
        }
        inner += d;
        j++;
      }
      if (close !== -1) {
        out += JSON.stringify(inner);
        i = close + 1;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** Extract every top-level JSON object from `text`, ignoring braces inside strings. */
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
  // Parse the text as-is first. Only repair failed objects: the repairs rewrite
  // text and must not touch valid JSON content that happens to contain
  // JSON.stringify or backticks inside a string.
  const direct = collectTextToolCalls(text);
  if (!direct.failures.length) return direct.calls;
  const merged = [...direct.calls];
  const seen = new Set(merged.map((call) => `${call.name}:${JSON.stringify(call.arguments)}`));
  for (const failure of direct.failures) {
    const variants = [
      replaceTemplateLiterals(failure),
      replaceStringifyCalls(failure),
      replaceStringifyCalls(replaceTemplateLiterals(failure)),
    ];
    for (const variant of variants) {
      for (const call of collectTextToolCalls(variant).calls) {
        const key = `${call.name}:${JSON.stringify(call.arguments)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(call);
      }
    }
  }
  return merged;
}

/**
 * Render a Zod schema as a pretty-printed JSON Schema string for inclusion in
 * the system prompt. Falls back to `{}` if conversion fails.
 */
function schemaJson(schema: ZodType): string {
  try {
    return JSON.stringify(toJSONSchema(schema, { io: 'input' }), null, 2);
  } catch {
    return '{}';
  }
}

/**
 * A small provider-agnostic tool-calling agent.
 *
 * Drives a multi-turn conversation with an LLM: sends the system/user
 * messages, executes any tool calls the model requests through the registry,
 * feeds results back, and repeats until the model produces a final answer or
 * the step limit is reached. Optionally validates the final answer against a
 * Zod schema with a couple of retry nudges.
 */
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

  /**
   * Run the agent on `task`.
   *
   * @param task - The user-facing instruction for this run.
   * @param options.context - Extra context appended to the user message.
   * @param options.schema - When set, the final answer must be valid JSON
   *   conforming to this Zod schema; the agent retries up to 2 times.
   * @param options.maxSteps - Override the configured step limit.
   * @param options.agentRunId - DB id for persisting per-step audit rows.
   * @returns The final text, parsed data (if a schema was given), step count,
   *   token usage, and the last LLM response.
   */
  async run(
    task: string,
    options: { context?: string; schema?: ZodType; maxSteps?: number; agentRunId?: number } = {},
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
    const agentRunId = options.agentRunId;

    const saveStep = async (
      stepNumber: number,
      role: string,
      toolCallId?: string | null,
      toolName?: string | null,
      toolArguments?: string | null,
      toolResult?: string | null,
      llmText?: string | null,
      promptTokens = 0,
      completionTokens = 0,
    ): Promise<void> => {
      if (!agentRunId) return;
      try {
        db.withSession(this.settings.dbPath, (conn) =>
          db.saveAgentStep(
            conn,
            agentRunId,
            stepNumber,
            role,
            toolCallId ?? undefined,
            toolName ?? undefined,
            toolArguments ?? undefined,
            toolResult ?? undefined,
            llmText ?? undefined,
            promptTokens,
            completionTokens,
          ),
        );
      } catch {
        // Step logging must never break the agent run.
      }
    };

    // Main tool-calling loop: one LLM round-trip per step, executing any tool
    // calls the model requests and feeding results back into the conversation.
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

      await saveStep(
        step,
        'assistant',
        undefined,
        undefined,
        undefined,
        undefined,
        llmResponse.text || null,
        llmResponse.promptTokens,
        llmResponse.completionTokens,
      );

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
          await saveStep(
            step,
            'tool',
            call.id,
            call.name,
            JSON.stringify(call.arguments),
            undefined,
            undefined,
            0,
            0,
          );
          const result = await this.tools.execute(call.name, call.arguments);
          if (debug) {
            process.stderr.write(
              `[${this.spec.name}] -> ${String(result).slice(0, 300).replace(/\n/g, ' ')}\n`,
            );
          }
          await saveStep(
            step,
            'tool',
            call.id,
            call.name,
            undefined,
            String(result),
            undefined,
            0,
            0,
          );
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

/**
 * Build an {@link Agent} from a markdown agent definition.
 *
 * The definition supplies the identity, system prompt, and sampling
 * parameters; the caller supplies the LLM client, settings, and any tools.
 */
export function agentFromDefinition(
  definition: AgentDefinition,
  llm: LLMClient,
  settings: Settings,
  tools?: ToolRegistry,
): Agent {
  return new Agent(
    {
      name: definition.id,
      role: definition.role,
      systemPrompt: definition.systemPrompt,
      temperature: definition.temperature,
      maxTokens: definition.maxTokens,
    },
    llm,
    settings,
    tools,
  );
}
