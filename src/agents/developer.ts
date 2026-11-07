import { Settings } from '../config';
import { LLMClient } from '../llm/base';
import { Agent, AgentResult } from './base';
import {
  Architecture,
  ProductSpec,
  TaskSpec,
  developerReportSchema,
} from './build_schemas';
import { BACKEND_DEVELOPER, FRONTEND_DEVELOPER } from './prompts';
import { runAgent } from './runner';
import { makeTools, Sandbox } from './tools';

export type DeveloperRole = 'backend_developer' | 'frontend_developer';

export interface DeveloperTicket {
  key: string;
  task: TaskSpec;
}

export interface DeveloperRunOptions {
  feedback?: string;
  workflowRunId?: number | null;
  iteration?: number;
  tickets?: DeveloperTicket[];
}

export class Developer {
  readonly role: DeveloperRole;
  readonly name: string;

  constructor(
    private settings: Settings,
    private llm: LLMClient,
    role: DeveloperRole = 'backend_developer',
    name: string = role,
  ) {
    this.role = role;
    this.name = name;
  }

  async run(
    spec: ProductSpec,
    architecture: Architecture,
    sandbox: Sandbox,
    options: DeveloperRunOptions = {},
  ): Promise<AgentResult> {
    const isFrontend = this.role === 'frontend_developer';
    const agent = new Agent(
      {
        name: this.name,
        role: this.role,
        systemPrompt: isFrontend ? FRONTEND_DEVELOPER : BACKEND_DEVELOPER,
        temperature: 0.2,
      },
      this.llm,
      this.settings,
      makeTools(sandbox),
    );

    const assigned = (options.tickets ?? [])
      .map(
        (entry) =>
          `- [${entry.key}] ${entry.task.title} (area: ${entry.task.area})\n` +
          `  ${entry.task.description}\n` +
          `  Acceptance: ${entry.task.acceptance_criteria.join('; ') || 'see product spec'}`,
      )
      .join('\n');

    const task = [
      `You are the ${isFrontend ? 'frontend' : 'backend'} developer. Implement the assigned tasks in the workspace.`,
      'Use the tools; do not just describe the code.',
      `You have at most ${this.settings.maxAgentSteps} tool steps. Write package.json and the source files first, then install and test once. Do not spend steps re-reading files.`,
      '',
      '## SPEC',
      spec.markdown,
      '',
      '## ARCHITECTURE',
      architecture.markdown,
      '',
      '## FILE PLAN',
      JSON.stringify(architecture),
      '',
      '## TEST PLAN',
      architecture.test_plan.map((item: string) => `- ${item}`).join('\n'),
      '',
      '## RUNTIME',
      `- Node.js version: ${process.version.replace(/^v/, '')}`,
      '- This project must be TypeScript: .ts files, strict tsconfig.json, and no .js source.',
      '- Scripts: typecheck "tsc --noEmit", build "tsc", test "vitest run".',
      '- Use the built-in node:sqlite module for persistence. Never add native addons (better-sqlite3, sqlite3).',
      '- Use current packages: express ^5, ejs ^3, vitest ^3, supertest ^7, typescript ^5.',
      '- Declare every runtime import in dependencies and run npm install before npm test.',
      '- Stop retrying a failing command after two attempts; return the report with the error.',
      '',
      '## ASSIGNED TASKS',
      assigned || '(implement the backend/frontend portion of the product spec)',
    ];
    if (options.feedback?.trim()) {
      task.push('', '## FEEDBACK TO FIX (TECH LEAD / QA)', options.feedback.trim());
    }
    if (options.iteration && options.iteration > 1) {
      task.push('', `This is iteration ${options.iteration}. Fix the feedback and re-run the tests.`);
    }

    return runAgent(this.settings, agent, {
      workflow: 'build',
      role: this.role,
      task: task.join('\n'),
      schema: developerReportSchema,
      workflowRunId: options.workflowRunId ?? null,
    });
  }
}
