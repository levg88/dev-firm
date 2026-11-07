/**
 * Factory selecting a local or GitHub-backed tracker from settings.
 *
 * @module tracker/index
 */
import type { Settings } from '../config';
import { GitHubTracker } from './github';
import { LocalTracker } from './local';
import type { Tracker } from './types';

/** Create a tracker based on settings. */
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
