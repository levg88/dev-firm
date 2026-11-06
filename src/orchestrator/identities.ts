import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { AgentRole } from '../models';

export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * Human-readable identities used for the workspace commit trail.
 *
 * These are local git authors, not GitHub accounts: agents are not GitHub users,
 * so the remote issue uses role labels, issue-body attribution, and role-prefixed
 * comments instead of impersonating a person.
 */
export const AGENT_IDENTITIES: Record<AgentRole, GitIdentity> = {
  product_manager: { name: 'Dev Firm PM', email: 'pm@dev-firm.local' },
  architect: { name: 'Dev Firm Architect', email: 'architect@dev-firm.local' },
  team_lead: { name: 'Dev Firm Team Lead', email: 'team-lead@dev-firm.local' },
  backend_developer: { name: 'Dev Firm Backend Developer', email: 'backend-dev@dev-firm.local' },
  frontend_developer: { name: 'Dev Firm Frontend Developer', email: 'frontend-dev@dev-firm.local' },
  tech_lead: { name: 'Dev Firm Tech Lead', email: 'tech-lead@dev-firm.local' },
  qa: { name: 'Dev Firm QA', email: 'qa@dev-firm.local' },
};

export function identityFor(role: AgentRole | string): GitIdentity {
  return AGENT_IDENTITIES[role as AgentRole] ?? {
    name: `Dev Firm ${String(role || 'Agent')}`,
    email: `${String(role || 'agent').replace(/[^a-z0-9]+/gi, '-')}@dev-firm.local`,
  };
}

/** Initialise a workspace repository once so the role commit trail is durable. */
export function ensureGitRepo(workspace: string): void {
  try {
    if (fs.existsSync(path.join(workspace, '.git'))) return;
    execFileSync('git', ['init', '-q'], { cwd: workspace, stdio: 'ignore', timeout: 30000 });
    const ignore = path.join(workspace, '.gitignore');
    if (!fs.existsSync(ignore)) {
      fs.writeFileSync(ignore, 'node_modules/\n.env\n*.log\n', 'utf8');
    }
  } catch {
    // Best effort: a read-only workspace can still run the pipeline.
  }
}

/** Commit the workspace as a specific role, preserving a distinct author and committer. */
export function commitAs(workspace: string, role: AgentRole | string, message: string): void {
  const identity = identityFor(role);
  try {
    execFileSync('git', ['add', '-A'], { cwd: workspace, stdio: 'ignore', timeout: 30000 });
    execFileSync(
      'git',
      [
        '-c',
        `user.name=${identity.name}`,
        '-c',
        `user.email=${identity.email}`,
        'commit',
        '-m',
        message,
      ],
      { cwd: workspace, stdio: 'ignore', timeout: 60000 },
    );
  } catch {
    // Best effort: the workspace may not be a git repository or have no changes.
  }
}
