/**
 * @fileoverview QA agent wrapper.
 *
 * Builds the verification task prompt (spec, architecture, tickets, file list)
 * and runs QA with read-only sandbox tools so it can inspect and test the build
 * without modifying it. The identity, prompt, and task template come from
 * `agents/qa.md`.
 */

import { Settings } from '../config';
import { LLMClient } from '../llm/base';
import { AgentResult, agentFromDefinition } from './base';
import { Architecture, ProductSpec, TaskSpec } from './build_schemas';
import { getAgentDefinition, renderAgentTask, type AgentDefinition } from './definitions';
import { runAgent } from './runner';
import { schemaForAgent } from './schema';
import { makeTools, Sandbox } from './tools';

export interface QATicket {
  key: string;
  task: TaskSpec;
  role?: string;
}

export interface QAOptions {
  workflowRunId?: number | null;
  iteration?: number;
  tickets?: QATicket[];
  feedback?: string;
}

/** QA role agent: verifies the implementation against spec and runs tests. */
export class QA {
  readonly definition: AgentDefinition;
  readonly role: string;

  constructor(private settings: Settings, private llm: LLMClient) {
    this.definition = getAgentDefinition('qa', { extraDirs: [settings.agentsDir] });
    this.role = this.definition.role;
  }

  async run(
    spec: ProductSpec,
    architecture: Architecture,
    sandbox: Sandbox,
    options: QAOptions = {},
  ): Promise<AgentResult> {
    const files = sandbox.listFiles({});
    const tickets = (options.tickets ?? [])
      .map((entry) => `- [${entry.key}] ${entry.task.title} (owner: ${entry.role ?? 'developer'})`)
      .join('\n');
    const feedbackSection = options.feedback
      ? `\n## PREVIOUS QA FEEDBACK\n${options.feedback}`
      : '';

    const task = renderAgentTask(this.definition, {
      iteration: options.iteration ?? 1,
      spec: spec.markdown,
      architecture: architecture.markdown,
      file_plan: JSON.stringify(architecture),
      tickets: tickets || '(all product acceptance criteria)',
      files: files.slice(0, 200).map((file: string) => `- ${file}`).join('\n'),
      feedback_section: feedbackSection,
    });

    const agent = agentFromDefinition(
      this.definition,
      this.llm,
      this.settings,
      makeTools(sandbox, { readOnly: true }),
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
