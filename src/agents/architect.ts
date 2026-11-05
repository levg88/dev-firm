import { Settings } from '../config';
import { LLMClient } from '../llm/base';
import { Agent, AgentResult } from './base';
import { Architecture, ProductSpec, architectureSchema } from './build_schemas';
import { ARCHITECT } from './prompts';
import { runAgent } from './runner';

export class Architect {
  readonly role = 'architect';

  constructor(private settings: Settings, private llm: LLMClient) {}

  async run(spec: ProductSpec, options: { workflowRunId?: number | null } = {}): Promise<AgentResult> {
    const agent = new Agent(
      {
        name: 'architect',
        role: 'architect',
        systemPrompt: ARCHITECT,
        temperature: 0.2,
      },
      this.llm,
      this.settings,
    );
    const task =
      'Design the smallest implementable architecture for this product spec.\n\n' +
      `## SPEC\n${spec.markdown}\n\n` +
      `## ACCEPTANCE CRITERIA\n` +
      spec.acceptance_criteria.map((item: string) => `- ${item}`).join('\n');
    return runAgent(this.settings, agent, {
      workflow: 'build',
      role: 'architect',
      task,
      schema: architectureSchema,
      workflowRunId: options.workflowRunId ?? null,
    });
  }
}
