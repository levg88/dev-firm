/**
 * @fileoverview Architect agent wrapper.
 *
 * Turns a product spec into an implementable architecture document (stack,
 * file plan, data model, API, test plan, risks) via the LLM, validated against
 * `architectureSchema`. The identity, prompt, and task template come from
 * `agents/architect.md`.
 */

import { Settings } from '../config';
import { LLMClient } from '../llm/base';
import { AgentResult, agentFromDefinition } from './base';
import { ProductSpec } from './build_schemas';
import { getAgentDefinition, renderAgentTask, type AgentDefinition } from './definitions';
import { runAgent } from './runner';
import { schemaForAgent } from './schema';

/** Architect role agent: designs the system architecture from a product spec. */
export class Architect {
  readonly definition: AgentDefinition;
  readonly role: string;

  constructor(private settings: Settings, private llm: LLMClient) {
    this.definition = getAgentDefinition('architect', { extraDirs: [settings.agentsDir] });
    this.role = this.definition.role;
  }

  async run(
    spec: ProductSpec,
    options: { workflowRunId?: number | null; feedback?: string; round?: number } = {},
  ): Promise<AgentResult> {
    const acceptanceCriteria = spec.acceptance_criteria
      .map((item: string) => `- ${item}`)
      .join('\n');
    const tasks = spec.tasks
      .map(
        (task, index) =>
          `${index + 1}. ${task.title} (area: ${task.area})\n   ${task.description}\n   Acceptance: ${task.acceptance_criteria.join('; ')}`,
      )
      .join('\n');
    const feedbackSection = options.feedback
      ? `\n## TEAM LEAD FEEDBACK TO ADDRESS\n${options.feedback}`
      : '';

    const task = renderAgentTask(this.definition, {
      round: options.round ?? 1,
      spec: spec.markdown,
      acceptance_criteria: acceptanceCriteria,
      tasks,
      feedback_section: feedbackSection,
    });
    const agent = agentFromDefinition(this.definition, this.llm, this.settings);
    return runAgent(this.settings, agent, {
      workflow: this.definition.workflow,
      role: this.role,
      task,
      schema: schemaForAgent(this.definition),
      workflowRunId: options.workflowRunId ?? null,
    });
  }
}
