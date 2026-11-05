import { Settings } from '../config';
import { LLMClient } from '../llm/base';
import { Agent, AgentResult } from './base';
import { Architecture, ProductSpec, qaReportSchema } from './build_schemas';
import { QA as QAPrompt } from './prompts';
import { runAgent } from './runner';
import { makeTools, Sandbox } from './tools';

export class QA {
  readonly role = 'qa';

  constructor(private settings: Settings, private llm: LLMClient) {}

  async run(
    spec: ProductSpec,
    architecture: Architecture,
    sandbox: Sandbox,
    options: { workflowRunId?: number | null } = {},
  ): Promise<AgentResult> {
    const agent = new Agent(
      {
        name: 'qa',
        role: 'qa',
        systemPrompt: QAPrompt,
        temperature: 0.1,
      },
      this.llm,
      this.settings,
      makeTools(sandbox, { readOnly: true }),
    );
    const files = sandbox.listFiles({});
    const task =
      'Review the implementation and run the tests.\n\n' +
      `## SPEC\n${spec.markdown}\n\n` +
      `## ARCHITECTURE\n${architecture.markdown}\n\n` +
      `## FILE PLAN\n${JSON.stringify(architecture)}\n\n` +
      `## FILES PRESENT\n${files.slice(0, 200).map((file: string) => `- ${file}`).join('\n')}`;
    return runAgent(this.settings, agent, {
      workflow: 'build',
      role: 'qa',
      task,
      schema: qaReportSchema,
      workflowRunId: options.workflowRunId ?? null,
    });
  }
}
