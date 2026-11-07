import { describe, expect, it, vi } from 'vitest';

import { BuildStatusReporter } from '../src/orchestrator/status';
import type { Ticket, Tracker } from '../src/tracker';

function ticket(overrides: Partial<Ticket>): Ticket {
  return {
    id: 1,
    key: 'CAREER-1',
    project_key: 'CAREER',
    type: 'task',
    title: 'Implement the API',
    description: '',
    status: 'in_progress',
    assignee: 'backend_developer',
    reporter: 'product_manager',
    labels: [],
    links: [],
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function fakeTracker(tickets: Ticket[]): Tracker {
  return {
    projectKey: 'CAREER',
    projectName: 'Career',
    remote: false,
    ensureProject: async () => ({ key: 'CAREER', name: 'Career', created: false }),
    createTicket: async () => tickets[0],
    createBug: async () => tickets[0],
    get: async (key: string) => tickets.find((item) => item.key === key) ?? null,
    list: async () => tickets,
    events: async () => [],
    update: async () => null,
    transition: async () => null,
    assign: async () => null,
    comment: async () => undefined,
    link: async () => undefined,
    close: async () => null,
  } as Tracker;
}

describe('build status reporter', () => {
  it('renders phase, ticket owners, and an ETA and posts to the epic', async () => {
    const tickets = [
      ticket({ key: 'CAREER-1', title: 'Implement the API', assignee: 'backend_developer' }),
      ticket({
        key: 'CAREER-2',
        title: 'Build the UI',
        assignee: 'frontend_developer',
        status: 'qa',
      }),
      ticket({ key: 'CAREER-3', title: 'Done task', status: 'done' }),
    ];
    const tracker = fakeTracker(tickets);
    const comment = vi.spyOn(tracker, 'comment').mockResolvedValue(undefined);
    const artifacts: Record<string, string> = {};
    const reporter = new BuildStatusReporter(12, 'Reading list', tracker, 'CAREER-0', 3, (name, content) => {
      artifacts[name] = content;
    });
    reporter.setPhase('developers', 'Developers are implementing tickets', {
      iteration: 1,
      maxIterations: 3,
    });

    const markdown = await reporter.report('test');

    expect(markdown).toContain('build #12');
    expect(markdown).toContain('Developers are implementing tickets');
    expect(markdown).toContain('Iteration: 1/3');
    expect(markdown).toContain('Implement the API');
    expect(markdown).toContain('backend_developer');
    expect(markdown).toContain('frontend_developer');
    expect(markdown).toContain('ETA to finish');
    expect(comment).toHaveBeenCalledWith('CAREER-0', expect.stringContaining('Tech lead status'), 'team_lead');
    expect(artifacts['status.md']).toContain('Current tickets and owners');
    expect(Object.keys(artifacts)).toContain('status.md');
    expect(Object.keys(artifacts).some((name) => name.startsWith('status/status_'))).toBe(true);
  });
});
