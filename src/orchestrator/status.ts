/**
 * @fileoverview Build status reporter.
 *
 * {@link BuildStatusReporter} periodically posts a tech-lead status update
 * (phase, tickets/owners, ETA) as a comment and artifact, without ever
 * throwing into the build.
 */

import type { Ticket, Tracker } from '../tracker';

export type StatusArtifactWriter = (name: string, content: string) => void;

export interface StatusSnapshot {
  phase: string;
  label: string;
  detail?: string;
  iteration?: number;
  maxIterations?: number;
}

const STATUS_ORDER: Record<string, number> = {
  qa: 0,
  in_review: 1,
  in_progress: 2,
  blocked: 3,
  team_review: 4,
  design: 5,
  todo: 6,
  done: 7,
};

/**
 * Posts a tech-lead status update every N minutes (default 10): phase, current
 * tickets and owners, and a rough ETA. It never throws into the build.
 */
export class BuildStatusReporter {
  private timer: NodeJS.Timeout | null = null;
  private startedAt = Date.now();
  private snapshot: StatusSnapshot = { phase: 'starting', label: 'Build starting' };
  private lastReportAt = 0;

  constructor(
    private readonly workflowId: number,
    private readonly title: string,
    private readonly tracker: Tracker,
    private readonly epicKey: string,
    private readonly maxIterations: number,
    private readonly writeArtifact: StatusArtifactWriter,
  ) {}

  start(): void {
    this.startedAt = Date.now();
    const minutes = Number(process.env.DEV_FIRM_STATUS_INTERVAL_MINUTES ?? 10);
    const interval = Math.max(1, Number.isFinite(minutes) ? minutes : 10) * 60_000;
    this.timer = setInterval(() => {
      void this.report('scheduled');
    }, interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setPhase(
    phase: string,
    label: string,
    extra: { detail?: string; iteration?: number; maxIterations?: number } = {},
  ): void {
    this.snapshot = { phase, label, ...extra };
  }

  async report(reason = 'manual'): Promise<string> {
    try {
      const tickets = await this.tracker.list(this.workflowId);
      const markdown = this.render(tickets, reason);
      this.lastReportAt = Date.now();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      this.writeArtifact('status.md', markdown);
      this.writeArtifact(`status/status_${stamp}.md`, markdown);
      try {
        await this.tracker.comment(this.epicKey, markdown, 'team_lead');
      } catch {
        // GitHub may be unavailable; the local board and artifact still have it.
      }
      process.stdout.write(
        `[status] build #${this.workflowId} ${this.snapshot.label} ` +
          `(${tickets.filter((ticket) => ticket.status !== 'done').length} open tickets)\n`,
      );
      return markdown;
    } catch {
      return '';
    }
  }

  private render(tickets: Ticket[], reason: string): string {
    const elapsedMin = Math.max(0, Math.round((Date.now() - this.startedAt) / 60_000));
    const active = tickets
      .filter((ticket) => ticket.type !== 'epic')
      .sort(
        (a, b) =>
          (STATUS_ORDER[String(a.status)] ?? 9) - (STATUS_ORDER[String(b.status)] ?? 9) ||
          a.key.localeCompare(b.key),
      );
    const done = tickets.filter((ticket) => ticket.status === 'done').length;
    const open = tickets.filter((ticket) => ticket.status !== 'done' && ticket.type !== 'epic').length;
    const eta = this.estimateRemainingMinutes();

    const rows = active.length
      ? active
          .map((ticket) => {
            const title = ticket.external_url
              ? `[${escapeCell(ticket.title)}](${ticket.external_url})`
              : escapeCell(ticket.title);
            return `| ${ticket.key} | ${title} | ${ticket.status} | ${ticket.assignee || 'unassigned'} |`;
          })
          .join('\n')
      : '| — | No tasks yet | — | — |';

    const iterationLine =
      this.snapshot.iteration !== undefined
        ? `- Iteration: ${this.snapshot.iteration}/${this.snapshot.maxIterations ?? this.maxIterations}`
        : `- Delivery iterations allowed: ${this.maxIterations}`;

    return [
      `## Tech lead status — build #${this.workflowId} “${this.title}”`,
      '',
      `- Update: ${reason} (every ${process.env.DEV_FIRM_STATUS_INTERVAL_MINUTES ?? 10} min)`,
      `- Elapsed: ${elapsedMin} min`,
      `- Phase: ${this.snapshot.label}${this.snapshot.detail ? ` — ${this.snapshot.detail}` : ''}`,
      iterationLine,
      `- Tickets: ${done} done, ${open} open`,
      `- ETA to finish: ~${eta.min}–${eta.max} min (rough estimate)`,
      '',
      '### Current tickets and owners',
      '',
      '| Ticket | Title | Status | Assignee |',
      '| --- | --- | --- | --- |',
      rows,
      '',
      '_Estimate is based on the current phase and elapsed time; it is not a promise._',
    ].join('\n');
  }

  private estimateRemainingMinutes(): { min: number; max: number } {
    const phase = this.snapshot.phase;
    if (phase === 'done') return { min: 0, max: 2 };
    if (phase === 'blocked') return { min: 0, max: 0 };

    const elapsedMin = Math.max(0, (Date.now() - this.startedAt) / 60_000);
    // Observed local-model timings: PM/architect/design ~12 min, each delivery
    // loop (developers + tech lead + QA) ~20-25 min, plus a bug-fix loop often.
    const expectedPreDev = 12;
    const expectedPerIteration = 22;
    const expectedIterations = Math.max(2, this.snapshot.iteration ?? 0);
    const expectedTotal = expectedPreDev + expectedPerIteration * expectedIterations;
    const remaining = Math.max(2, Math.round(expectedTotal - elapsedMin));
    return { min: remaining, max: Math.max(remaining + 5, Math.round(remaining * 1.5)) };
  }

  get lastReport(): number {
    return this.lastReportAt;
  }
}

function escapeCell(value: string): string {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
