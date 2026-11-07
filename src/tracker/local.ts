/**
 * Local SQLite-backed ticket tracker implementation.
 *
 * @module tracker/local
 */
import type { Settings } from '../config';
import * as db from '../db';
import type {
  CreateBugInput,
  CreateTicketInput,
  Ticket,
  TicketEvent,
  TicketPatch,
  TicketStatus,
  Tracker,
} from './types';

/** Local SQLite-backed ticket tracker. */
export class LocalTracker implements Tracker {
  readonly projectKey: string;
  readonly projectName: string;
  readonly remote: boolean = false;
  protected readonly workflowRunId: number | null;

  constructor(protected readonly settings: Settings, workflowRunId: number | null = null) {
    this.projectKey = settings.ticketPrefix || 'CAREER';
    this.projectName = settings.githubProjectTitle || 'Career Team';
    this.workflowRunId = workflowRunId;
  }

  async ensureProject(): Promise<{ key: string; name: string; created: boolean; error?: string }> {
    return { key: this.projectKey, name: this.projectName, created: false };
  }

  async createTicket(input: CreateTicketInput): Promise<Ticket> {
    const ticket = db.withSession(this.settings.dbPath, (conn) =>
      db.createTicket(conn, {
        workflowRunId: this.workflowRunId,
        projectKey: this.projectKey,
        type: input.type,
        title: input.title,
        description: input.description ?? '',
        status: input.status ?? 'todo',
        assignee: input.assignee ?? '',
        reporter: input.reporter ?? 'product_manager',
        parentKey: input.parentKey ?? null,
        labels: input.labels ?? [],
      }),
    );
    return ticket as Ticket;
  }

  async createBug(input: CreateBugInput): Promise<Ticket> {
    const labels = [...(input.labels ?? []), 'bug', `severity:${input.severity ?? 'major'}`];
    if (input.area) labels.push(`area:${input.area}`);
    const bug = await this.createTicket({
      type: 'bug',
      title: input.title,
      description: input.description,
      status: input.status ?? 'team_review',
      assignee: input.assignee ?? 'team_lead',
      reporter: 'qa',
      parentKey: input.parentKey ?? null,
      labels,
    });
    if (input.parentKey) await this.link(input.parentKey, bug.key);
    return bug;
  }

  async get(key: string): Promise<Ticket | null> {
    return db.withSession(this.settings.dbPath, (conn) => db.getTicket(conn, key)) as Ticket | null;
  }

  async list(workflowRunId: number | null = this.workflowRunId): Promise<Ticket[]> {
    return db.withSession(this.settings.dbPath, (conn) =>
      db.listTickets(conn, workflowRunId),
    ) as Ticket[];
  }

  async events(key: string): Promise<TicketEvent[]> {
    return db.withSession(this.settings.dbPath, (conn) =>
      db.listTicketEvents(conn, key),
    ) as TicketEvent[];
  }

  async update(key: string, patch: TicketPatch): Promise<Ticket | null> {
    const fields: Record<string, unknown> = {};
    if (patch.status !== undefined) fields.status = patch.status;
    if (patch.assignee !== undefined) fields.assignee = patch.assignee;
    if (patch.description !== undefined) fields.description = patch.description;
    if (patch.evidence !== undefined) fields.evidence = patch.evidence;
    if (patch.labels !== undefined) fields.labels_json = patch.labels;
    if (patch.syncError !== undefined) fields.sync_error = patch.syncError;
    if (patch.externalKey !== undefined) fields.external_key = patch.externalKey;
    if (patch.externalUrl !== undefined) fields.external_url = patch.externalUrl;
    return db.withSession(this.settings.dbPath, (conn) =>
      db.updateTicketRecord(conn, key, fields),
    ) as Ticket | null;
  }

  async transition(
    key: string,
    status: TicketStatus,
    assignee?: string,
    comment?: string,
  ): Promise<Ticket | null> {
    const ticket = await this.update(key, {
      status,
      ...(assignee !== undefined ? { assignee } : {}),
    });
    if (!ticket) return null;
    await this.comment(
      key,
      comment ||
        `Status → ${status}${assignee ? `; assigned to ${assignee}` : ''}.`,
      assignee || 'system',
    );
    return ticket;
  }

  async assign(key: string, assignee: string, comment?: string): Promise<Ticket | null> {
    const ticket = await this.update(key, { assignee });
    if (!ticket) return null;
    await this.comment(key, comment || `Assigned to ${assignee}.`, assignee);
    return ticket;
  }

  async comment(key: string, body: string, actor = 'system'): Promise<void> {
    db.withSession(this.settings.dbPath, (conn) => {
      db.addTicketEvent(conn, key, 'comment', actor, body);
    });
  }

  async link(parentKey: string, childKey: string): Promise<void> {
    const parent = await this.get(parentKey);
    const child = await this.get(childKey);
    if (!parent || !child) return;
    const parentLinks = new Set([...(parent.links ?? []), childKey]);
    const childLinks = new Set([...(child.links ?? []), parentKey]);
    db.withSession(this.settings.dbPath, (conn) => {
      db.updateTicketRecord(conn, parentKey, { links_json: [...parentLinks] });
      db.updateTicketRecord(conn, childKey, { links_json: [...childLinks] });
      db.addTicketEvent(conn, parentKey, 'link', 'system', `Linked to ${childKey}`);
      db.addTicketEvent(conn, childKey, 'link', 'system', `Linked to ${parentKey}`);
    });
  }

  async close(key: string, evidence: string): Promise<Ticket | null> {
    const ticket = await this.update(key, { status: 'done', evidence });
    if (!ticket) return null;
    await this.comment(key, `Closed with evidence:\n\n${evidence}`, 'qa');
    return ticket;
  }
}
