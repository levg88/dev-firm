import { Settings } from '../config';
import { LLMClient } from '../llm/base';
import { Agent, AgentResult } from './base';
import {
  Architecture,
  DeveloperReport,
  ProductSpec,
  TaskSpec,
  techLeadReviewSchema,
} from './build_schemas';
import { TL } from './prompts';
import { runAgent } from './runner';

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

export class TechLead {
  readonly role = 'tech_lead';

  constructor(private settings: Settings, private llm: LLMClient) {}

  async run(
    spec: ProductSpec,
    architecture: Architecture,
    developer: DeveloperReport | DeveloperReport[],
    options: TechLeadOptions = {},
  ): Promise<AgentResult> {
    const agent = new Agent(
      {
        name: 'tech_lead',
        role: 'tech_lead',
        systemPrompt: TL,
        temperature: 0.2,
      },
      this.llm,
      this.settings,
    );

    const reports = Array.isArray(developer) ? developer : [developer];
    const ticketList = (options.tickets ?? [])
      .map((entry) => `- [${entry.key}] ${entry.task.title} (owner: ${entry.role ?? 'developer'})`)
      .join('\n');

    const task = [
      `Review the delivered implementation against the product spec and architecture before final sign-off (iteration ${options.iteration ?? 1}).`,
      '',
      '## PRODUCT SPEC (PRD)',
      spec.markdown,
      '',
      '## ARCHITECTURE / DESIGN',
      architecture.markdown,
      '',
      '## ACTIVE TICKETS',
      ticketList || '(no active tickets)',
      '',
      '## DEVELOPER REPORTS',
      ...reports.flatMap((report, index) => [
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
      ]),
      options.feedback ? `## PREVIOUS REVIEW FEEDBACK\n${options.feedback}\n` : '',
      'If the implementation is not ready, set verdict to false and list every blocking issue.',
    ].join('\n');

    return runAgent(this.settings, agent, {
      workflow: 'build',
      role: 'tech_lead',
      task,
      schema: techLeadReviewSchema,
      workflowRunId: options.workflowRunId ?? null,
    });
  }
}
