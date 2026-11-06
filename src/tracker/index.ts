import type { Settings } from '../config';
import { GitHubTracker } from './github';
import { LocalTracker } from './local';
import type { Tracker } from './types';

export function createTracker(settings: Settings, workflowRunId: number | null = null): Tracker {
  if (settings.githubConfigured) {
    return new GitHubTracker(settings, workflowRunId);
  }
  return new LocalTracker(settings, workflowRunId);
}

export { GitHubTracker, LocalTracker };
export type {
  CreateBugInput,
  CreateTicketInput,
  Ticket,
  TicketEvent,
  TicketPatch,
  TicketStatus,
  Tracker,
} from './types';
