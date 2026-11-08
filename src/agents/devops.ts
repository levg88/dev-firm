/**
 * @fileoverview DevOps agent wrapper.
 *
 * Builds the task prompt for the DevOps engineer (CI/CD, GitOps, deployment)
 * and runs it with sandbox tools, gated on QA having passed. The identity,
 * prompt, and task template come from `agents/devops.md`.
 */

import { Settings } from '../config';
import { LLMClient } from '../llm/base';
import { AgentResult, agentFromDefinition } from './base';
import { ProductSpec } from './build_schemas';
import { getAgentDefinition, renderAgentTask, type AgentDefinition } from './definitions';
import { runAgent } from './runner';
import { schemaForAgent } from './schema';
import { makeTools, Sandbox } from './tools';

export type DevOpsRole = 'devops';

export interface DevOpsTicket {
  key: string;
  task: {
    title: string;
    description: string;
    area: string;
    acceptance_criteria: string[];
  };
}

export interface DevOpsRunOptions {
  feedback?: string;
  workflowRunId?: number | null;
  iteration?: number;
  tickets?: DevOpsTicket[];
  qaPassed?: boolean;
  qaReport?: Record<string, any>;
}

/** DevOps role agent: manages pipeline and deployment of verified builds. */
export class DevOps {
  readonly role: DevOpsRole;
  readonly name: string;
  readonly definition: AgentDefinition;

  constructor(
    private settings: Settings,
    private llm: LLMClient,
    role: DevOpsRole = 'devops',
    name: string = 'DevOps Engineer',
  ) {
    this.role = role;
    this.name = name;
    this.definition = getAgentDefinition(role, { extraDirs: [settings.agentsDir] });
  }

  async run(
    spec: ProductSpec,
    sandbox: Sandbox,
    options: DevOpsRunOptions = {},
  ): Promise<AgentResult> {
    const assigned = (options.tickets ?? [])
      .map(
        (entry) =>
          `- [${entry.key}] ${entry.task.title} (area: ${entry.task.area})\n` +
          `  ${entry.task.description}\n` +
          `  Acceptance: ${entry.task.acceptance_criteria.join('; ') || 'see product spec'}`,
      )
      .join('\n');

    const qaStatus = options.qaPassed
      ? 'PASSED — deployment is authorized.'
      : 'NOT PASSED — deployment is BLOCKED. Do not deploy until QA signs off.';

    const feedbackSection = options.feedback?.trim()
      ? `\n## FEEDBACK TO FIX\n${options.feedback.trim()}`
      : '';
    const iterationNote =
      options.iteration && options.iteration > 1
        ? `\nThis is deployment iteration ${options.iteration}. Fix the feedback and re-deploy.`
        : '';

    const task = renderAgentTask(this.definition, {
      qa_status: qaStatus,
      spec: spec.markdown,
      assigned: assigned || '(manage pipeline and deployment for this build)',
      node_version: process.version.replace(/^v/, ''),
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
