/**
 * @file Markdown-defined shared skills.
 *
 * Skills are small, reusable instruction modules that several agents can share
 * without duplicating prompt text. They live in `skills/<id>/SKILL.md` and are
 * discovered at runtime, so adding or editing a skill needs no rebuild.
 *
 * File format:
 *
 * ```md
 * ---
 * id: acceptance-criteria
 * name: Acceptance Criteria Discipline
 * description: How to write and verify testable acceptance criteria.
 * agents: "*"
 * ---
 *
 * Instructions...
 * ```
 *
 * `agents` is either `*` (every agent) or a comma-separated list of agent ids.
 * An agent definition can also opt into skills through its `skills:` frontmatter
 * key. The resolved skill bodies are appended to the agent's system prompt.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { AgentDefinition } from './definitions';
import { splitFrontmatter } from './definitions';

/** One parsed shared skill. */
export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  /** Agent ids the skill applies to, or `['*']` for every agent. */
  agents: string[];
  body: string;
  sourcePath: string;
}

/** Options for locating skill definitions. */
export interface LoadSkillsOptions {
  /** Use exactly these directories, in order. */
  dirs?: string[];
  /** Append extra override directories to the default search path. */
  extraDirs?: string[];
}

/** The repository's bundled skills (`<repo>/skills`). */
export function defaultSkillsDir(): string {
  return path.resolve(__dirname, '..', '..', 'skills');
}

/**
 * Directories searched for skills, lowest priority first. The bundled skills
 * are always first; `<home>/skills` and `DEV_FIRM_SKILLS_DIR` override by id.
 */
export function skillSearchDirs(options: LoadSkillsOptions = {}): string[] {
  if (options.dirs) return options.dirs.filter(Boolean);
  const dirs = [defaultSkillsDir()];
  for (const dir of options.extraDirs ?? []) {
    if (dir) dirs.push(dir);
  }
  return dirs;
}

/**
 * Skill directories for a runtime configuration: the bundled skills, the
 * user's `<home>/skills` override, and an optional `DEV_FIRM_SKILLS_DIR`.
 */
export function skillDirsForAgentDir(agentsDir: string): string[] {
  const dirs = [defaultSkillsDir(), path.join(path.dirname(agentsDir), 'skills')];
  const envDir = process.env.DEV_FIRM_SKILLS_DIR?.trim();
  if (envDir) dirs.push(path.resolve(envDir));
  return dirs;
}

function slug(value: string): string {
  return value
    .replace(/\.md$/i, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function agentList(value: string | undefined): string[] {
  return (value ?? '*')
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Parse one skill definition from Markdown text. */
export function parseSkillMarkdown(text: string, sourcePath = '<memory>'): SkillDefinition {
  const normalized = text.replace(/\r\n/g, '\n');
  const { data, body } = splitFrontmatter(normalized);
  const fallbackId = slug(path.basename(path.dirname(sourcePath)));
  const id = (data.id || fallbackId).trim();
  if (!id) {
    throw new Error(`Skill definition ${sourcePath} is missing an id.`);
  }
  if (!body.trim()) {
    throw new Error(`Skill definition ${sourcePath} is missing its instruction body.`);
  }
  return {
    id,
    name: (data.name || id).trim(),
    description: (data.description || '').trim(),
    agents: agentList(data.agents),
    body: body.trim(),
    sourcePath,
  };
}

/** Read and parse one skill file. */
export function parseSkillFile(file: string): SkillDefinition {
  return parseSkillMarkdown(fs.readFileSync(file, 'utf8'), file);
}

/**
 * Discover every skill in the search path. Later directories win by id;
 * duplicate ids inside one directory are treated as an error.
 */
export function loadSkills(options: LoadSkillsOptions = {}): SkillDefinition[] {
  const byId = new Map<string, SkillDefinition>();

  for (const dir of skillSearchDirs(options)) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    const files = fs
      .readdirSync(dir)
      .map((name) => path.join(dir, name, 'SKILL.md'))
      .filter((file) => fs.existsSync(file))
      .sort();

    const seenInDir = new Set<string>();
    for (const file of files) {
      const skill = parseSkillFile(file);
      if (seenInDir.has(skill.id)) {
        throw new Error(`Duplicate skill id '${skill.id}' in ${dir}`);
      }
      seenInDir.add(skill.id);
      byId.set(skill.id, skill);
    }
  }

  return [...byId.values()];
}

/** Load one skill by id, or throw a helpful error listing what exists. */
export function getSkill(id: string, options: LoadSkillsOptions = {}): SkillDefinition {
  const skills = loadSkills(options);
  const found = skills.find((skill) => skill.id === id);
  if (!found) {
    throw new Error(
      `Unknown skill '${id}'. Available: ${skills.map((skill) => skill.id).join(', ') || '(none)'}.`,
    );
  }
  return found;
}

/**
 * Skills that apply to an agent: either declared by the skill (`agents:`), or
 * explicitly opted into by the agent definition (`skills:`).
 */
export function resolveAgentSkills(
  definition: AgentDefinition,
  options: LoadSkillsOptions = {},
): SkillDefinition[] {
  return loadSkills(options)
    .filter(
      (skill) =>
        definition.skills.includes(skill.id) ||
        skill.agents.includes('*') ||
        skill.agents.includes(definition.id),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Render the shared-skill block appended to an agent's system prompt. */
export function renderAgentSkills(
  definition: AgentDefinition,
  options: LoadSkillsOptions = {},
): string {
  const skills = resolveAgentSkills(definition, options);
  if (!skills.length) return '';
  const sections = skills.map(
    (skill) => `### Skill: ${skill.name} (${skill.id})\n\n${skill.body}`,
  );
  return [
    '## SHARED SKILLS',
    'The following skills are part of this role. Follow them together with the role rules above.',
    ...sections,
  ].join('\n\n');
}

/** The full effective system prompt for an agent (role prompt + shared skills). */
export function systemPromptFor(
  definition: AgentDefinition,
  options: LoadSkillsOptions = {},
): string {
  return [definition.systemPrompt.trim(), renderAgentSkills(definition, options)]
    .filter(Boolean)
    .join('\n\n');
}
