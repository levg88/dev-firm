import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Settings } from '../config';
import type { AgentRole } from '../models';
import type {
  CreateBugInput,
  CreateTicketInput,
  Ticket,
  TicketPatch,
  TicketStatus,
} from './types';
import { LocalTracker } from './local';

const execFileAsync = promisify(execFile);

interface GitHubProject {
  number: number;
  title: string;
  url?: string;
}

/** Map the local delivery states onto the three default GitHub Project columns. */
export function githubProjectStatus(status: string): 'Todo' | 'In Progress' | 'Done' {
  switch (status) {
    case 'in_progress':
    case 'in_review':
    case 'qa':
      return 'In Progress';
    case 'done':
      return 'Done';
    default:
      return 'Todo';
  }
}

/**
 * Local ticket mirror with a best-effort GitHub Projects/Issues sync.
 *
 * The local SQLite board is always the source of truth so a missing token, an
 * offline machine, or a missing `project` scope never stops the delivery loop.
 * GitHub issues carry the ticket as a durable human-facing record; per-role
 * identity is expressed with role labels, a "Reported by" line in the issue
 * body, and role-prefixed comments because agents are not GitHub users.
 */
export class GitHubTracker extends LocalTracker {
  readonly remote: boolean = true;
  private projectNumber: number;
  private projectUrl = '';
  private projectError = '';
  private ready: Promise<{ key: string; name: string; created: boolean; url?: string; error?: string }> | null = null;
  private readonly labels = new Set<string>();
  private readonly roleLabels = new Map<string, string>();
  private readonly repoSlug: string;
  private projectTokenUnusable = false;

  constructor(settings: Settings, workflowRunId: number | null = null) {
    super(settings, workflowRunId);
    this.projectNumber = settings.githubProjectNumber || 0;
    this.repoSlug = `${settings.githubOwner}/${settings.githubRepo}`;
  }

  async ensureProject(): Promise<{
    key: string;
    name: string;
    created: boolean;
    url?: string;
    error?: string;
  }> {
    if (!this.ready) this.ready = this._ensureProject();
    return this.ready;
  }

  private async _ensureProject(): Promise<{
    key: string;
    name: string;
    created: boolean;
    url?: string;
    error?: string;
  }> {
    const title = this.settings.githubProjectTitle || 'Career Team';
    const name = `${title} · ${this.repoSlug}`;
    try {
      let project = await this._findProject();
      let created = false;
      if (!project) {
        if (!this.settings.githubAutoCreateProject) {
          throw new Error(
            `GitHub project "${title}" was not found and auto-create is disabled.`,
          );
        }
        const raw = await this._gh([
          'project',
          'create',
          '--owner',
          this.settings.githubOwner,
          '--title',
          title,
          '--format',
          'json',
        ]);
        project = JSON.parse(raw) as GitHubProject;
        created = true;
      }
      this.projectNumber = Number(project.number);
      this.projectUrl =
        project.url ||
        `https://github.com/users/${this.settings.githubOwner}/projects/${this.projectNumber}`;
      try {
        await this._gh([
          'project',
          'link',
          String(this.projectNumber),
          '--owner',
          this.settings.githubOwner,
          '--repo',
          this.repoSlug,
        ]);
      } catch {
        // Linking is a convenience; the project still receives items without it.
      }
      return { key: this.projectKey, name, created, url: this.projectUrl };
    } catch (error) {
      this.projectError = this._message(error);
      return { key: this.projectKey, name, created: false, error: this.projectError };
    }
  }

  private async _findProject(): Promise<GitHubProject | null> {
    const owner = this.settings.githubOwner;
    if (this.projectNumber > 0) {
      try {
        const raw = await this._gh([
          'project',
          'view',
          String(this.projectNumber),
          '--owner',
          owner,
          '--format',
          'json',
        ]);
        const parsed = JSON.parse(raw) as GitHubProject;
        if (parsed && parsed.number) return parsed;
      } catch {
        // Fall through to a title lookup; the number may be stale.
      }
    }
    const raw = await this._gh([
      'project',
      'list',
      '--owner',
      owner,
      '--limit',
      '100',
      '--format',
      'json',
    ]);
    const parsed = JSON.parse(raw) as { projects?: GitHubProject[] } | GitHubProject[];
    const projects = Array.isArray(parsed) ? parsed : parsed.projects ?? [];
    return projects.find((project) => project.title === this.settings.githubProjectTitle) ?? null;
  }

  async createTicket(input: CreateTicketInput): Promise<Ticket> {
    const ticket = await super.createTicket(input);
    await this._syncCreate(ticket);
    return (await this.get(ticket.key)) ?? ticket;
  }

  async createBug(input: CreateBugInput): Promise<Ticket> {
    // super.createBug() calls this.createTicket(), which syncs the issue.
    return super.createBug(input);
  }

  async update(key: string, patch: TicketPatch): Promise<Ticket | null> {
    return super.update(key, patch);
  }

  async transition(
    key: string,
    status: TicketStatus,
    assignee?: AgentRole | '',
    comment?: string,
  ): Promise<Ticket | null> {
    const ticket = await super.transition(key, status, assignee, comment);
    if (ticket) await this._syncTicketState(ticket);
    return ticket;
  }

  async assign(key: string, assignee: AgentRole, comment?: string): Promise<Ticket | null> {
    const ticket = await super.assign(key, assignee, comment);
    if (ticket) await this._syncTicketState(ticket);
    return ticket;
  }

  async comment(key: string, body: string, actor: AgentRole | 'system' = 'system'): Promise<void> {
    await super.comment(key, body, actor);
    const ticket = await this.get(key);
    if (!ticket?.external_key) return;
    try {
      await this._gh([
        'issue',
        'comment',
        this._issueNumber(ticket),
        '--repo',
        this.repoSlug,
        '--body',
        this._commentBody(actor, body),
      ]);
    } catch (error) {
      await this._recordError(key, error);
    }
  }

  async link(parentKey: string, childKey: string): Promise<void> {
    await super.link(parentKey, childKey);
    const parent = await this.get(parentKey);
    const child = await this.get(childKey);
    const parentRef = parent?.external_url || parentKey;
    const childRef = child?.external_url || childKey;
    try {
      if (parent?.external_key) {
        await this._gh([
          'issue',
          'comment',
          this._issueNumber(parent),
          '--repo',
          this.repoSlug,
          '--body',
          this._commentBody('system', `Linked to child ticket ${childRef}`),
        ]);
      }
      if (child?.external_key) {
        await this._gh([
          'issue',
          'comment',
          this._issueNumber(child),
          '--repo',
          this.repoSlug,
          '--body',
          this._commentBody('system', `Linked to parent ticket ${parentRef}`),
        ]);
      }
    } catch (error) {
      await this._recordError(childKey, error);
    }
  }

  async close(key: string, evidence: string): Promise<Ticket | null> {
    const ticket = await super.close(key, evidence);
    if (ticket) await this._syncTicketState(ticket);
    return ticket;
  }

  private async _syncCreate(ticket: Ticket): Promise<void> {
    try {
      const labels = this._labelsFor(ticket);
      for (const label of labels) await this._ensureLabel(label);
      const args = [
        'issue',
        'create',
        '--repo',
        this.repoSlug,
        '--title',
        ticket.title,
        '--body',
        this._issueBody(ticket),
      ];
      for (const label of labels) args.push('--label', label);
      const login = this._loginFor(ticket.assignee);
      if (login) args.push('--assignee', login);
      const output = await this._gh(args);
      const url = output.split(/\s+/).find((part) => /^https?:\/\//.test(part)) ?? '';
      const number = url.match(/\/issues\/(\d+)/)?.[1] ?? '';
      await super.update(ticket.key, {
        externalKey: number ? `#${number}` : null,
        externalUrl: url || null,
        syncError: null,
      });
      const fresh = await this.get(ticket.key);
      if (fresh) await this._syncTicketState(fresh);
    } catch (error) {
      await this._recordError(ticket.key, error);
    }
  }

  private async _syncTicketState(ticket: Ticket): Promise<void> {
    if (!ticket.external_key || !ticket.external_url) return;
    try {
      const project = await this.ensureProject();
      if (project.error) throw new Error(project.error);
      if (!this.projectNumber) throw new Error('GitHub project number is not available.');
      const url = String(ticket.external_url);
      try {
        await this._gh([
          'project',
          'item-add',
          String(this.projectNumber),
          '--owner',
          this.settings.githubOwner,
          '--url',
          url,
          '--format',
          'json',
        ]);
      } catch {
        // The item may already be in the project.
      }
      await this._gh([
        'project',
        'item-edit',
        String(this.projectNumber),
        '--owner',
        this.settings.githubOwner,
        '--url',
        url,
        '--field',
        'Status',
        '--value',
        githubProjectStatus(String(ticket.status)),
      ]);
      const login = this._loginFor(ticket.assignee);
      if (login) {
        try {
          await this._gh([
            'issue',
            'edit',
            this._issueNumber(ticket),
            '--repo',
            this.repoSlug,
            '--add-assignee',
            login,
          ]);
        } catch {
          // Assignment is a convenience; role labels keep the owner visible.
        }
      }
      await this._syncRoleLabel(ticket);
      if (ticket.status === 'done') {
        try {
          await this._gh([
            'issue',
            'close',
            this._issueNumber(ticket),
            '--repo',
            this.repoSlug,
            '--reason',
            'completed',
          ]);
        } catch {
          // Closing an already-closed issue is not an error for the pipeline.
        }
      }
      await super.update(ticket.key, { syncError: null });
    } catch (error) {
      await this._recordError(ticket.key, error);
    }
  }

  private async _syncRoleLabel(ticket: Ticket): Promise<void> {
    if (!ticket.external_key || !ticket.assignee) return;
    const next = `role:${ticket.assignee}`;
    const previous = this.roleLabels.get(ticket.key);
    if (previous === next) return;
    this.roleLabels.set(ticket.key, next);
    await this._ensureLabel(next);
    const args = ['issue', 'edit', this._issueNumber(ticket), '--repo', this.repoSlug, '--add-label', next];
    if (previous) args.push('--remove-label', previous);
    try {
      await this._gh(args);
    } catch {
      // Labels are informative only; never fail a sync over them.
    }
  }

  private async _recordError(key: string, error: unknown): Promise<void> {
    const message = this._message(error).slice(0, 1000);
    try {
      await super.update(key, { syncError: message });
    } catch {
      // Never let tracker bookkeeping stop a build.
    }
  }

  private _issueNumber(ticket: Ticket): string {
    return String(ticket.external_key ?? '').replace(/[^0-9]/g, '');
  }

  private _loginFor(role: string): string {
    if (!role) return '';
    return this.settings.githubAssigneeLogins[role] || this.settings.githubDefaultAssignee || '';
  }

  private _labelsFor(ticket: Ticket): string[] {
    const labels = new Set<string>([`type:${ticket.type}`]);
    if (ticket.assignee) labels.add(`role:${ticket.assignee}`);
    if (ticket.status === 'blocked') labels.add('status:blocked');
    for (const label of ticket.labels ?? []) labels.add(label);
    return [...labels]
      .map((label) => label.trim().replace(/\s+/g, '-').slice(0, 50))
      .filter(Boolean);
  }

  private async _ensureLabel(name: string): Promise<void> {
    if (!name || this.labels.has(name)) return;
    this.labels.add(name);
    try {
      await this._gh([
        'label',
        'create',
        name,
        '--repo',
        this.repoSlug,
        '--color',
        this._labelColor(name),
        '--force',
      ]);
    } catch {
      // Labels are cosmetic; issue creation can still proceed without them.
    }
  }

  private _labelColor(name: string): string {
    const palette = ['0e8a16', '1d76db', '5319e7', 'b60205', 'd93f0b', 'fbca04', '6f42c1', '006b75'];
    let hash = 0;
    for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % palette.length;
    return palette[hash];
  }

  private _issueBody(ticket: Ticket): string {
    const lines = [
      `## ${ticket.title}`,
      '',
      ticket.description || '_(no description)_',
      '',
      '---',
      `**Ticket:** ${ticket.key}`,
      `**Type:** ${ticket.type}`,
      `**Reported by:** ${ticket.reporter || 'system'}`,
      `**Assignee:** ${ticket.assignee || 'unassigned'}`,
      `**Status:** ${ticket.status}`,
    ];
    if (ticket.parent_key) lines.push(`**Parent:** ${ticket.parent_key}`);
    if (ticket.workflow_run_id) lines.push(`**Build:** #${ticket.workflow_run_id}`);
    lines.push('', `<!-- dev-firm ticket ${ticket.key} -->`);
    return lines.join('\n');
  }

  private _commentBody(actor: string, body: string): string {
    return `**${actor}**\n\n${body}`;
  }

  private _message(error: unknown): string {
    if (error && typeof error === 'object') {
      const record = error as Record<string, unknown>;
      const stderr = String(record.stderr ?? '').trim();
      const stdout = String(record.stdout ?? '').trim();
      const message = String(record.message ?? '').trim();
      return stderr || message || stdout || 'GitHub command failed.';
    }
    return String(error);
  }

  private async _gh(args: string[], useStoredToken = true): Promise<string> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const token = this.settings.githubToken;
    const projectCommand = args[0] === 'project';
    const withToken = Boolean(token) && useStoredToken && !(projectCommand && this.projectTokenUnusable);
    if (withToken) env.GH_TOKEN = token;
    else delete env.GH_TOKEN;
    try {
      const { stdout } = await execFileAsync('gh', args, {
        env,
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024,
      });
      return String(stdout).trim();
    } catch (error) {
      // Fine-grained tokens can create issues but often cannot access Projects v2.
      // Keep using the supplied token for issue work and fall back to the approved
      // gh CLI login for project-only commands.
      if (withToken && projectCommand && this._looksLikeProjectAuthError(error)) {
        this.projectTokenUnusable = true;
        return this._gh(args, false);
      }
      throw error;
    }
  }

  private _looksLikeProjectAuthError(error: unknown): boolean {
    const message = this._message(error).toLowerCase();
    return (
      message.includes('personal access token') ||
      message.includes('resource not accessible') ||
      message.includes('missing required scopes') ||
      message.includes('read:project') ||
      message.includes('project')
    );
  }

  /** Exposed for status/init commands without touching token material. */
  get remoteProjectUrl(): string {
    return this.projectUrl;
  }

  /** Re-apply issue state and project status to already mirrored tickets. */
  async syncAll(workflowRunId: number | null = null): Promise<{ synced: number; failed: number }> {
    const tickets = await this.list(workflowRunId);
    let synced = 0;
    let failed = 0;
    for (const ticket of tickets) {
      if (!ticket.external_url) continue;
      await this._syncTicketState(ticket);
      const fresh = await this.get(ticket.key);
      if (fresh?.sync_error) failed += 1;
      else synced += 1;
    }
    return { synced, failed };
  }
}
