import { Settings } from '../config';
import { LLMClient } from '../llm/base';
import { Agent, AgentResult } from './base';
import { Architecture, ProductSpec, developerReportSchema } from './build_schemas';
import { DEVELOPER } from './prompts';
import { runAgent } from './runner';
import { makeTools, Sandbox } from './tools';

export class Developer {
  readonly role = 'developer';

  constructor(private settings: Settings, private llm: LLMClient) {}

  async run(
    spec: ProductSpec,
    architecture: Architecture,
    sandbox: Sandbox,
    options: { feedback?: string; workflowRunId?: number | null } = {},
  ): Promise<AgentResult> {
    const agent = new Agent(
      {
        name: 'developer',
        role: 'developer',
        systemPrompt: DEVELOPER,
        temperature: 0.2,
      },
      this.llm,
      this.settings,
      makeTools(sandbox),
    );
    const task =
      'Implement the application in the workspace. Use the tools; do not just describe the code.\n\n' +
      `## SPEC\n${spec.markdown}\n\n` +
      `## ARCHITECTURE\n${architecture.markdown}\n\n` +
      `## FILE PLAN\n${JSON.stringify(architecture)}\n\n` +
      `## TEST PLAN\n${architecture.test_plan.map((item: string) => `- ${item}`).join('\n')}`;
    const taskWithFeedback = options.feedback
      ? task + '\n\n## QA FEEDBACK TO FIX\n' + options.feedback
      : task;
    return runAgent(this.settings, agent, {
      workflow: 'build',
      role: 'developer',
      task: taskWithFeedback,
      schema: developerReportSchema,
      workflowRunId: options.workflowRunId ?? null,
    });
  }
}
