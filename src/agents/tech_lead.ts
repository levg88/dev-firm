/**
 * @fileoverview Tech lead agent wrapper.
 *
 * Reviews delivered implementation (developer reports, files, tests) against the
 * product spec and architecture, returning a pass/fail verdict with blocking
 * issues. The identity, prompt, and task template come from `agents/tech-lead.md`.
 */

import { Settings } from '../config';
import { LLMClient } from '../llm/base';
import { AgentResult, agentFromDefinition } from './base';
import { Architecture, DeveloperReport, ProductSpec, TaskSpec } from './build_schemas';
import { getAgentDefinition, renderAgentTask, type AgentDefinition } from './definitions';
import { runAgent } from './runner';
import { schemaForAgent } from './schema';

export interface ReviewTicket {
  key: string;
  role?: string;
  task: TaskSpec;
}

export interface TechLeadOptions {
  workflowRunId?: number | null;
  iteration?: number;
  tickets?: ReviewTicket[];
  feedback?: string;
}

/** Tech lead role agent: code review before QA sign-off. */
export class TechLead {
  readonly definition: AgentDefinition;
  readonly role: string;

  constructor(private settings: Settings, private llm: LLMClient) {
    this.definition = getAgentDefinition('tech_lead', { extraDirs: [settings.agentsDir] });
    this.role = this.definition.role;
  }

  async run(
    spec: ProductSpec,
    architecture: Architecture,
    developer: DeveloperReport | DeveloperReport[],
    options: TechLeadOptions = {},
  ): Promise<AgentResult> {
    const reports = Array.isArray(developer) ? developer : [developer];
    const ticketList = (options.tickets ?? [])
      .map((entry) => `- [${entry.key}] ${entry.task.title} (owner: ${entry.role ?? 'developer'})`)
      .join('\n');

    const reportText = reports
      .flatMap((report, index) => [
        `### Report ${index + 1}`,
        report.summary,
        'Files written:',
        ...report.files_written.map((file) => `- ${file}`),
        'Tests run:',
        ...report.tests_run.map((test) => `- ${test}`),
        'Known issues:',
        ...report.known_issues.map((issue) => `- ${issue}`),
        'Tasks completed:',
        ...report.tasks_completed.map((item) => `- ${item}`),
        '',
      ])
      .join('\n');
    const feedbackSection = options.feedback
      ? `## PREVIOUS REVIEW FEEDBACK\n${options.feedback}`
      : '';

    const task = renderAgentTask(this.definition, {
      iteration: options.iteration ?? 1,
      spec: spec.markdown,
      architecture: architecture.markdown,
      tickets: ticketList || '(no active tickets)',
      reports: reportText,
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
