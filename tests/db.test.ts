import { describe, expect, it } from 'vitest';

import * as db from '../src/db';
import { makeSettings } from './helpers';

describe('repository', () => {
  it('round-trips workflows, agent runs, and artifacts', () => {
    const settings = makeSettings();
    const ids = db.withSession(settings.dbPath, (conn) => {
      const workflowId = db.createWorkflow(conn, 'build', 'test', { brief: 'x' });
      const runId = db.startAgentRun(
        conn,
        workflowId,
        'build',
        'developer',
        { task: 'x' },
        'mock',
        'mock',
      );
      db.finishAgentRun(conn, runId, 'ok', { summary: 'done' }, undefined, 1, 2);
      db.saveArtifact(conn, workflowId, runId, 'a.md', 'markdown', 'hello');
      return { workflowId };
    });

    const snapshot = db.withSession(settings.dbPath, (conn) => ({
      workflow: db.getWorkflow(conn, ids.workflowId),
      runs: db.listAgentRuns(conn, ids.workflowId),
      artifacts: db.listArtifacts(conn, ids.workflowId),
      stats: db.stats(conn),
      allRuns: db.listAgentRuns(conn, null),
    }));

    expect(snapshot.workflow?.title).toBe('test');
    expect(snapshot.workflow?.input).toEqual({ brief: 'x' });
    expect(snapshot.runs[0].role).toBe('developer');
    expect(snapshot.runs[0].status).toBe('ok');
    expect(snapshot.runs[0].prompt_tokens).toBe(1);
    expect(snapshot.artifacts[0].content).toBe('hello');
    expect(snapshot.stats.workflow_runs).toBe(1);
    expect(snapshot.stats.agent_runs).toBe(1);
    expect(snapshot.allRuns[0].workflow).toBe('build');
  });

  it('round-trips app settings', () => {
    const settings = makeSettings();
    db.withSession(settings.dbPath, (conn) => {
      db.saveAppSettings(conn, { provider: 'ollama', model: 'llama3.1' });
      expect(db.getAppSettings(conn).provider).toBe('ollama');
      db.saveAppSettings(conn, { provider: 'mock' });
      expect(db.getAppSettings(conn).model).toBe('llama3.1');
      db.clearAppSettings(conn);
      expect(db.getAppSettings(conn)).toEqual({});
    });
  });
});
