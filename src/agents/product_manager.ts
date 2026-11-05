import { Settings } from '../config';
import { LLMClient } from '../llm/base';
import { Agent, AgentResult } from './base';
import { ProductSpec, productSpecSchema } from './build_schemas';
import { PM } from './prompts';
import { runAgent } from './runner';

export class ProductManager {
  readonly role = 'product_manager';

  constructor(private settings: Settings, private llm: LLMClient) {}

  async run(brief: string, options: { workflowRunId?: number | null } = {}): Promise<AgentResult> {
    const agent = new Agent(
      {
        name: 'product_manager',
        role: 'product_manager',
        systemPrompt: PM,
        temperature: 0.3,
      },
      this.llm,
      this.settings,
    );
    const task = 'Turn this brief into a build-ready product specification:\n\n' + brief;
    return runAgent(this.settings, agent, {
      workflow: 'build',
      role: 'product_manager',
      task,
      schema: productSpecSchema,
      workflowRunId: options.workflowRunId ?? null,
    });
  }
}
