import { describe, expect, it } from 'vitest';

import * as db from '../src/db';
import { githubProjectStatus } from '../src/tracker/github';
import { AGENT_IDENTITIES, identityFor } from '../src/orchestrator/identities';
import { makeSettings } from './helpers';

describe('GitHub tracker mapping', () => {
  it('maps every local ticket status onto a project column', () => {
    expect(githubProjectStatus('todo')).toBe('Todo');
    expect(githubProjectStatus('design')).toBe('Todo');
    expect(githubProjectStatus('team_review')).toBe('Todo');
    expect(githubProjectStatus('in_progress')).toBe('In Progress');
    expect(githubProjectStatus('in_review')).toBe('In Progress');
    expect(githubProjectStatus('qa')).toBe('In Progress');
    expect(githubProjectStatus('done')).toBe('Done');
    expect(githubProjectStatus('blocked')).toBe('Todo');
  });

  it('gives every role its own git identity', () => {
    const emails = new Set(Object.values(AGENT_IDENTITIES).map((identity) => identity.email));
    expect(emails.size).toBe(7);
    expect(identityFor('qa').email).toBe('qa@dev-firm.local');
    expect(identityFor('frontend_developer').name).toContain('Frontend');
  });

  it('stores and looks up GitHub issue metadata on the local ticket', async () => {
    const settings = makeSettings();
    const { LocalTracker } = await import('../src/tracker');
    const tracker = new LocalTracker(settings);
    const ticket = await tracker.createTicket({ type: 'task', title: 'Tracked issue' });
    await tracker.update(ticket.key, {
      externalKey: '#42',
      externalUrl: 'https://github.com/levg88/career-firm/issues/42',
    });
    const byLocalKey = await tracker.get(ticket.key);
    expect(byLocalKey?.external_key).toBe('#42');
    const byIssueUrl = await tracker.get('https://github.com/levg88/career-firm/issues/42');
    expect(byIssueUrl?.key).toBe(ticket.key);
    expect(db.withSession(settings.dbPath, (conn) => db.stats(conn)).tickets).toBe(1);
  });
});
