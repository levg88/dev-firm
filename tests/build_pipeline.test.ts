import { describe, expect, it } from 'vitest';

import * as db from '../src/db';
import { BuildService } from '../src/orchestrator/build';
import { makeSettings } from './helpers';

describe('build pipeline', () => {
  it('runs the mock build and stores artifacts', async () => {
    const settings = makeSettings();
    const result = await new BuildService(settings).run('A tiny local app', 'Demo');
    expect(result.mock).toBe(true);

    const workflow = db.withSession(settings.dbPath, (conn) => db.getWorkflow(conn, result.workflow_id));
    const artifacts = db.withSession(settings.dbPath, (conn) => db.listArtifacts(conn, result.workflow_id));
    expect(workflow?.status).toBe('done');
    expect(artifacts.length).toBeGreaterThanOrEqual(5);
    const names = new Set(artifacts.map((artifact) => artifact.name));
    for (const required of [
      'product_spec.md',
      'architecture.md',
      'team_lead_design_review_round1.md',
      'tech_lead_report.md',
      'qa_report.md',
      'tickets.md',
    ]) {
      expect(names.has(required)).toBe(true);
    }
    for (const artifact of artifacts) {
      expect(String(artifact.content ?? '')).toBeTruthy();
    }
    expect(result.tech_lead).toBeDefined();
    expect(result.passed).toBe(true);
    expect(result.tickets.length).toBeGreaterThanOrEqual(2);
    expect(result.tickets.every((ticket) => ticket.status === 'done')).toBe(true);
    expect(result.tickets.some((ticket) => ticket.type === 'epic')).toBe(true);
    expect(result.tickets.some((ticket) => ticket.type === 'task')).toBe(true);
  });
});
