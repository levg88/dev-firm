import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { agentFromDefinition } from '../src/agents/base';
import {
  getAgentDefinition,
  loadAgentDefinitions,
  parseAgentMarkdown,
  renderAgentTask,
  renderTaskTemplate,
} from '../src/agents/definitions';
import { schemaForAgent } from '../src/agents/schema';
import { productSpecSchema } from '../src/models';
import { makeSettings } from './helpers';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dev-firm-agents-'));
}

const OVERRIDE = `---
id: product_manager
name: Custom PM
role: product_manager
description: A user override.
schema: product_spec
workflow: build
temperature: 0.7
max_tokens: 512
---

# System Prompt

You are a custom product manager.

# Task

Plan {{brief}} for {{audience}}.
`;

describe('markdown agent definitions', () => {
  it('loads the bundled firm agents from agents/*.md', () => {
    const definitions = loadAgentDefinitions();
    expect(definitions.map((definition) => definition.id).sort()).toEqual([
      'architect',
      'backend_developer',
      'devops',
      'fixer',
      'frontend_developer',
      'product_manager',
      'qa',
      'team_lead',
      'team_lead_triage',
      'tech_lead',
    ]);

    const pm = getAgentDefinition('product_manager');
    expect(pm.name).toBe('Product Manager');
    expect(pm.schema).toBe('product_spec');
    expect(pm.workflow).toBe('build');
    expect(pm.temperature).toBe(0.3);
    expect(pm.maxTokens).toBeNull();
    expect(pm.systemPrompt).toContain('senior product manager');
    expect(pm.taskTemplate).toContain('{{brief}}');
  });

  it('resolves named output schemas and treats none as free text', () => {
    const pm = getAgentDefinition('product_manager');
    expect(schemaForAgent(pm)).toBe(productSpecSchema);
    expect(schemaForAgent(getAgentDefinition('devops'))).toBeUndefined();
  });

  it('renders task placeholders, including JSON values', () => {
    const rendered = renderTaskTemplate('Job: {{ job }}. Data: {{data}}. Missing: {{x}}', {
      job: 'VP Engineering',
      data: { score: 80 },
    });
    expect(rendered).toContain('Job: VP Engineering.');
    expect(rendered).toContain('"score": 80');
    expect(rendered).toContain('{{x}}');
  });

  it('lets a home override replace a bundled definition', () => {
    const directory = tempDir();
    try {
      fs.writeFileSync(path.join(directory, 'product-manager.md'), OVERRIDE);
      const definitions = loadAgentDefinitions({ extraDirs: [directory] });
      const pm = definitions.find((definition) => definition.id === 'product_manager');
      expect(pm?.name).toBe('Custom PM');
      expect(pm?.temperature).toBe(0.7);
      expect(pm?.maxTokens).toBe(512);
      expect(pm?.systemPrompt).toBe('You are a custom product manager.');
      expect(pm?.sourcePath).toBe(path.join(directory, 'product-manager.md'));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('builds an agent from a definition', () => {
    const settings = makeSettings();
    const definition = getAgentDefinition('qa');
    const agent = agentFromDefinition(definition, { complete: async () => null } as never, settings);
    expect(agent.spec.name).toBe('qa');
    expect(agent.spec.role).toBe('qa');
    expect(agent.spec.temperature).toBe(0.1);
    expect(agent.spec.systemPrompt).toContain('rigorous QA engineer');
  });

  it('rejects a definition without a system prompt', () => {
    expect(() =>
      parseAgentMarkdown('---\nid: broken\n---\n\n# Task\nDo {{thing}}.', 'broken.md'),
    ).toThrow(/missing a system prompt/);
  });

  it('rejects an unknown output schema', () => {
    expect(() =>
      parseAgentMarkdown(
        '---\nid: broken\nschema: nonsense\n---\n\n# System Prompt\nHi.',
        'broken.md',
      ),
    ).toThrow(/unknown schema/);
  });

  it('fails clearly when a task section is missing', () => {
    const definition = parseAgentMarkdown(
      '---\nid: no_task\n---\n\n# System Prompt\nHi.',
      'no_task.md',
    );
    expect(() => renderAgentTask(definition, {})).toThrow(/missing a "# Task" section/);
  });
});
