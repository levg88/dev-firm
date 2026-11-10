/**
 * @fileoverview Factory assembling the full "build firm" agent team.
 *
 * {@link BuildAgents} instantiates one agent per role (product manager,
 * architect, team lead, two backend developers, two frontend developers, QA,
 * tech lead, DevOps) with the LLM client configured for that role, and exposes
 * typed convenience methods used by the build orchestrator.
 */

import { Settings } from '../config';
import { buildAgentLlm } from '../llm';
import { Architect } from './architect';
import { DevOps } from './devops';
import { Developer } from './developer';
import { ProductManager } from './product_manager';
import { QA } from './qa';
import { Sandbox } from './tools';
import { TeamLead } from './team_lead';
import { TechLead } from './tech_lead';

/**
 * Container holding one instantiated agent per role of the build firm.
 *
 * Constructed once per build run from a {@link Settings} object; each role gets
 * its own LLM client (possibly different models) via `buildLlmForRole`.
 */
export class BuildAgents {
  /** Product manager agent instance. */
  private readonly _pm: ProductManager;
  private readonly _architect: Architect;
  private readonly _team_lead: TeamLead;
  private readonly _backend: Developer;
  private readonly _backend2: Developer;
  private readonly _frontend: Developer;
  private readonly _frontend2: Developer;
  private readonly _qa: QA;
  private readonly _tech_lead: TechLead;
  private readonly _devops: DevOps;

  constructor(private readonly settings: Settings) {
    // Build a separate LLM client per role so models can be tuned per agent.
    const llmPm = buildAgentLlm(settings, 'product_manager');
    const llmArchitect = buildAgentLlm(settings, 'architect');
    const llmTeamLead = buildAgentLlm(settings, 'team_lead');
    const llmBackend = buildAgentLlm(settings, 'backend_developer');
    const llmFrontend = buildAgentLlm(settings, 'frontend_developer');
    const llmQa = buildAgentLlm(settings, 'qa');
    const llmTechLead = buildAgentLlm(settings, 'tech_lead');
    const llmDevOps = buildAgentLlm(settings, 'devops');

    this._pm = new ProductManager(settings, llmPm);
    this._architect = new Architect(settings, llmArchitect);
    this._team_lead = new TeamLead(settings, llmTeamLead);
    this._backend = new Developer(settings, llmBackend, 'backend_developer', 'Backend Developer 1');
    this._backend2 = new Developer(settings, llmBackend, 'backend_developer', 'Backend Developer 2');
    this._frontend = new Developer(settings, llmFrontend, 'frontend_developer', 'Frontend Developer 1');
    this._frontend2 = new Developer(settings, llmFrontend, 'frontend_developer', 'Frontend Developer 2');
    this._qa = new QA(settings, llmQa);
    this._tech_lead = new TechLead(settings, llmTechLead);
    this._devops = new DevOps(settings, llmDevOps, 'devops', 'DevOps Engineer');
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

  frontend_developer_2(
    spec: unknown,
    architecture: unknown,
    sandbox: Sandbox,
    options: import('./developer').DeveloperRunOptions = {},
  ): Promise<import('./base').AgentResult> {
    return this._frontend2.run(spec as never, architecture as never, sandbox, options);
  }

  backend_developer_2(
    spec: unknown,
    architecture: unknown,
    sandbox: Sandbox,
    options: import('./developer').DeveloperRunOptions = {},
  ): Promise<import('./base').AgentResult> {
    return this._backend2.run(spec as never, architecture as never, sandbox, options);
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

  devops(
    spec: unknown,
    sandbox: Sandbox,
    options: import('./devops').DevOpsRunOptions = {},
  ): Promise<import('./base').AgentResult> {
    return this._devops.run(spec as never, sandbox, options);
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
