import { describe, expect, it } from 'vitest';

import * as db from '../src/db';
import { LocalTracker } from '../src/tracker';
import { makeSettings } from './helpers';

describe('local ticket tracker', () => {
  it('creates tasks and bugs, links them, and records history', async () => {
    const settings = makeSettings();
    const tracker = new LocalTracker(settings);

    const project = await tracker.ensureProject();
    expect(project.key).toBe('CAREER');
    expect(project.created).toBe(false);

    const task = await tracker.createTicket({
      type: 'task',
      title: 'Implement the API',
      description: 'Build the endpoints.',
      status: 'design',
      assignee: 'architect',
      reporter: 'product_manager',
      labels: ['area:backend'],
    });
    expect(task.key).toMatch(/^CAREER-\d+$/);
    expect(task.assignee).toBe('architect');
    expect(task.labels).toContain('area:backend');

    const updated = await tracker.transition(
      task.key,
      'in_progress',
      'backend_developer',
      'Design approved.',
    );
    expect(updated?.status).toBe('in_progress');
    expect(updated?.assignee).toBe('backend_developer');

    const bug = await tracker.createBug({
      title: 'POST /books returns 500',
      description: 'The database call throws.',
      severity: 'blocker',
      area: 'backend',
      parentKey: task.key,
      assignee: 'team_lead',
    });
    expect(bug.type).toBe('bug');
    expect(bug.reporter).toBe('qa');
    expect(bug.status).toBe('team_review');
    expect(bug.labels).toContain('severity:blocker');
    expect(bug.parent_key).toBe(task.key);

    const linkedTask = await tracker.get(task.key);
    const linkedBug = await tracker.get(bug.key);
    expect(linkedTask?.links).toContain(bug.key);
    expect(linkedBug?.links).toContain(task.key);

    await tracker.assign(bug.key, 'backend_developer', 'Triaged to the backend developer.');
    const triaged = await tracker.get(bug.key);
    expect(triaged?.assignee).toBe('backend_developer');

    const closed = await tracker.close(bug.key, 'npm test passes; POST /books returns 201.');
    expect(closed?.status).toBe('done');
    expect(closed?.evidence).toContain('npm test passes');

    const events = await tracker.events(bug.key);
    const kinds = events.map((event) => event.event);
    expect(kinds).toContain('created');
    expect(kinds).toContain('comment');
    expect(kinds).toContain('link');
    expect(events[events.length - 1].body).toContain('Closed with evidence');
  });

  it('lists tickets per workflow and globally', async () => {
    const settings = makeSettings();
    const [firstId, secondId] = db.withSession(settings.dbPath, (conn) => [
      db.createWorkflow(conn, 'build', 'first', {}),
      db.createWorkflow(conn, 'build', 'second', {}),
    ]);
    const first = new LocalTracker(settings, firstId);
    const second = new LocalTracker(settings, secondId);

    await first.createTicket({ type: 'epic', title: 'First epic' });
    await second.createTicket({ type: 'epic', title: 'Second epic' });

    const firstTickets = await first.list();
    const allTickets = await first.list(null);
    expect(firstTickets).toHaveLength(1);
    expect(firstTickets[0].title).toBe('First epic');
    expect(allTickets).toHaveLength(2);
  });
});
