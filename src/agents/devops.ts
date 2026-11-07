import { Settings } from '../config';
import { LLMClient } from '../llm/base';
import { Agent, AgentResult } from './base';
import { ProductSpec } from './build_schemas';
import { DEVOPS } from './prompts';
import { runAgent } from './runner';
import { makeTools, Sandbox } from './tools';

export type DevOpsRole = 'devops';

export interface DevOpsTicket {
  key: string;
  task: {
    title: string;
    description: string;
    area: string;
    acceptance_criteria: string[];
  };
}

export interface DevOpsRunOptions {
  feedback?: string;
  workflowRunId?: number | null;
  iteration?: number;
  tickets?: DevOpsTicket[];
  qaPassed?: boolean;
  qaReport?: Record<string, any>;
}

export class DevOps {
  readonly role: DevOpsRole;
  readonly name: string;

  constructor(
    private settings: Settings,
    private llm: LLMClient,
    role: DevOpsRole = 'devops',
    name: string = 'DevOps Engineer',
  ) {
    this.role = role;
    this.name = name;
  }

  async run(
    spec: ProductSpec,
    sandbox: Sandbox,
    options: DevOpsRunOptions = {},
  ): Promise<AgentResult> {
    const agent = new Agent(
      {
        name: this.name,
        role: this.role,
        systemPrompt: DEVOPS,
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

    const qaStatus = options.qaPassed
      ? 'PASSED — deployment is authorized.'
      : 'NOT PASSED — deployment is BLOCKED. Do not deploy until QA signs off.';

    const task = [
      `You are the DevOps engineer. You own CI/CD, GitOps, and deployment.`,
      '',
      '## MISSION',
      'Monitor and update the delivery pipeline (CI/CD / GitOps) and deploy new',
      'local versions of verified, QA-passed code. You do NOT write application',
      'code or review implementation quality.',
      '',
      '## QA STATUS',
      qaStatus,
      '',
      '## SPEC',
      spec.markdown,
      '',
      '## ASSIGNED TASKS',
      assigned || '(manage pipeline and deployment for this build)',
      '',
      '## RUNTIME',
      `- Node.js version: ${process.version.replace(/^v/, '')}`,
      '- Project root is the current workspace.',
      '- Repo uses TypeScript, strict tsconfig.json, scripts: typecheck, build, test.',
      '- Use the built-in node:sqlite module for persistence; never add native addons.',
      '- Deploy by running typecheck, build, test, then starting the server and',
      '  verifying it responds on its configured port.',
      '',
      '## DELIVERABLES',
      '1. Confirm pipeline files exist and are consistent (.github/workflows/*,',
      '   Makefile, deploy scripts).',
      '2. Run final verification: npm run typecheck, npm run build, npm run test.',
      '3. Start the server and confirm it responds (health check).',
      '4. Report pipeline status, deployments performed, and any blockers.',
      '',
      '- Do NOT modify product source code, tests, or architecture.',
      '- Only touch deployment, pipeline, and ops-related files.',
      '- If deployment fails, report the exact error and stop; do not retry blindly.',
    ];
    if (options.feedback?.trim()) {
      task.push('', '## FEEDBACK TO FIX', options.feedback.trim());
    }
    if (options.iteration && options.iteration > 1) {
      task.push('', `This is deployment iteration ${options.iteration}. Fix the feedback and re-deploy.`);
    }

    return runAgent(this.settings, agent, {
      workflow: 'build',
      role: this.role,
      task: task.join('\n'),
      schema: undefined,
      workflowRunId: options.workflowRunId ?? null,
    });
  }
}
