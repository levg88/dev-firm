import type { ZodType } from 'zod';

import type { Settings } from '../config';
import * as db from '../db';
import type { Agent, AgentResult } from './base';

export interface RunAgentOptions {
  workflow: string;
  role: string;
  task: string;
  context?: string;
  schema?: ZodType;
  workflowRunId?: number | null;
}

/** Run an agent and persist a complete audit record of the call. */
export async function runAgent(
  settings: Settings,
  agent: Agent,
  options: RunAgentOptions,
): Promise<AgentResult> {
  const context = options.context ?? '';
  const inputPayload = {
    task: options.task.slice(0, 8000),
    context_chars: context.length,
  };

  const runId = db.withSession(settings.dbPath, (conn) =>
    db.startAgentRun(
      conn,
      options.workflowRunId ?? null,
      options.workflow,
      options.role,
      inputPayload,
      agent.llm.provider,
      agent.llm.model,
    ),
  );

  let result: AgentResult;
  try {
    result = await agent.run(options.task, {
      context,
      schema: options.schema,
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    db.withSession(settings.dbPath, (conn) => {
      db.finishAgentRun(conn, runId, 'failed', undefined, `${err.name}: ${err.message}`);
    });
    throw error;
  }

  const output = result.data !== null ? result.data : { text: result.text.slice(0, 40000) };
  db.withSession(settings.dbPath, (conn) => {
    db.finishAgentRun(
      conn,
      runId,
      'ok',
      output,
      null,
      result.promptTokens,
      result.completionTokens,
    );
  });
  return result;
}

export interface RecordHeuristicOptions {
  workflow: string;
  role: string;
  inputPayload: Record<string, unknown>;
  output: Record<string, unknown>;
  workflowRunId?: number | null;
  reason?: string;
}

/** Record a deterministic fallback so the audit trail stays complete. */
export function recordHeuristicRun(settings: Settings, options: RecordHeuristicOptions): number {
  return db.withSession(settings.dbPath, (conn) => {
    const runId = db.startAgentRun(
      conn,
      options.workflowRunId ?? null,
      options.workflow,
      options.role,
      { ...options.inputPayload, reason: options.reason ?? 'offline deterministic agent' },
      'heuristic',
      'deterministic',
    );
    db.finishAgentRun(conn, runId, 'ok', options.output);
    return runId;
  });
}
