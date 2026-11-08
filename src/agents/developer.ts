/**
 * @fileoverview Developer agent wrapper.
 *
 * Builds the task prompt for a backend or frontend developer (spec,
 * architecture, file plan, runtime constraints, assigned tickets, feedback) and
 * runs it through the agent runtime with sandbox file/command tools. Prompts and
 * task templates come from `agents/backend-developer.md` and
 * `agents/frontend-developer.md`.
 */

import { Settings } from '../config';
import { LLMClient } from '../llm/base';
import { AgentResult, agentFromDefinition } from './base';
import { Architecture, ProductSpec, TaskSpec } from './build_schemas';
import { getAgentDefinition, renderAgentTask, type AgentDefinition } from './definitions';
import { runAgent } from './runner';
import { schemaForAgent } from './schema';
import { makeTools, Sandbox } from './tools';

export type DeveloperRole = 'backend_developer' | 'frontend_developer';

export interface DeveloperTicket {
  key: string;
  task: TaskSpec;
}

export interface DeveloperRunOptions {
  feedback?: string;
  workflowRunId?: number | null;
  iteration?: number;
  tickets?: DeveloperTicket[];
}

/** Developer role agent: implements assigned tasks in the sandboxed workspace. */
export class Developer {
  readonly role: DeveloperRole;
  readonly name: string;
  readonly definition: AgentDefinition;

  constructor(
    private settings: Settings,
    private llm: LLMClient,
    role: DeveloperRole = 'backend_developer',
    name: string = role,
  ) {
    this.role = role;
    this.name = name;
    this.definition = getAgentDefinition(role, { extraDirs: [settings.agentsDir] });
  }

  async run(
    spec: ProductSpec,
    architecture: Architecture,
    sandbox: Sandbox,
    options: DeveloperRunOptions = {},
  ): Promise<AgentResult> {
    const isFrontend = this.role === 'frontend_developer';

    const assigned = (options.tickets ?? [])
      .map(
        (entry) =>
          `- [${entry.key}] ${entry.task.title} (area: ${entry.task.area})\n` +
          `  ${entry.task.description}\n` +
          `  Acceptance: ${entry.task.acceptance_criteria.join('; ') || 'see product spec'}`,
      )
      .join('\n');
    const testPlan = architecture.test_plan.map((item: string) => `- ${item}`).join('\n');
    const feedbackSection = options.feedback?.trim()
      ? `\n## FEEDBACK TO FIX (TECH LEAD / QA)\n${options.feedback.trim()}`
      : '';
    const iterationNote =
      options.iteration && options.iteration > 1
        ? `\nThis is iteration ${options.iteration}. Fix the feedback and re-run the tests.`
        : '';

    const task = renderAgentTask(this.definition, {
      role_label: isFrontend ? 'frontend' : 'backend',
      max_steps: this.settings.maxAgentSteps,
      spec: spec.markdown,
      architecture: architecture.markdown,
      file_plan: JSON.stringify(architecture),
      test_plan: testPlan,
      node_version: process.version.replace(/^v/, ''),
      assigned:
        assigned || '(implement the backend/frontend portion of the product spec)',
      feedback_section: feedbackSection,
      iteration_note: iterationNote,
    });

    const agent = agentFromDefinition(
      this.definition,
      this.llm,
      this.settings,
      makeTools(sandbox),
    );
    return runAgent(this.settings, agent, {
      workflow: this.definition.workflow,
      role: this.role,
      task,
      schema: schemaForAgent(this.definition),
      workflowRunId: options.workflowRunId ?? null,
    });
  }
}
