import type { AgentRole, TaskArea, DeveloperRole } from '../models';

export type TicketType = 'epic' | 'story' | 'task' | 'bug';

export type TicketStatus =
  | 'todo'
  | 'design'
  | 'team_review'
  | 'in_progress'
  | 'in_review'
  | 'qa'
  | 'done'
  | 'blocked';

export interface Ticket {
  id: number;
  key: string;
  jira_key?: string | null;
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

export interface TicketEvent {
  id: number;
  ticket_key: string;
  event: string;
  actor: string;
  body: string;
  created_at: string;
}

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

export interface TicketPatch {
  status?: TicketStatus;
  assignee?: string;
  description?: string;
  evidence?: string | null;
  labels?: string[];
  syncError?: string | null;
  jiraKey?: string | null;
}

export interface Tracker {
  readonly projectKey: string;
  readonly projectName: string;
  readonly remote: boolean;
  ensureProject(): Promise<{ key: string; name: string; created: boolean; error?: string }>;
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

export interface TicketPlanItem {
  key: string;
  title: string;
  area: TaskArea;
  role: DeveloperRole;
  status: TicketStatus;
}
