import { Settings } from '../config';
import { LLMClient } from '../llm/base';
import { Architect } from './architect';
import { Developer } from './developer';
import { ProductManager } from './product_manager';
import { QA } from './qa';
import { Sandbox } from './tools';

export class BuildAgents {
  private readonly _pm: ProductManager;
  private readonly _architect: Architect;
  private readonly _developer: Developer;
  private readonly _qa: QA;

  constructor(private readonly settings: Settings, private readonly llm: LLMClient) {
    this._pm = new ProductManager(settings, llm);
    this._architect = new Architect(settings, llm);
    this._developer = new Developer(settings, llm);
    this._qa = new QA(settings, llm);
  }

  pm(brief: string, options: { workflowRunId?: number | null } = {}): Promise<import('./base').AgentResult> {
    return this._pm.run(brief, options);
  }

  architect(
    spec: unknown,
    options: { workflowRunId?: number | null } = {},
  ): Promise<import('./base').AgentResult> {
    return this._architect.run(spec as never, options);
  }

  developer(
    spec: unknown,
    architecture: unknown,
    sandbox: Sandbox,
    options: { feedback?: string; workflowRunId?: number | null } = {},
  ): Promise<import('./base').AgentResult> {
    return this._developer.run(spec as never, architecture as never, sandbox, options);
  }

  qa(
    spec: unknown,
    architecture: unknown,
    sandbox: Sandbox,
    options: { workflowRunId?: number | null } = {},
  ): Promise<import('./base').AgentResult> {
    return this._qa.run(spec as never, architecture as never, sandbox, options);
  }
}
