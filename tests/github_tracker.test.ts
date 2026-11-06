import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GitHubTracker } from '../src/tracker/github';
import { makeSettings } from './helpers';

const originalPath = process.env.PATH;

function installFakeGh(): { dir: string; log: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-firm-gh-'));
  const log = path.join(dir, 'calls.jsonl');
  const script = path.join(dir, 'gh');
  fs.writeFileSync(
    script,
    `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_FAKE_LOG, JSON.stringify(args) + '\\n');
const command = args.slice(0, 2).join(' ');
const projectCommand = command.startsWith('project ');
if (process.env.GH_TOKEN && projectCommand) {
  process.stderr.write('GraphQL: Resource not accessible by personal access token (user.projectV2)\\n');
  process.exit(1);
}
if (command === 'project list') {
  process.stdout.write(JSON.stringify({ projects: [{ number: 1, title: 'Career Team', url: 'https://github.com/users/levg88/projects/1' }] }));
} else if (command === 'project view') {
  process.stdout.write(JSON.stringify({ number: 1, title: 'Career Team', url: 'https://github.com/users/levg88/projects/1' }));
} else if (command === 'issue create') {
  process.stdout.write('https://github.com/levg88/career-firm/issues/7\\n');
} else if (command === 'project item-add') {
  process.stdout.write(JSON.stringify({ id: 'item-1' }));
} else {
  process.stdout.write('ok\\n');
}
`,
    'utf8',
  );
  fs.chmodSync(script, 0o755);
  process.env.PATH = `${dir}:${originalPath ?? ''}`;
  process.env.GH_FAKE_LOG = log;
  return { dir, log };
}

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.GH_FAKE_LOG;
});

describe('GitHub tracker sync', () => {
  it('creates issues, moves project status, and closes them', async () => {
    const { log } = installFakeGh();
    const settings = makeSettings();
    settings.githubEnabled = true;
    settings.githubOwner = 'levg88';
    settings.githubRepo = 'career-firm';
    settings.githubProjectTitle = 'Career Team';
    settings.githubProjectNumber = 0;
    settings.githubAutoCreateProject = true;
    settings.githubAssigneeLogins = { backend_developer: 'levg88' };

    const tracker = new GitHubTracker(settings);
    const project = await tracker.ensureProject();
    expect(project.error).toBeUndefined();
    expect(project.url).toContain('projects/1');

    const ticket = await tracker.createTicket({
      type: 'task',
      title: 'Build the API',
      status: 'design',
      assignee: 'architect',
      reporter: 'product_manager',
    });
    expect(ticket.external_key).toBe('#7');
    expect(ticket.external_url).toContain('/issues/7');
    expect(ticket.sync_error).toBeNull();

    await tracker.transition(ticket.key, 'in_progress', 'backend_developer', 'Implement it.');
    const moved = await tracker.get(ticket.key);
    expect(moved?.status).toBe('in_progress');

    await tracker.close(ticket.key, 'npm test passes.');
    const closed = await tracker.get(ticket.key);
    expect(closed?.status).toBe('done');
    expect(closed?.external_key).toBe('#7');

    const calls = fs
      .readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.some((args) => args.join(' ').includes('issue create'))).toBe(true);
    expect(
      calls.some(
        (args) =>
          args.includes('--field') &&
          args.includes('Status') &&
          args.includes('--value') &&
          args.includes('In Progress'),
      ),
    ).toBe(true);
    expect(calls.some((args) => args.includes('--value') && args.includes('Done'))).toBe(true);
    expect(calls.some((args) => args.join(' ').includes('issue close'))).toBe(true);
  });

  it('falls back to the gh CLI login when a fine-grained token cannot access projects', async () => {
    const { log } = installFakeGh();
    const settings = makeSettings();
    settings.githubEnabled = true;
    settings.githubOwner = 'levg88';
    settings.githubRepo = 'career-firm';
    settings.githubProjectTitle = 'Career Team';
    settings.githubProjectNumber = 0;
    settings.githubAutoCreateProject = true;
    settings.githubToken = 'github_pat_fake';

    const tracker = new GitHubTracker(settings);
    const project = await tracker.ensureProject();
    expect(project.error).toBeUndefined();
    expect(project.url).toContain('projects/1');

    const ticket = await tracker.createTicket({ type: 'task', title: 'Token task' });
    expect(ticket.external_key).toBe('#7');
    expect(ticket.sync_error).toBeNull();

    const calls = fs
      .readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    // Project commands were retried without the token; issue create used it.
    expect(calls.filter((args) => args.join(' ').includes('project list')).length).toBeGreaterThan(1);
    expect(calls.some((args) => args.join(' ').includes('issue create'))).toBe(true);
  });
});
