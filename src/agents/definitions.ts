/**
 * @file Markdown-defined agent loader.
 *
 * Agent identity, prompt, task template, and sampling parameters live in
 * `agents/*.md` instead of TypeScript. This module discovers those files at
 * runtime so prompts can be edited without a rebuild, and lets a user override
 * any definition by dropping a same-named file in `<home>/agents`.
 *
 * File format:
 *
 * ```md
 * ---
 * id: product_manager
 * name: Product Manager
 * role: product_manager
 * description: Turns a brief into a build-ready product spec.
 * schema: product_spec
 * workflow: build
 * temperature: 0.3
 * max_tokens: null
 * ---
 *
 * # System Prompt
 * You are ...
 *
 * # Task
 * Turn this brief into a spec: {{brief}}
 * ```
 */

import fs from 'node:fs';
import path from 'node:path';

/** Output schema names understood by the agent runtime. */
export const AGENT_SCHEMA_NAMES = [
  'product_spec',
  'architecture',
  'design_review',
  'bug_triage',
  'developer_report',
  'tech_lead_review',
  'qa_report',
  'devops_report',
  'none',
] as const;
/** AgentSchemaName type. */
export type AgentSchemaName = (typeof AGENT_SCHEMA_NAMES)[number];

/** A single markdown-defined agent. */
export interface AgentDefinition {
  id: string;
  name: string;
  role: string;
  description: string;
  workflow: string;
  schema: AgentSchemaName;
  temperature: number;
  maxTokens: number | null;
  /** Shared skill ids explicitly opted into by this agent. */
  skills: string[];
  systemPrompt: string;
  taskTemplate: string;
  sourcePath: string;
}

/** Options for locating agent definitions. */
export interface LoadAgentOptions {
  /** Use exactly these directories, in order. */
  dirs?: string[];
  /** Append extra override directories to the default search path. */
  extraDirs?: string[];
}

/** The repository's bundled agent definitions (`<repo>/agents`). */
export function defaultAgentsDir(): string {
  return path.resolve(__dirname, '..', '..', 'agents');
}

/**
 * Directories searched for definitions, lowest priority first. Later
 * directories override earlier ones by agent id.
 */
export function agentSearchDirs(options: LoadAgentOptions = {}): string[] {
  if (options.dirs) return options.dirs.filter(Boolean);
  const dirs = [defaultAgentsDir()];
  for (const dir of options.extraDirs ?? []) {
    if (dir) dirs.push(dir);
  }
  return dirs;
}

/** Split YAML-ish frontmatter from the markdown body. */
export function splitFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!match) return { data: {}, body: text.trim() };

  const data: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf(':');
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim().toLowerCase();
    const value = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .replace(/^'(.*)'$/, '$1');
    if (key) data[key] = value;
  }
  return { data, body: text.slice(match[0].length).trim() };
}

/** Extract the `# System Prompt` and `# Task` sections from a body. */
function extractSections(body: string): { systemPrompt: string; taskTemplate: string } {
  const systemHeading = /^#\s+System Prompt\s*$/m;
  const taskHeading = /^#\s+Task\s*$/m;
  const systemMatch = systemHeading.exec(body);
  const taskMatch = taskHeading.exec(body);

  if (systemMatch && taskMatch) {
    if (systemMatch.index < taskMatch.index) {
      return {
        systemPrompt: body
          .slice(systemMatch.index + systemMatch[0].length, taskMatch.index)
          .trim(),
        taskTemplate: body.slice(taskMatch.index + taskMatch[0].length).trim(),
      };
    }
    return {
      systemPrompt: body.slice(systemMatch.index + systemMatch[0].length).trim(),
      taskTemplate: body
        .slice(taskMatch.index + taskMatch[0].length, systemMatch.index)
        .trim(),
    };
  }
  if (systemMatch) {
    return {
      systemPrompt: body.slice(systemMatch.index + systemMatch[0].length).trim(),
      taskTemplate: '',
    };
  }
  if (taskMatch) {
    return {
      systemPrompt: '',
      taskTemplate: body.slice(taskMatch.index + taskMatch[0].length).trim(),
    };
  }
  return { systemPrompt: body.trim(), taskTemplate: '' };
}

function slug(value: string): string {
  return value
    .replace(/\.md$/i, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function numberField(data: Record<string, string>, key: string, fallback: number): number {
  const parsed = Number.parseFloat(data[key] ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

function maxTokensField(data: Record<string, string>): number | null {
  const raw = (data.max_tokens ?? '').trim().toLowerCase();
  if (!raw || raw === 'null' || raw === 'none') return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parse a comma/whitespace-separated list of skill ids. */
function skillListField(data: Record<string, string>): string[] {
  return (data.skills ?? '')
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function schemaField(data: Record<string, string>, sourcePath: string): AgentSchemaName {
  const value = (data.schema ?? 'none').trim().toLowerCase();
  if (!(AGENT_SCHEMA_NAMES as readonly string[]).includes(value)) {
    throw new Error(
      `Agent definition ${sourcePath} has unknown schema '${value}'. ` +
        `Use one of: ${AGENT_SCHEMA_NAMES.join(', ')}.`,
    );
  }
  return value as AgentSchemaName;
}

/** Parse one markdown definition from text. */
export function parseAgentMarkdown(text: string, sourcePath = '<memory>'): AgentDefinition {
  const normalized = text.replace(/\r\n/g, '\n');
  const { data, body } = splitFrontmatter(normalized);
  const fallbackId = slug(path.basename(sourcePath));
  const id = (data.id || fallbackId).trim();
  const { systemPrompt, taskTemplate } = extractSections(body);
  if (!systemPrompt) {
    throw new Error(
      `Agent definition ${sourcePath} is missing a system prompt. ` +
        'Add a "# System Prompt" section (or plain body text).',
    );
  }

  return {
    id,
    name: (data.name || id).trim(),
    role: (data.role || id).trim(),
    description: (data.description || '').trim(),
    workflow: (data.workflow || id).trim(),
    schema: schemaField(data, sourcePath),
    temperature: numberField(data, 'temperature', 0.2),
    maxTokens: maxTokensField(data),
    skills: skillListField(data),
    systemPrompt,
    taskTemplate,
    sourcePath,
  };
}

/** Read and parse a single markdown definition file. */
export function parseAgentFile(file: string): AgentDefinition {
  return parseAgentMarkdown(fs.readFileSync(file, 'utf8'), file);
}

/**
 * Discover every agent definition in the search path. Later directories win by
 * id; duplicate ids inside one directory are treated as an error.
 */
export function loadAgentDefinitions(options: LoadAgentOptions = {}): AgentDefinition[] {
  const byId = new Map<string, AgentDefinition>();

  for (const dir of agentSearchDirs(options)) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    const files = fs
      .readdirSync(dir)
      .filter((file) => file.toLowerCase().endsWith('.md'))
      .filter((file) => file.toLowerCase() !== 'readme.md')
      .sort();

    const seenInDir = new Set<string>();
    for (const file of files) {
      const definition = parseAgentFile(path.join(dir, file));
      if (seenInDir.has(definition.id)) {
        throw new Error(`Duplicate agent id '${definition.id}' in ${dir}`);
      }
      seenInDir.add(definition.id);
      byId.set(definition.id, definition);
    }
  }

  if (!byId.size) {
    throw new Error(
      `No agent definitions found. Searched: ${agentSearchDirs(options).join(', ')}. ` +
        'Add at least one .md file with frontmatter and a "# System Prompt" section.',
    );
  }
  return [...byId.values()];
}

/** Load one agent by id, or throw a helpful error listing what exists. */
export function getAgentDefinition(
  id: string,
  options: LoadAgentOptions = {},
): AgentDefinition {
  const definitions = loadAgentDefinitions(options);
  const found = definitions.find((definition) => definition.id === id);
  if (!found) {
    throw new Error(
      `Unknown agent '${id}'. Available: ${definitions.map((definition) => definition.id).join(', ')}.`,
    );
  }
  return found;
}

/**
 * Render an agent task template. `{{name}}` placeholders are replaced with the
 * supplied values; objects and arrays are pretty-printed as JSON.
 */
export function renderTaskTemplate(
  template: string,
  variables: Record<string, unknown>,
): string {
  return template
    .replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (placeholder, key: string) => {
      if (!(key in variables)) return placeholder;
      const value = variables[key];
      if (value === null || value === undefined) return '';
      if (typeof value === 'string') return value;
      return JSON.stringify(value, null, 2);
    })
    .trim();
}

/** Render the task section of a definition, failing clearly when it is absent. */
export function renderAgentTask(
  definition: AgentDefinition,
  variables: Record<string, unknown>,
): string {
  if (!definition.taskTemplate.trim()) {
    throw new Error(
      `Agent definition '${definition.id}' (${definition.sourcePath}) is missing a "# Task" section.`,
    );
  }
  return renderTaskTemplate(definition.taskTemplate, variables);
}
