/**
 * @fileoverview Product manager agent wrapper.
 *
 * Turns a rough product brief into a build-ready product specification
 * (markdown + tasks + acceptance criteria) validated against `productSpecSchema`.
 * The identity, prompt, and task template come from `agents/product-manager.md`.
 */

import { Settings } from '../config';
import { LLMClient } from '../llm/base';
import { AgentResult, agentFromDefinition } from './base';
import { getAgentDefinition, renderAgentTask, type AgentDefinition } from './definitions';
import { runAgent } from './runner';
import { schemaForAgent } from './schema';

/** Product manager role agent: produces the product spec from a brief. */
export class ProductManager {
  readonly definition: AgentDefinition;
  readonly role: string;

  constructor(private settings: Settings, private llm: LLMClient) {
    this.definition = getAgentDefinition('product_manager', {
      extraDirs: [settings.agentsDir],
    });
    this.role = this.definition.role;
  }

  async run(brief: string, options: { workflowRunId?: number | null } = {}): Promise<AgentResult> {
    const task = renderAgentTask(this.definition, { brief });
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
