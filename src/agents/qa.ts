/**
 * @fileoverview QA agent wrapper.
 *
 * Builds the verification task prompt (spec, architecture, tickets, file list)
 * and runs QA with read-only sandbox tools so it can inspect and test the build
 * without modifying it.
 */

import { Settings } from '../config';
import { LLMClient } from '../llm/base';
import { Agent, AgentResult } from './base';
import { Architecture, ProductSpec, TaskSpec, qaReportSchema } from './build_schemas';
import { QA as QAPrompt } from './prompts';
import { runAgent } from './runner';
import { makeTools, Sandbox } from './tools';

export interface QATicket {
  key: string;
  task: TaskSpec;
  role?: string;
}

export interface QAOptions {
  workflowRunId?: number | null;
  iteration?: number;
  tickets?: QATicket[];
  feedback?: string;
}

/** QA role agent: verifies the implementation against spec and runs tests. */
export class QA {
  readonly role = 'qa';

  constructor(private settings: Settings, private llm: LLMClient) {}

  async run(
    spec: ProductSpec,
    architecture: Architecture,
    sandbox: Sandbox,
    options: QAOptions = {},
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
    const tickets = (options.tickets ?? [])
      .map((entry) => `- [${entry.key}] ${entry.task.title} (owner: ${entry.role ?? 'developer'})`)
      .join('\n');
    const task = [
      `Verify iteration ${options.iteration ?? 1} of the implementation and run the tests.`,
      '',
      `## SPEC\n${spec.markdown}`,
      '',
      `## ARCHITECTURE\n${architecture.markdown}`,
      '',
      `## FILE PLAN\n${JSON.stringify(architecture)}`,
      '',
      '## TICKETS UNDER TEST',
      tickets || '(all product acceptance criteria)',
      '',
      `## FILES PRESENT\n${files.slice(0, 200).map((file: string) => `- ${file}`).join('\n')}`,
      options.feedback ? `\n## PREVIOUS QA FEEDBACK\n${options.feedback}` : '',
      '',
      'Run the tests. If anything fails, create one structured bug per concrete failure.',
    ].join('\n');
    return runAgent(this.settings, agent, {
      workflow: 'build',
      role: 'qa',
      task,
      schema: qaReportSchema,
      workflowRunId: options.workflowRunId ?? null,
    });
  }
}
