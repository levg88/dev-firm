/**
 * @fileoverview Team lead agent wrapper.
 *
 * Reviews the architect's design and routes every task to a developer; also
 * triages QA-opened bugs and routes them. Both flows return structured
 * design-review / bug-triage JSON. Prompts and task templates come from
 * `agents/team-lead.md` and `agents/team-lead-triage.md`.
 */

import { Settings } from '../config';
import { LLMClient } from '../llm/base';
import { AgentResult, agentFromDefinition } from './base';
import {
  Architecture,
  DesignReview,
  BugSpec,
  ProductSpec,
  QAReport,
  TaskSpec,
} from './build_schemas';
import { getAgentDefinition, renderAgentTask, type AgentDefinition } from './definitions';
import { runAgent } from './runner';
import { schemaForAgent } from './schema';

export interface TicketTask {
  key: string;
  task: TaskSpec;
}

/** Team lead role agent: design review and bug triage routing. */
export class TeamLead {
  readonly definition: AgentDefinition;
  readonly triageDefinition: AgentDefinition;
  readonly role: string;

  constructor(private settings: Settings, private llm: LLMClient) {
    this.definition = getAgentDefinition('team_lead', { extraDirs: [settings.agentsDir] });
    this.triageDefinition = getAgentDefinition('team_lead_triage', {
      extraDirs: [settings.agentsDir],
    });
    this.role = this.definition.role;
  }

  /** Review the design and route every task to a developer. */
  async run(
    spec: ProductSpec,
    architecture: Architecture,
    tasks: TicketTask[],
    options: { workflowRunId?: number | null; round?: number; feedback?: string } = {},
  ): Promise<AgentResult> {
    const taskList = tasks
      .map(
        (entry) =>
          `- [${entry.key}] ${entry.task.title} (area: ${entry.task.area})\n` +
          `  ${entry.task.description}\n` +
          `  Acceptance: ${entry.task.acceptance_criteria.join('; ') || 'see product spec'}`,
      )
      .join('\n');
    const feedbackSection = options.feedback
      ? `\n## PREVIOUS REVIEW FEEDBACK\n${options.feedback}`
      : '';
    const task = renderAgentTask(this.definition, {
      round: options.round ?? 1,
      spec: spec.markdown,
      architecture: architecture.markdown,
      tasks: taskList || '(no tasks)',
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

  /** Triage bugs opened by QA and route each one to a developer. */
  async triage(
    spec: ProductSpec,
    qa: QAReport,
    bugs: Array<{ key: string; bug: BugSpec }>,
    options: { workflowRunId?: number | null; iteration?: number } = {},
  ): Promise<AgentResult> {
    const bugList = bugs
      .map(
        (entry) =>
          `- [${entry.key}] ${entry.bug.title} (severity: ${entry.bug.severity}, area: ${entry.bug.area})\n` +
          `  ${entry.bug.description}`,
      )
      .join('\n');
    const task = renderAgentTask(this.triageDefinition, {
      iteration: options.iteration ?? 1,
      spec: spec.markdown,
      qa_passed: qa.passed ? 'yes' : 'no',
      qa_summary: qa.summary,
      qa_issues: qa.issues.map((issue) => `- ${issue}`).join('\n'),
      bugs: bugList || '(no bugs)',
    });
    const agent = agentFromDefinition(this.triageDefinition, this.llm, this.settings);
    return runAgent(this.settings, agent, {
      workflow: this.triageDefinition.workflow,
      role: this.role,
      task,
      schema: schemaForAgent(this.triageDefinition),
      workflowRunId: options.workflowRunId ?? null,
    });
  }

  /** Type-safe helper used by the orchestrator for fallbacks. */
  static assignmentsFor(review: DesignReview | null): Map<string, string> {
    const out = new Map<string, string>();
    for (const assignment of review?.assignments ?? []) {
      if (assignment.task) out.set(assignment.task.trim().toLowerCase(), assignment.developer);
    }
    return out;
  }
}
