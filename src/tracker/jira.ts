import type { Settings } from '../config';
import type {
  CreateBugInput,
  CreateTicketInput,
  Ticket,
  TicketEvent,
  TicketPatch,
  TicketStatus,
  Tracker,
} from './types';
import { LocalTracker } from './local';

interface JiraResponse {
  status: number;
  data: any;
}

const STATUS_TARGETS: Record<TicketStatus, string[]> = {
  todo: ['To Do', 'Backlog', 'Open'],
  design: ['To Do', 'In Progress', 'In Design'],
  team_review: ['In Progress', 'To Do', 'In Review'],
  in_progress: ['In Progress', 'In Development'],
  in_review: ['In Review', 'Code Review', 'In Progress'],
  qa: ['In QA', 'QA', 'In Review'],
  done: ['Done', 'Closed', 'Resolved'],
  blocked: ['Blocked', 'On Hold'],
};

function adf(text: string): Record<string, unknown> {
  const lines = String(text ?? '')
    .replace(/\r/g, '')
    .slice(0, 28000)
    .split('\n')
    .slice(0, 400);
  return {
    type: 'doc',
    version: 1,
    content: lines.map((line) => ({
      type: 'paragraph',
      content: line.trim() ? [{ type: 'text', text: line.slice(0, 3000) }] : [],
    })),
  };
}

function cleanLabels(labels: string[]): string[] {
  return labels
    .map((label) => String(label).replace(/[^A-Za-z0-9_:-]+/g, '-').slice(0, 255))
    .filter(Boolean)
    .slice(0, 20);
}

export class JiraClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly email: string,
    private readonly token: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    const auth = Buffer.from(`${this.email}:${this.token}`).toString('base64');
    return {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
  }

  async request(method: string, path: string, body?: unknown): Promise<JiraResponse> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    let data: any = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text.slice(0, 1000) };
      }
    }
    return { status: response.status, data };
  }

  async myself(): Promise<any> {
    const response = await this.request('GET', '/rest/api/3/myself');
    if (response.status >= 400) throw new Error(`Jira /myself failed: HTTP ${response.status}`);
    return response.data;
  }

  async getProject(key: string): Promise<any | null> {
    const response = await this.request('GET', `/rest/api/3/project/${encodeURIComponent(key)}`);
    if (response.status === 404) return null;
    if (response.status >= 400) throw new Error(`Jira project lookup failed: HTTP ${response.status}`);
    return response.data;
  }

  async createProject(
    key: string,
    name: string,
    leadAccountId: string,
    description: string,
  ): Promise<any> {
    const base = {
      key,
      name,
      projectTypeKey: 'software',
      leadAccountId,
      description,
      assigneeType: 'PROJECT_LEAD',
    };
    let response = await this.request('POST', '/rest/api/3/project', {
      ...base,
      projectTemplateKey: 'com.pyxis.greenhopper.jira:gh-simplified-agility-kanban',
    });
    if (response.status === 400) {
      response = await this.request('POST', '/rest/api/3/project', base);
    }
    if (response.status >= 400) {
      throw new Error(
        `Jira project creation failed: HTTP ${response.status} ${JSON.stringify(response.data).slice(0, 500)}`,
      );
    }
    return response.data;
  }

  async createIssue(fields: Record<string, unknown>): Promise<any> {
    const response = await this.request('POST', '/rest/api/3/issue', { fields });
    if (response.status >= 400) {
      throw new Error(
        `Jira issue creation failed: HTTP ${response.status} ${JSON.stringify(response.data).slice(0, 700)}`,
      );
    }
    return response.data;
  }

  async updateIssue(key: string, fields: Record<string, unknown>): Promise<void> {
    const response = await this.request('PUT', `/rest/api/3/issue/${encodeURIComponent(key)}`, {
      fields,
    });
    if (response.status >= 400 && response.status !== 204) {
      throw new Error(`Jira issue update failed: HTTP ${response.status}`);
    }
  }

  async addComment(key: string, text: string): Promise<void> {
    const response = await this.request(
      'POST',
      `/rest/api/3/issue/${encodeURIComponent(key)}/comment`,
      { body: adf(text) },
    );
    if (response.status >= 400) {
      throw new Error(`Jira comment failed: HTTP ${response.status}`);
    }
  }

  async transition(key: string, target: string[]): Promise<boolean> {
    const listing = await this.request(
      'GET',
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
    );
    if (listing.status >= 400) throw new Error(`Jira transitions failed: HTTP ${listing.status}`);
    const transitions = Array.isArray(listing.data?.transitions) ? listing.data.transitions : [];
    const lowered = target.map((item) => item.toLowerCase());
    const match =
      transitions.find((item: any) => lowered.includes(String(item.name).toLowerCase())) ??
      transitions.find((item: any) =>
        lowered.some((wanted) => String(item.name).toLowerCase().includes(wanted)),
      );
    if (!match) return false;
    const response = await this.request(
      'POST',
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
      { transition: { id: String(match.id) } },
    );
    if (response.status >= 400) throw new Error(`Jira transition failed: HTTP ${response.status}`);
    return true;
  }

  async assign(key: string, accountId: string): Promise<void> {
    if (!accountId) return;
    const response = await this.request(
      'PUT',
      `/rest/api/3/issue/${encodeURIComponent(key)}/assignee`,
      { accountId },
    );
    if (response.status >= 400) throw new Error(`Jira assign failed: HTTP ${response.status}`);
  }

  async link(parentKey: string, childKey: string): Promise<void> {
    const response = await this.request('POST', `/rest/api/3/issueLink`, {
      type: { name: 'Relates' },
      inwardIssue: { key: parentKey },
      outwardIssue: { key: childKey },
    });
    if (response.status >= 400) throw new Error(`Jira issue link failed: HTTP ${response.status}`);
  }
}

export class JiraTracker implements Tracker {
  readonly projectKey: string;
  readonly projectName: string;
  readonly remote = true;
  private readonly local: LocalTracker;
  private readonly client: JiraClient;
  private leadAccountId = '';
  private projectReady = false;
  private projectError = '';

  constructor(private readonly settings: Settings, workflowRunId: number | null = null) {
    this.projectKey = settings.jiraProjectKey || 'CAREER';
    this.projectName = settings.jiraProjectName || 'Career Team';
    this.local = new LocalTracker(settings, workflowRunId);
    this.client = new JiraClient(settings.jiraBaseUrl, settings.jiraEmail, settings.jiraApiToken);
  }

  private accountFor(role: string): string {
    const mapping = this.settings.jiraAssigneeAccountIds ?? {};
    return mapping[role] || this.settings.jiraDefaultAccountId || this.leadAccountId;
  }

  private async syncError(key: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[jira] ${message}`);
    try {
      await this.local.update(key, { syncError: message.slice(0, 1000) });
    } catch {
      // Local tracking is best-effort here; never mask the original failure.
    }
  }

  private async remoteKey(localKey: string): Promise<string> {
    const ticket = await this.local.get(localKey);
    return ticket?.jira_key || localKey;
  }

  async ensureProject(): Promise<{ key: string; name: string; created: boolean; error?: string }> {
    try {
      const existing = await this.client.getProject(this.projectKey);
      if (existing) {
        this.projectReady = true;
        this.leadAccountId = existing.lead?.accountId || '';
        return { key: this.projectKey, name: existing.name || this.projectName, created: false };
      }
      const me = await this.client.myself();
      this.leadAccountId = me.accountId || '';
      if (!this.settings.jiraAutoCreateProject) {
        this.projectError = `Jira project ${this.projectKey} does not exist and auto-create is disabled.`;
        return { key: this.projectKey, name: this.projectName, created: false, error: this.projectError };
      }
      await this.client.createProject(
        this.projectKey,
        this.projectName,
        this.leadAccountId,
        'Career team delivery tracked by the Dev Firm agents.',
      );
      this.projectReady = true;
      return { key: this.projectKey, name: this.projectName, created: true };
    } catch (error) {
      this.projectError = error instanceof Error ? error.message : String(error);
      console.warn(`[jira] project setup failed: ${this.projectError}`);
      return {
        key: this.projectKey,
        name: this.projectName,
        created: false,
        error: this.projectError,
      };
    }
  }

  private async createRemote(ticket: Ticket): Promise<void> {
    if (!this.projectReady) return;
    try {
      const fields: Record<string, unknown> = {
        project: { key: this.projectKey },
        summary: ticket.title.slice(0, 250),
        description: adf(ticket.description || ticket.title),
        issuetype: { name: ticket.type === 'bug' ? 'Bug' : 'Task' },
        labels: cleanLabels([
          ...ticket.labels,
          'dev-firm',
          `devfirm-${ticket.key}`,
          `type-${ticket.type}`,
          ...(ticket.assignee ? [`agent-${ticket.assignee}`] : []),
        ]),
      };
      const accountId = this.accountFor(ticket.assignee);
      if (accountId) fields.assignee = { accountId };
      const created = await this.client.createIssue(fields);
      if (created?.key) {
        await this.local.update(ticket.key, { jiraKey: String(created.key), syncError: null });
        await this.local.comment(
          ticket.key,
          `Synced to Jira as ${created.key}.`,
          'system',
        );
        if (ticket.parent_key) {
          const parentRemote = await this.remoteKey(ticket.parent_key);
          try {
            await this.client.link(parentRemote, String(created.key));
          } catch (error) {
            await this.syncError(ticket.key, error);
          }
        }
      }
    } catch (error) {
      await this.syncError(ticket.key, error);
    }
  }

  async createTicket(input: CreateTicketInput): Promise<Ticket> {
    const ticket = await this.local.createTicket(input);
    await this.createRemote(ticket);
    return (await this.local.get(ticket.key)) ?? ticket;
  }

  async createBug(input: CreateBugInput): Promise<Ticket> {
    const bug = await this.local.createBug(input);
    await this.createRemote(bug);
    return (await this.local.get(bug.key)) ?? bug;
  }

  async get(key: string): Promise<Ticket | null> {
    return this.local.get(key);
  }

  async list(workflowRunId?: number | null): Promise<Ticket[]> {
    return this.local.list(workflowRunId);
  }

  async events(key: string): Promise<TicketEvent[]> {
    return this.local.events(key);
  }

  async update(key: string, patch: TicketPatch): Promise<Ticket | null> {
    return this.local.update(key, patch);
  }

  async transition(
    key: string,
    status: TicketStatus,
    assignee?: string,
    comment?: string,
  ): Promise<Ticket | null> {
    const ticket = await this.local.transition(key, status, assignee, comment);
    if (!ticket) return null;
    const remote = await this.remoteKey(key);
    try {
      if (this.projectReady) {
        await this.client.transition(remote, STATUS_TARGETS[status]);
        const accountId = this.accountFor(assignee || ticket.assignee);
        if (accountId) await this.client.assign(remote, accountId);
        if (comment) await this.client.addComment(remote, comment);
      }
    } catch (error) {
      await this.syncError(key, error);
    }
    return this.local.get(key);
  }

  async assign(key: string, assignee: string, comment?: string): Promise<Ticket | null> {
    const ticket = await this.local.assign(key, assignee, comment);
    if (!ticket) return null;
    const remote = await this.remoteKey(key);
    try {
      if (this.projectReady) {
        const accountId = this.accountFor(assignee);
        if (accountId) await this.client.assign(remote, accountId);
        if (comment) await this.client.addComment(remote, comment);
      }
    } catch (error) {
      await this.syncError(key, error);
    }
    return this.local.get(key);
  }

  async comment(key: string, body: string, actor = 'system'): Promise<void> {
    await this.local.comment(key, body, actor);
    try {
      if (this.projectReady) await this.client.addComment(await this.remoteKey(key), body);
    } catch (error) {
      await this.syncError(key, error);
    }
  }

  async link(parentKey: string, childKey: string): Promise<void> {
    await this.local.link(parentKey, childKey);
    try {
      if (this.projectReady) {
        await this.client.link(await this.remoteKey(parentKey), await this.remoteKey(childKey));
      }
    } catch (error) {
      await this.syncError(childKey, error);
    }
  }

  async close(key: string, evidence: string): Promise<Ticket | null> {
    const ticket = await this.local.close(key, evidence);
    if (!ticket) return null;
    const remote = await this.remoteKey(key);
    try {
      if (this.projectReady) {
        await this.client.addComment(remote, `Closed with evidence:\n\n${evidence}`);
        await this.client.transition(remote, STATUS_TARGETS.done);
      }
    } catch (error) {
      await this.syncError(key, error);
    }
    return this.local.get(key);
  }

  get error(): string {
    return this.projectError;
  }
}
