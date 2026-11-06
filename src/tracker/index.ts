import type { Settings } from '../config';
import { JiraTracker } from './jira';
import { LocalTracker } from './local';
import type { Tracker } from './types';

export function createTracker(settings: Settings, workflowRunId: number | null = null): Tracker {
  if (settings.jiraEnabled && settings.jiraEmail && settings.jiraApiToken) {
    return new JiraTracker(settings, workflowRunId);
  }
  return new LocalTracker(settings, workflowRunId);
}

export { JiraTracker, LocalTracker };
export type {
  CreateBugInput,
  CreateTicketInput,
  Ticket,
  TicketEvent,
  TicketPatch,
  TicketStatus,
  Tracker,
} from './types';
