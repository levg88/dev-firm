import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { agentFromDefinition } from '../src/agents/base';
import {
  getAgentDefinition,
  parseAgentMarkdown,
} from '../src/agents/definitions';
import {
  getSkill,
  loadSkills,
  parseSkillMarkdown,
  resolveAgentSkills,
  systemPromptFor,
} from '../src/agents/skills';
import { makeSettings } from './helpers';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dev-firm-skills-'));
}

const OVERRIDE = `---
id: acceptance-criteria
name: Team Acceptance Criteria
agents: "*"
---

Custom acceptance rule for this installation.
`;

describe('shared skills', () => {
  it('loads the bundled skills from skills/*/SKILL.md', () => {
    const skills = loadSkills();
    expect(skills.map((skill) => skill.id).sort()).toEqual([
      'acceptance-criteria',
      'clarifying-questions',
      'design-review',
      'error-reporting',
      'knowledge-capture',
      'quality-gates',
      'ticket-handoff',
      'typescript-runtime',
    ]);
    expect(getSkill('acceptance-criteria').name).toBe('Acceptance Criteria Discipline');
  });

  it('targets only the agents declared by the skill', () => {
    const pm = getAgentDefinition('product_manager');
    const qa = getAgentDefinition('qa');
    const dev = getAgentDefinition('backend_developer');

    expect(resolveAgentSkills(pm).map((skill) => skill.id)).toContain(
      'clarifying-questions',
    );
    expect(resolveAgentSkills(qa).map((skill) => skill.id)).not.toContain(
      'clarifying-questions',
    );
    expect(resolveAgentSkills(qa).map((skill) => skill.id)).toContain('quality-gates');
    expect(resolveAgentSkills(dev).map((skill) => skill.id)).toContain(
      'typescript-runtime',
    );
  });

  it('lets an agent opt into an extra skill through frontmatter', () => {
    const definition = parseAgentMarkdown(
      '---\nid: custom_agent\nskills: design-review, quality-gates\n---\n\n# System Prompt\nYou are custom.',
      'custom.md',
    );
    expect(definition.skills).toEqual(['design-review', 'quality-gates']);
    expect(resolveAgentSkills(definition).map((skill) => skill.id)).toEqual(
      expect.arrayContaining(['design-review', 'quality-gates']),
    );
  });

  it('injects resolved skills into the effective system prompt', () => {
    const pm = getAgentDefinition('product_manager');
    const prompt = systemPromptFor(pm, { dirs: [path.resolve('skills')] });
    expect(prompt).toContain('senior product manager');
    expect(prompt).toContain('## SHARED SKILLS');
    expect(prompt).toContain('Skill: Acceptance Criteria Discipline');
    expect(prompt).not.toContain('Skill: Quality Gates');
  });

  it('lets a home override replace a bundled skill by id', () => {
    const directory = tempDir();
    try {
      fs.mkdirSync(path.join(directory, 'acceptance-criteria'));
      fs.writeFileSync(
        path.join(directory, 'acceptance-criteria', 'SKILL.md'),
        OVERRIDE,
      );
      const skills = loadSkills({ dirs: [path.resolve('skills'), directory] });
      const override = skills.find((skill) => skill.id === 'acceptance-criteria');
      expect(override?.name).toBe('Team Acceptance Criteria');
      expect(override?.body).toContain('Custom acceptance rule');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('builds an agent whose prompt includes the shared skills', () => {
    const settings = makeSettings();
    const definition = getAgentDefinition('qa');
    const agent = agentFromDefinition(
      definition,
      { complete: async () => null } as never,
      settings,
    );
    expect(agent.spec.systemPrompt).toContain('rigorous QA engineer');
    expect(agent.spec.systemPrompt).toContain('Skill: Quality Gates');
  });

  it('rejects a skill without an instruction body', () => {
    expect(() =>
      parseSkillMarkdown('---\nid: broken\nagents: "*"\n---\n', 'broken/SKILL.md'),
    ).toThrow(/missing its instruction body/);
  });
});
