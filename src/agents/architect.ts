/**
 * @fileoverview Architect agent wrapper.
 *
 * Turns a product spec into an implementable architecture document (stack,
 * file plan, data model, API, test plan, risks) via the LLM, validated against
 * `architectureSchema`.
 */

import { Settings } from '../config';
import { LLMClient } from '../llm/base';
import { Agent, AgentResult } from './base';
import { Architecture, ProductSpec, architectureSchema } from './build_schemas';
import { ARCHITECT } from './prompts';
import { runAgent } from './runner';

/** Architect role agent: designs the system architecture from a product spec. */
export class Architect {
  readonly role = 'architect';

  constructor(private settings: Settings, private llm: LLMClient) {}

  async run(
    spec: ProductSpec,
    options: { workflowRunId?: number | null; feedback?: string; round?: number } = {},
  ): Promise<AgentResult> {
    const agent = new Agent(
      {
        name: 'architect',
        role: 'architect',
        systemPrompt: ARCHITECT,
        temperature: 0.2,
      },
      this.llm,
      this.settings,
    );
    const task =
      `Design the smallest implementable architecture for this product spec (round ${options.round ?? 1}).\n\n` +
      `## SPEC\n${spec.markdown}\n\n` +
      `## ACCEPTANCE CRITERIA\n` +
      spec.acceptance_criteria.map((item: string) => `- ${item}`).join('\n') +
      `\n\n## TASKS\n` +
      spec.tasks
        .map(
          (task, index) =>
            `${index + 1}. ${task.title} (area: ${task.area})\n   ${task.description}\n   Acceptance: ${task.acceptance_criteria.join('; ')}`,
        )
        .join('\n') +
      (options.feedback ? `\n\n## TEAM LEAD FEEDBACK TO ADDRESS\n${options.feedback}` : '');
    return runAgent(this.settings, agent, {
      workflow: 'build',
      role: 'architect',
      task,
      schema: architectureSchema,
      workflowRunId: options.workflowRunId ?? null,
    });
  }
}
