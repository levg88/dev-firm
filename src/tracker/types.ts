/**
 * Type definitions for the ticket tracker abstraction (local + GitHub).
 *
 * @module tracker/types
 */
import type { AgentRole, TaskArea, DeveloperRole } from '../models';

/** TicketType type. */
export type TicketType = 'epic' | 'story' | 'task' | 'bug';

/** TicketStatus type. */
export type TicketStatus =
  | 'todo'
  | 'design'
  | 'team_review'
  | 'in_progress'
  | 'in_review'
  | 'qa'
  | 'done'
  | 'blocked';

/** Ticket interface. */
export interface Ticket {
  id: number;
  key: string;
  external_key?: string | null;
  external_url?: string | null;
  workflow_run_id?: number | null;
  project_key: string;
  type: TicketType | string;
  title: string;
  description: string;
  status: TicketStatus | string;
  assignee: AgentRole | string;
  reporter: string;
  parent_key?: string | null;
  labels: string[];
  links: string[];
  evidence?: string | null;
  sync_error?: string | null;
  created_at: string;
  updated_at: string;
}

/** TicketEvent interface. */
export interface TicketEvent {
  id: number;
  ticket_key: string;
  event: string;
  actor: string;
  body: string;
  created_at: string;
}

/** CreateTicketInput interface. */
export interface CreateTicketInput {
  type: TicketType;
  title: string;
  description?: string;
  status?: TicketStatus;
  assignee?: AgentRole | '';
  reporter?: AgentRole;
  parentKey?: string | null;
  labels?: string[];
}

/** CreateBugInput interface. */
export interface CreateBugInput {
  title: string;
  description: string;
  severity?: string;
  area?: TaskArea;
  parentKey?: string | null;
  assignee?: AgentRole;
  status?: TicketStatus;
  labels?: string[];
}

/** TicketPatch interface. */
export interface TicketPatch {
  status?: TicketStatus;
  assignee?: string;
  description?: string;
  evidence?: string | null;
  labels?: string[];
  syncError?: string | null;
  externalKey?: string | null;
  externalUrl?: string | null;
}

/** Tracker interface. */
export interface Tracker {
  readonly projectKey: string;
  readonly projectName: string;
  readonly remote: boolean;
  ensureProject(): Promise<{ key: string; name: string; created: boolean; url?: string; error?: string }>;
  createTicket(input: CreateTicketInput): Promise<Ticket>;
  createBug(input: CreateBugInput): Promise<Ticket>;
  get(key: string): Promise<Ticket | null>;
  list(workflowRunId?: number | null): Promise<Ticket[]>;
  events(key: string): Promise<TicketEvent[]>;
  update(key: string, patch: TicketPatch): Promise<Ticket | null>;
  transition(
    key: string,
    status: TicketStatus,
    assignee?: AgentRole | '',
    comment?: string,
  ): Promise<Ticket | null>;
  assign(key: string, assignee: AgentRole, comment?: string): Promise<Ticket | null>;
  comment(key: string, body: string, actor?: AgentRole | 'system'): Promise<void>;
  link(parentKey: string, childKey: string): Promise<void>;
  close(key: string, evidence: string): Promise<Ticket | null>;
}

/** TicketPlanItem interface. */
export interface TicketPlanItem {
  key: string;
  title: string;
  area: TaskArea;
  role: DeveloperRole;
  status: TicketStatus;
}
