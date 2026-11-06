import { Settings } from '../config';
import { LLMClient } from '../llm/base';
import { Architect } from './architect';
import { Developer } from './developer';
import { ProductManager } from './product_manager';
import { QA } from './qa';
import { Sandbox } from './tools';
import { TeamLead } from './team_lead';
import { TechLead } from './tech_lead';

export class BuildAgents {
  private readonly _pm: ProductManager;
  private readonly _architect: Architect;
  private readonly _team_lead: TeamLead;
  private readonly _backend: Developer;
  private readonly _frontend: Developer;
  private readonly _qa: QA;
  private readonly _tech_lead: TechLead;

  constructor(private readonly settings: Settings, private readonly llm: LLMClient) {
    this._pm = new ProductManager(settings, llm);
    this._architect = new Architect(settings, llm);
    this._team_lead = new TeamLead(settings, llm);
    this._backend = new Developer(settings, llm, 'backend_developer');
    this._frontend = new Developer(settings, llm, 'frontend_developer');
    this._qa = new QA(settings, llm);
    this._tech_lead = new TechLead(settings, llm);
  }

  pm(brief: string, options: { workflowRunId?: number | null } = {}): Promise<import('./base').AgentResult> {
    return this._pm.run(brief, options);
  }

  architect(
    spec: unknown,
    options: { workflowRunId?: number | null; feedback?: string; round?: number } = {},
  ): Promise<import('./base').AgentResult> {
    return this._architect.run(spec as never, options);
  }

  team_lead(
    spec: unknown,
    architecture: unknown,
    tasks: unknown,
    options: { workflowRunId?: number | null; round?: number; feedback?: string } = {},
  ): Promise<import('./base').AgentResult> {
    return this._team_lead.run(spec as never, architecture as never, tasks as never, options);
  }

  triage(
    spec: unknown,
    qa: unknown,
    bugs: unknown,
    options: { workflowRunId?: number | null; iteration?: number } = {},
  ): Promise<import('./base').AgentResult> {
    return this._team_lead.triage(spec as never, qa as never, bugs as never, options);
  }

  backend_developer(
    spec: unknown,
    architecture: unknown,
    sandbox: Sandbox,
    options: import('./developer').DeveloperRunOptions = {},
  ): Promise<import('./base').AgentResult> {
    return this._backend.run(spec as never, architecture as never, sandbox, options);
  }

  frontend_developer(
    spec: unknown,
    architecture: unknown,
    sandbox: Sandbox,
    options: import('./developer').DeveloperRunOptions = {},
  ): Promise<import('./base').AgentResult> {
    return this._frontend.run(spec as never, architecture as never, sandbox, options);
  }

  /** Backwards-compatible alias for the backend developer. */
  developer(
    spec: unknown,
    architecture: unknown,
    sandbox: Sandbox,
    options: import('./developer').DeveloperRunOptions = {},
  ): Promise<import('./base').AgentResult> {
    return this.backend_developer(spec, architecture, sandbox, options);
  }

  qa(
    spec: unknown,
    architecture: unknown,
    sandbox: Sandbox,
    options: import('./qa').QAOptions = {},
  ): Promise<import('./base').AgentResult> {
    return this._qa.run(spec as never, architecture as never, sandbox, options);
  }

  tech_lead(
    spec: unknown,
    architecture: unknown,
    developer: unknown,
    options: import('./tech_lead').TechLeadOptions = {},
  ): Promise<import('./base').AgentResult> {
    return this._tech_lead.run(spec as never, architecture as never, developer as never, options);
  }
}
