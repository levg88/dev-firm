import { Settings } from '../config';
import { LLMClient } from '../llm/base';
import { Agent, AgentResult } from './base';
import { Architecture, DeveloperReport, ProductSpec, techLeadReviewSchema } from './build_schemas';
import { TL } from './prompts';
import { runAgent } from './runner';

export class TechLead {
  readonly role = 'tech_lead';

  constructor(private settings: Settings, private llm: LLMClient) {}

  async run(
    spec: ProductSpec,
    architecture: Architecture,
    developer: DeveloperReport,
    options: { workflowRunId?: number | null } = {},
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
    const task = [
      'Review the delivered implementation against the product spec and architecture before final sign-off.',
      '',
      '## PRODUCT SPEC (PRD)',
      spec.markdown,
      '',
      '## ARCHITECTURE / DESIGN',
      architecture.markdown,
      '',
      '## DEVELOPER REPORT',
      developer.summary,
      'Files written:',
      ...developer.files_written.map((file) => `- ${file}`),
      'Tests run:',
      ...developer.tests_run.map((test) => `- ${test}`),
      'Known issues:',
      ...developer.known_issues.map((issue) => `- ${issue}`),
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
