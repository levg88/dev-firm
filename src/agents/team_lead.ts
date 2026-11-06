import { Settings } from '../config';
import { LLMClient } from '../llm/base';
import { Agent, AgentResult } from './base';
import {
  Architecture,
  DesignReview,
  BugSpec,
  ProductSpec,
  QAReport,
  TaskSpec,
  bugTriageSchema,
  designReviewSchema,
} from './build_schemas';
import { TEAM_LEAD } from './prompts';
import { runAgent } from './runner';

export interface TicketTask {
  key: string;
  task: TaskSpec;
}

export class TeamLead {
  readonly role = 'team_lead';

  constructor(private settings: Settings, private llm: LLMClient) {}

  private agent(systemPrompt: string): Agent {
    return new Agent(
      {
        name: 'team_lead',
        role: 'team_lead',
        systemPrompt,
        temperature: 0.2,
      },
      this.llm,
      this.settings,
    );
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
    const task = [
      `Review the design (round ${options.round ?? 1}) and assign every task.`,
      '',
      '## PRODUCT SPEC (PRD)',
      spec.markdown,
      '',
      '## ARCHITECTURE / DESIGN',
      architecture.markdown,
      '',
      '## TASKS TO ROUTE',
      taskList || '(no tasks)',
      options.feedback ? `\n## PREVIOUS REVIEW FEEDBACK\n${options.feedback}` : '',
      '',
      'Return the design review JSON. Use the exact task keys in assignment.task.',
    ].join('\n');
    return runAgent(this.settings, this.agent(TEAM_LEAD), {
      workflow: 'build',
      role: 'team_lead',
      task,
      schema: designReviewSchema,
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
    const task = [
      `Triage QA bugs from iteration ${options.iteration ?? 1} and assign each to a developer.`,
      '',
      '## PRODUCT SPEC (PRD)',
      spec.markdown,
      '',
      '## QA REPORT',
      `Passed: ${qa.passed ? 'yes' : 'no'}`,
      qa.summary,
      'Issues:',
      ...qa.issues.map((issue) => `- ${issue}`),
      '',
      '## OPEN BUGS',
      bugList || '(no bugs)',
      '',
      'Return the bug triage JSON. Use the exact bug keys in assignment.task.',
    ].join('\n');
    return runAgent(this.settings, this.agent(TEAM_LEAD), {
      workflow: 'build',
      role: 'team_lead',
      task,
      schema: bugTriageSchema,
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
