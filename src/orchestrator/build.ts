import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { Settings } from '../config';
import * as db from '../db';
import { buildLlm, LLMClient, MockClient } from '../llm';
import {
  Architecture,
  BugSpec,
  BugTriage,
  DesignReview,
  DeveloperReport,
  ProductSpec,
  QAReport,
  TaskSpec,
  TechLeadReview,
  architectureSchema,
  bugTriageSchema,
  designReviewSchema,
  developerReportSchema,
  productSpecSchema,
  qaReportSchema,
  techLeadReviewSchema,
} from '../agents/build_schemas';
import { BuildAgents } from '../agents/build_team';
import { Sandbox } from '../agents/tools';
import type { DeveloperRole } from '../models';
import { createTracker } from '../tracker';
import type { Ticket, TicketStatus, Tracker } from '../tracker';

export interface BuildResult {
  workflow_id: number;
  workspace: string;
  mock: boolean;
  passed: boolean;
  iterations: number;
  blocked_reason: string | null;
  spec: Record<string, any>;
  architecture: Record<string, any>;
  team_lead: Record<string, any>;
  developer: Record<string, any>;
  frontend: Record<string, any>;
  tech_lead: Record<string, any>;
  qa: Record<string, any>;
  tickets: Ticket[];
}

interface WorkItem {
  key: string;
  type: 'task' | 'bug';
  task: TaskSpec;
  role: DeveloperRole;
  status: TicketStatus;
  parentKey: string | null;
}

const EMPTY_ARCHITECTURE: Architecture = architectureSchema.parse({});
const EMPTY_DESIGN_REVIEW: DesignReview = designReviewSchema.parse({
  approved: true,
  summary: '',
  assignments: [],
  issues: [],
  recommendations: [],
});
const EMPTY_QA: QAReport = qaReportSchema.parse({ passed: false, summary: '', issues: [] });
const EMPTY_REVIEW: TechLeadReview = techLeadReviewSchema.parse({
  verdict: false,
  summary: '',
  issues: [],
});
const EMPTY_TRIAGE: BugTriage = bugTriageSchema.parse({
  summary: '',
  assignments: [],
  issues: [],
});

export class BuildService {
  readonly settings: Settings;
  readonly llm: LLMClient;
  readonly agents: BuildAgents;

  constructor(settings: Settings) {
    this.settings = settings;
    this.llm = buildLlm(settings);
    this.agents = new BuildAgents(settings, this.llm);
  }

  async run(brief: string, title = '', repoPath?: string): Promise<BuildResult> {
    const workflowId = db.withSession(this.settings.dbPath, (conn) =>
      db.createWorkflow(conn, 'build', title || brief.slice(0, 80), { brief, repo_path: repoPath ?? '' }),
    );
    return this.execute(workflowId, brief, repoPath);
  }

  async execute(workflowId: number, brief: string, repoPath?: string): Promise<BuildResult> {
    const workflow = db.withSession(this.settings.dbPath, (conn) =>
      db.getWorkflow(conn, workflowId),
    );
    if (!workflow) throw new Error(`Build run ${workflowId} not found`);
    const workspace = repoPath
      ? path.resolve(repoPath)
      : String(
          workflow.workspace_path || path.join(this.settings.runsDir, "build_" + workflowId, "workspace"),
        );
    db.withSession(this.settings.dbPath, (conn) =>
      db.updateWorkflow(conn, workflowId, { status: 'running', workspace_path: workspace }),
    );
    fs.mkdirSync(workspace, { recursive: true });

    try {
      const output = this.settings.isMock || this.llm instanceof MockClient
        ? await this._mockBuild(workflowId, workspace, brief)
        : await this._realBuild(workflowId, workspace, brief);
      db.withSession(this.settings.dbPath, (conn) =>
        db.updateWorkflow(conn, workflowId, {
          status: 'done',
          output_json: JSON.stringify(output),
          finished_at: db.now(),
        }),
      );
      return {
        workflow_id: workflowId,
        workspace,
        mock: Boolean((output as Record<string, any>).mock),
        passed: Boolean((output as Record<string, any>).passed),
        iterations: Number((output as Record<string, any>).iterations ?? 0),
        blocked_reason: (output as Record<string, any>).blocked_reason ?? null,
        spec: (output as Record<string, any>).spec ?? {},
        architecture: (output as Record<string, any>).architecture ?? {},
        team_lead: (output as Record<string, any>).team_lead ?? {},
        developer: (output as Record<string, any>).developer ?? {},
        frontend: (output as Record<string, any>).frontend ?? {},
        tech_lead: (output as Record<string, any>).tech_lead ?? {},
        qa: (output as Record<string, any>).qa ?? {},
        tickets: (output as Record<string, any>).tickets ?? [],
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      db.withSession(this.settings.dbPath, (conn) =>
        db.updateWorkflow(conn, workflowId, {
          status: 'failed',
          error: `${err.name}: ${err.message}`,
          finished_at: db.now(),
        }),
      );
      throw err;
    }
  }

  private async _realBuild(
    workflowId: number,
    workspace: string,
    brief: string,
  ): Promise<Record<string, any>> {
    const sandbox = new Sandbox(workspace);
    const tracker = createTracker(this.settings, workflowId);
    const project = await tracker.ensureProject();
    const workflow = db.withSession(this.settings.dbPath, (conn) => db.getWorkflow(conn, workflowId));
    const title = String(workflow?.title || brief.slice(0, 80));

    // ── 0. validate the target project ───────────────────────────────────────
    const validation = await this._validate(workflowId, workspace, sandbox);
    const pmTask = validation
      ? `Project validation:\n${validation}\n\nBrief for the product manager:\n${brief}`
      : brief;

    // ── 1. product manager ──────────────────────────────────────────────────
    const pmResult = await this.agents.pm(pmTask, { workflowRunId: workflowId });
    const spec = productSpecSchema.parse(pmResult.data ?? {});
    const specMd = spec.markdown || this._specMarkdown(spec, brief);
    this._artifact(workflowId, workspace, 'product_spec.md', specMd);
    this._artifact(workflowId, workspace, 'product_spec.json', JSON.stringify(spec));
    this._commit(workspace, `dev-firm: product spec (${brief.slice(0, 60)})`);

    const epic = await tracker.createTicket({
      type: 'epic',
      title: `Epic: ${title}`,
      description: specMd,
      status: 'in_progress',
      assignee: 'product_manager',
      reporter: 'product_manager',
      labels: ['epic'],
    });
    const plannedTasks = this._planTasks(spec, brief);
    const items: WorkItem[] = [];
    for (const task of plannedTasks) {
      const ticket = await tracker.createTicket({
        type: 'task',
        title: task.title,
        description: this._taskDescription(task),
        status: 'design',
        assignee: 'architect',
        reporter: 'product_manager',
        parentKey: epic.key,
        labels: [`area:${task.area}`],
      });
      await tracker.comment(
        ticket.key,
        `Product requirement:\n\n${task.description}\n\nAcceptance criteria:\n${task.acceptance_criteria.map((item) => `- ${item}`).join('\n') || '- See product spec'}`,
        'product_manager',
      );
      items.push({
        key: ticket.key,
        type: 'task',
        task,
        role: this._roleForArea(task.area),
        status: 'design',
        parentKey: epic.key,
      });
    }
    await tracker.comment(
      epic.key,
      `Created ${items.length} task(s) and assigned them to the architect. Project key: ${project.key}.`,
      'product_manager',
    );
    this._ticketsArtifact(workflowId, workspace, await tracker.list());
    this._commit(workspace, `dev-firm: task breakdown (${items.length} tasks)`);

    // ── 2. architect + team lead design review ──────────────────────────────
    let architecture: Architecture = EMPTY_ARCHITECTURE;
    let designReview: DesignReview = EMPTY_DESIGN_REVIEW;
    for (let round = 1; round <= 2; round += 1) {
      try {
        const archResult = await this.agents.architect(spec, {
          workflowRunId: workflowId,
          round,
          feedback: round > 1 ? designReview.issues.join('\n') : '',
        });
        architecture = architectureSchema.parse(archResult.data ?? {});
      } catch (error) {
        if (!architecture.markdown) throw error;
        break;
      }
      const archMd = architecture.markdown || this._architectureMarkdown(architecture);
      this._artifact(workflowId, workspace, `architecture_round${round}.md`, archMd);
      this._artifact(workflowId, workspace, 'architecture.md', archMd);
      this._artifact(workflowId, workspace, 'architecture.json', JSON.stringify(architecture));
      for (const item of items) {
        await tracker.comment(
          item.key,
          `Architect design (round ${round}):\n\n${archMd.slice(0, 8000)}`,
          'architect',
        );
        await tracker.transition(
          item.key,
          'team_review',
          'team_lead',
          'Design attached. Assigned to the team lead for review.',
        );
        item.status = 'team_review';
      }

      try {
        const reviewResult = await this.agents.team_lead(spec, architecture, items, {
          workflowRunId: workflowId,
          round,
        });
        designReview = designReviewSchema.parse(reviewResult.data ?? {});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        designReview = designReviewSchema.parse({
          approved: true,
          summary: `Team lead review unavailable; proceeding. ${message}`,
          assignments: [],
          issues: [message],
        });
      }
      this._artifact(
        workflowId,
        workspace,
        `team_lead_design_review_round${round}.md`,
        this._designReviewMarkdown(designReview),
      );
      if (designReview.approved) break;
      for (const item of items) {
        await tracker.comment(
          item.key,
          `Team lead requested design changes:\n${designReview.issues.map((issue) => `- ${issue}`).join('\n')}`,
          'team_lead',
        );
      }
    }

    // Route every task to a developer.
    for (const item of items) {
      item.role = this._assignmentFor(designReview, item);
      await tracker.transition(
        item.key,
        'in_progress',
        item.role,
        `Design approved by the team lead. Assigned to ${item.role}.`,
      );
      item.status = 'in_progress';
    }
    this._ticketsArtifact(workflowId, workspace, await tracker.list());
    this._commit(workspace, `dev-firm: architecture and design review (${brief.slice(0, 50)})`);

    // ── 3. delivery loop: dev → tech lead → QA (and bug loops) ─────────────
    const maxIterations = Math.max(1, this.settings.maxBuildIterations);
    let iteration = 0;
    let passed = false;
    let blockedReason = '';
    let active: WorkItem[] = [...items];
    const allItems: WorkItem[] = [...items];
    const feedbackByRole: Record<string, string> = {};
    const reportsByRole: Record<string, DeveloperReport> = {};
    let lastReview: TechLeadReview | null = null;
    let lastQa: QAReport | null = null;

    while (iteration < maxIterations && !passed) {
      iteration += 1;
      const groups = new Map<DeveloperRole, WorkItem[]>();
      for (const item of active) {
        if (item.status === 'done') continue;
        const group = groups.get(item.role) ?? [];
        group.push(item);
        groups.set(item.role, group);
      }
      if (groups.size === 0) {
        blockedReason = 'No active tickets were assigned to a developer.';
        break;
      }

      const iterationReports: DeveloperReport[] = [];
      for (const [role, group] of groups) {
        let report: DeveloperReport;
        try {
          const result =
            role === 'frontend_developer'
              ? await this.agents.frontend_developer(spec, architecture, sandbox, {
                  feedback: feedbackByRole[role],
                  workflowRunId: workflowId,
                  iteration,
                  tickets: group,
                })
              : await this.agents.backend_developer(spec, architecture, sandbox, {
                  feedback: feedbackByRole[role],
                  workflowRunId: workflowId,
                  iteration,
                  tickets: group,
                });
          report = developerReportSchema.parse(result.data ?? {});
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          report = developerReportSchema.parse({
            summary: `${role} could not complete iteration ${iteration}.`,
            files_written: [],
            tests_run: [],
            known_issues: [message],
            tasks_completed: [],
          });
          this._artifact(workflowId, workspace, `${role}_error_iter${iteration}.md`, `# ${role} error\n\n${message}`);
        }
        reportsByRole[role] = report;
        iterationReports.push(report);
        this._artifact(
          workflowId,
          workspace,
          `${role}_report_iter${iteration}.md`,
          this._developerMarkdown(report),
        );
        if (role === 'backend_developer') {
          this._artifact(workflowId, workspace, 'developer_report.md', this._developerMarkdown(report));
          this._artifact(workflowId, workspace, 'developer_report.json', JSON.stringify(report));
        } else {
          this._artifact(workflowId, workspace, 'frontend_report.md', this._developerMarkdown(report));
          this._artifact(workflowId, workspace, 'frontend_report.json', JSON.stringify(report));
        }
        for (const item of group) {
          await tracker.transition(
            item.key,
            'in_review',
            'tech_lead',
            `${role} finished. Assigned to the tech lead for code review.`,
          );
          item.status = 'in_review';
        }
      }

      let review: TechLeadReview;
      try {
        const result = await this.agents.tech_lead(spec, architecture, iterationReports, {
          workflowRunId: workflowId,
          iteration,
          tickets: active,
          feedback: this._combinedFeedback(feedbackByRole),
        });
        review = techLeadReviewSchema.parse(result.data ?? {});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        review = techLeadReviewSchema.parse({
          verdict: true,
          summary: `Tech lead review unavailable; proceeding to QA. ${message}`,
          issues: [message],
        });
      }
      lastReview = review;
      this._artifact(
        workflowId,
        workspace,
        `tech_lead_report_iter${iteration}.md`,
        this._techLeadMarkdown(review),
      );
      this._artifact(workflowId, workspace, 'tech_lead_report.md', this._techLeadMarkdown(review));
      this._artifact(workflowId, workspace, 'tech_lead_report.json', JSON.stringify(review));

      if (!review.verdict) {
        const issues = review.issues.join('\n') || review.summary || 'Tech lead rejected the implementation.';
        for (const item of active) {
          if (item.status === 'done') continue;
          feedbackByRole[item.role] = issues;
          await tracker.transition(
            item.key,
            'in_progress',
            item.role,
            `Tech lead rejected the implementation:\n${issues}`,
          );
          item.status = 'in_progress';
        }
        this._ticketsArtifact(workflowId, workspace, await tracker.list());
        continue;
      }

      for (const item of active) {
        if (item.status === 'done') continue;
        await tracker.transition(
          item.key,
          'qa',
          'qa',
          'Tech lead approved. Assigned to QA for verification.',
        );
        item.status = 'qa';
      }

      let qa: QAReport;
      try {
        const result = await this.agents.qa(spec, architecture, sandbox, {
          workflowRunId: workflowId,
          iteration,
          tickets: active,
          feedback: this._combinedFeedback(feedbackByRole),
        });
        qa = qaReportSchema.parse(result.data ?? {});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        qa = qaReportSchema.parse({
          passed: false,
          summary: `QA agent failed: ${message}`,
          issues: [message],
          tests_run: [],
          recommendation: 'Fix the QA run and retry.',
          bugs: [
            {
              title: 'QA verification could not run',
              description: message,
              severity: 'blocker',
              area: 'backend',
              parent_task: items[0]?.task.title ?? '',
            },
          ],
        });
      }
      lastQa = qa;
      this._artifact(workflowId, workspace, `qa_report_iter${iteration}.md`, this._qaMarkdown(qa));
      this._artifact(workflowId, workspace, 'qa_report.md', this._qaMarkdown(qa));
      this._artifact(workflowId, workspace, 'qa_report.json', JSON.stringify(qa));

      if (qa.passed) {
        passed = true;
        const evidence = this._evidence(qa, iteration);
        for (const item of allItems) {
          if (item.status === 'done') continue;
          await tracker.close(item.key, evidence);
          item.status = 'done';
        }
        await tracker.close(epic.key, evidence);
        await tracker.comment(epic.key, `Delivered in ${iteration} iteration(s).`, 'system');
        break;
      }

      // QA failed: open bugs linked to the relevant task and assign to the TL.
      const bugSpecs = this._bugsFromQa(qa, active, items[0]?.key ?? epic.key);
      const bugItems: WorkItem[] = [];
      for (const bug of bugSpecs) {
        const ticket = await tracker.createBug({
          title: bug.title,
          description: bug.description,
          severity: bug.severity,
          area: bug.area,
          parentKey: bug.parentKey,
          assignee: 'team_lead',
          status: 'team_review',
          labels: ['qa', 'iteration:' + iteration],
        });
        await tracker.comment(
          ticket.key,
          `QA opened this bug in iteration ${iteration}.\n\nSummary: ${qa.summary}\n\nEvidence:\n${this._evidence(qa, iteration)}`,
          'qa',
        );
        bugItems.push({
          key: ticket.key,
          type: 'bug',
          task: {
            title: bug.title,
            description: bug.description,
            area: bug.area,
            acceptance_criteria: [],
          },
          role: this._roleForArea(bug.area),
          status: 'team_review',
          parentKey: bug.parentKey,
        });
      }
      if (!bugSpecs.length) {
        bugItems.push(
          await this._createFallbackBug(tracker, qa, items[0]?.key ?? epic.key, iteration),
        );
      }
      allItems.push(...bugItems);

      let triage: BugTriage;
      try {
        const result = await this.agents.triage(
          spec,
          qa,
          bugItems.map((item) => ({
            key: item.key,
            bug: {
              title: item.task.title,
              description: item.task.description,
              severity: 'major' as const,
              area: item.task.area,
              parent_task: item.parentKey ?? '',
            },
          })),
          {
            workflowRunId: workflowId,
            iteration,
          },
        );
        triage = bugTriageSchema.parse(result.data ?? {});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        triage = bugTriageSchema.parse({
          summary: `Team lead triage unavailable; defaulting bugs to backend. ${message}`,
          assignments: [],
          issues: [message],
        });
      }
      this._artifact(
        workflowId,
        workspace,
        `bug_triage_iter${iteration}.md`,
        this._triageMarkdown(triage),
      );
      for (const bug of bugItems) {
        const role = this._assignmentFor(triage, bug);
        bug.role = role;
        await tracker.transition(
          bug.key,
          'in_progress',
          role,
          `Team lead triaged the bug and assigned it to ${role}.`,
        );
        bug.status = 'in_progress';
        feedbackByRole[role] = qa.issues.join('\n') || qa.summary;
      }
      active = bugItems;
      this._ticketsArtifact(workflowId, workspace, await tracker.list());
      this._commit(workspace, `dev-firm: QA iteration ${iteration} (${bugItems.length} bugs)`);
    }

    if (!passed) {
      blockedReason =
        blockedReason ||
        `QA did not pass within ${maxIterations} iteration(s). Open tickets remain in the tracker.`;
      await tracker.comment(epic.key, `BLOCKED: ${blockedReason}`, 'system');
      await tracker.transition(epic.key, 'blocked', 'product_manager', blockedReason);
      this._artifact(
        workflowId,
        workspace,
        'blocked_report.md',
        `# Blocked after ${iteration} iteration(s)\n\n${blockedReason}\n\n` +
          (lastQa ? this._qaMarkdown(lastQa) : ''),
      );
    }

    const tickets = await tracker.list();
    this._ticketsArtifact(workflowId, workspace, tickets);
    this._commit(workspace, `dev-firm: build (${brief.slice(0, 60)})`);

    return {
      project,
      passed,
      iterations: iteration,
      blocked_reason: blockedReason || null,
      tickets,
      spec: JSON.parse(JSON.stringify(spec)),
      architecture: JSON.parse(JSON.stringify(architecture)),
      team_lead: JSON.parse(JSON.stringify(designReview)),
      developer: JSON.parse(JSON.stringify(reportsByRole.backend_developer ?? {})),
      frontend: JSON.parse(JSON.stringify(reportsByRole.frontend_developer ?? {})),
      tech_lead: JSON.parse(JSON.stringify(lastReview ?? EMPTY_REVIEW)),
      qa: JSON.parse(JSON.stringify(lastQa ?? EMPTY_QA)),
    };
  }

  private async _mockBuild(
    workflowId: number,
    workspace: string,
    brief: string,
  ): Promise<Record<string, any>> {
    const spec: ProductSpec = productSpecSchema.parse({
      markdown:
        '# Mock product spec\n\n' +
        `**Brief:** ${brief}\n\n` +
        'No model provider is configured. This placeholder demonstrates the pipeline; ' +
        'choose a provider in Settings to generate a real spec and implementation.',
      summary: brief,
      user_stories: ['Configure a model provider', 'Run the build again'],
      acceptance_criteria: ['Configure a model provider', 'Run the build again'],
      non_goals: ['Producing production code without a model'],
      risks: ['Offline mock output is not a substitute for the real pipeline'],
      tasks: [
        {
          title: 'Configure a model provider',
          description: 'Choose a provider and rerun the build team.',
          area: 'backend',
          acceptance_criteria: ['A provider is configured'],
        },
      ],
    });
    const architecture: Architecture = architectureSchema.parse({
      markdown: '# Mock architecture\n\nThe real architect agent runs when a provider is configured.',
      stack: ['mock'],
      files: [],
      data_model: '',
      api: '',
      test_plan: ['Configure a provider and rerun'],
      risks: ['Offline mock output is not a substitute for the real pipeline'],
    });
    const developer: DeveloperReport = developerReportSchema.parse({
      summary: 'Mock build only; no code was written.',
      files_written: [],
      tests_run: [],
      known_issues: [],
      tasks_completed: [],
    });
    const teamLead: DesignReview = designReviewSchema.parse({
      approved: true,
      summary: 'Mock design review passed.',
      assignments: [],
      issues: [],
    });
    const techLead: TechLeadReview = techLeadReviewSchema.parse({
      verdict: true,
      summary: 'Mock tech lead review passed.',
      issues: [],
    });
    const qa: QAReport = qaReportSchema.parse({
      passed: true,
      summary: 'Mock pipeline completed. Configure a provider for real output.',
      issues: [],
      tests_run: [],
      recommendation: '',
      evidence: ['Offline mock mode'],
      bugs: [],
    });

    const tracker = createTracker(this.settings, workflowId);
    const project = await tracker.ensureProject();
    const epic = await tracker.createTicket({
      type: 'epic',
      title: `Epic: ${brief.slice(0, 60)}`,
      description: String(spec.markdown),
      status: 'in_progress',
      assignee: 'product_manager',
      labels: ['epic', 'mock'],
    });
    const ticket = await tracker.createTicket({
      type: 'task',
      title: spec.tasks[0]?.title ?? 'Mock task',
      description: String(spec.markdown),
      status: 'done',
      assignee: 'team_lead',
      parentKey: epic.key,
      labels: ['area:backend', 'mock'],
    });
    await tracker.close(ticket.key, 'Offline mock mode: pipeline completed without a model.');
    await tracker.close(epic.key, 'Offline mock mode: pipeline completed without a model.');

    this._artifact(workflowId, workspace, 'product_spec.md', String(spec.markdown));
    this._artifact(workflowId, workspace, 'product_spec.json', JSON.stringify(spec));
    this._artifact(workflowId, workspace, 'architecture.md', String(architecture.markdown));
    this._artifact(workflowId, workspace, 'architecture.json', JSON.stringify(architecture));
    this._artifact(workflowId, workspace, 'developer_report.md', this._developerMarkdown(developer));
    this._artifact(
      workflowId,
      workspace,
      'team_lead_design_review_round1.md',
      this._designReviewMarkdown(teamLead),
    );
    this._artifact(workflowId, workspace, 'tech_lead_report.md', this._techLeadMarkdown(techLead));
    this._artifact(workflowId, workspace, 'tech_lead_report.json', JSON.stringify(techLead));
    this._artifact(workflowId, workspace, 'qa_report.md', this._qaMarkdown(qa));
    const tickets = await tracker.list();
    this._ticketsArtifact(workflowId, workspace, tickets);
    return {
      mock: true,
      project,
      passed: true,
      iterations: 0,
      blocked_reason: null,
      tickets,
      spec,
      architecture,
      team_lead: teamLead,
      developer,
      frontend: {},
      tech_lead: techLead,
      qa,
    };
  }

  private async _createFallbackBug(
    tracker: Tracker,
    qa: QAReport,
    parentKey: string,
    iteration: number,
  ): Promise<WorkItem> {
    const ticket = await tracker.createBug({
      title: `QA failure in iteration ${iteration}`,
      description: qa.issues.join('\n') || qa.summary || 'QA failed without a detailed issue list.',
      severity: 'major',
      area: 'backend',
      parentKey,
      assignee: 'team_lead',
      status: 'team_review',
      labels: ['qa', 'iteration:' + iteration],
    });
    return {
      key: ticket.key,
      type: 'bug',
      task: {
        title: ticket.title,
        description: ticket.description,
        area: 'backend',
        acceptance_criteria: [],
      },
      role: 'backend_developer',
      status: 'team_review',
      parentKey,
    };
  }

  private _planTasks(spec: ProductSpec, brief: string): TaskSpec[] {
    const provided = (spec.tasks ?? []).filter((task) => task.title.trim());
    if (provided.length) return provided;

    const acceptance = spec.acceptance_criteria ?? [];
    const wantsFrontend = /\b(web|ui|frontend|front-end|page|dashboard|browser|html|css|react|vue|svelte)\b/i.test(
      brief,
    );
    if (wantsFrontend) {
      return [
        productSpecTask(
          `Backend/API for: ${spec.summary || brief.slice(0, 70)}`,
          `Implement the server, data layer, API, CLI, and persistence described in the product spec.\n\n${spec.markdown}`,
          'backend',
          acceptance,
        ),
        productSpecTask(
          `Frontend/UI for: ${spec.summary || brief.slice(0, 70)}`,
          `Implement the user interface, templates, client behaviour, and styling described in the product spec. Integrate with the backend API.\n\n${spec.markdown}`,
          'frontend',
          acceptance,
        ),
      ];
    }
    return [
      productSpecTask(
        spec.summary || brief.slice(0, 70) || 'Implement the product',
        spec.markdown || brief,
        /\b(frontend|ui|web)\b/i.test(brief) ? 'fullstack' : 'backend',
        acceptance,
      ),
    ];
  }

  private _taskDescription(task: TaskSpec): string {
    return [
      task.description,
      '',
      'Acceptance criteria:',
      ...(task.acceptance_criteria.length
        ? task.acceptance_criteria.map((item) => `- ${item}`)
        : ['- See the product spec']),
    ].join('\n');
  }

  private _roleForArea(area: string): DeveloperRole {
    return area === 'frontend' ? 'frontend_developer' : 'backend_developer';
  }

  private _assignmentFor(
    review: DesignReview | BugTriage | null,
    item: WorkItem,
  ): DeveloperRole {
    const assignments = review?.assignments ?? [];
    const key = item.key.toLowerCase();
    const title = item.task.title.toLowerCase();
    for (const assignment of assignments) {
      const target = assignment.task.trim().toLowerCase();
      if (!target) continue;
      if (
        target === key ||
        target.includes(key) ||
        key.includes(target) ||
        (title && (target.includes(title) || title.includes(target)))
      ) {
        return assignment.developer;
      }
    }
    if (assignments.length === 1) return assignments[0].developer;
    return this._roleForArea(item.task.area);
  }

  private _bugsFromQa(
    qa: QAReport,
    active: WorkItem[],
    fallbackParent: string,
  ): Array<BugSpec & { parentKey: string }> {
    const source: BugSpec[] = qa.bugs?.length
      ? qa.bugs
      : (qa.issues.length ? qa.issues : [qa.summary || 'QA failed']).map((issue) =>
          bugSchemaFromIssue(issue),
        );
    const original = active.find((item) => item.type === 'task');
    const defaultParent = original?.key ?? active[0]?.key ?? fallbackParent;
    return source.slice(0, 8).map((bug) => {
      let parentKey = defaultParent;
      const target = bug.parent_task.trim().toLowerCase();
      if (target) {
        const match = active.find(
          (item) =>
            item.key.toLowerCase() === target ||
            item.task.title.toLowerCase() === target ||
            target.includes(item.task.title.toLowerCase()) ||
            item.task.title.toLowerCase().includes(target),
        );
        if (match) parentKey = match.key;
      }
      return { ...bug, parentKey };
    });
  }

  private _combinedFeedback(feedback: Record<string, string>): string {
    return Object.entries(feedback)
      .filter(([, value]) => value.trim())
      .map(([role, value]) => `${role}: ${value}`)
      .join('\n\n');
  }

  private _evidence(qa: QAReport, iteration: number): string {
    const parts = [
      `QA passed in iteration ${iteration}.`,
      qa.summary,
      '',
      'Tests run:',
      ...(qa.tests_run.length ? qa.tests_run.map((item) => `- ${item}`) : ['- See QA report']),
      '',
      'Evidence:',
      ...(qa.evidence.length ? qa.evidence.map((item) => `- ${item}`) : ['- QA signed off']),
    ];
    return parts.join('\n');
  }

  private async _validate(workflowId: number, workspace: string, sandbox: Sandbox): Promise<string> {
    const pkgPath = path.join(workspace, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      const validation =
        '# Project validation\n\nNo package.json found in the workspace; skipping build/test validation.';
      this._artifact(workflowId, workspace, 'validation.md', validation);
      return validation;
    }
    const sections: string[] = [];
    for (const script of ['typecheck', 'build', 'test']) {
      const result = await sandbox.runCommand({ command: `npm run ${script}`, timeout: 120000 });
      const ok = (result as Record<string, any>).ok === true;
      const detail = ok
        ? String((result as Record<string, any>).stdout ?? '')
        : String(
            (result as Record<string, any>).error ??
              (result as Record<string, any>).stderr ??
              (result as Record<string, any>).stdout ??
              '',
          );
      sections.push(`### npm run ${script}\nstatus: ${ok ? 'ok' : 'failed'}\n${detail.slice(0, 3000)}`);
    }
    const validation = [`# Project validation\n`, ...sections].join('\n\n');
    this._artifact(workflowId, workspace, 'validation.md', validation);
    return validation;
  }

  private _commit(workspace: string, message: string): void {
    try {
      execFileSync('git', ['add', '-A'], { cwd: workspace, stdio: 'ignore', timeout: 30000 });
      execFileSync('git', ['commit', '-m', message], { cwd: workspace, stdio: 'ignore', timeout: 60000 });
    } catch {
      // Best effort: the workspace may not be a git repository.
    }
  }

  private _artifact(workflowId: number, workspace: string, name: string, content: string): void {
    const target = path.join(workspace, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    db.withSession(this.settings.dbPath, (conn) =>
      db.saveArtifact(
        conn,
        workflowId,
        null,
        name,
        name.endsWith('.md') ? 'markdown' : 'json',
        content.slice(0, 200000),
        target,
      ),
    );
  }

  private _ticketsArtifact(workflowId: number, workspace: string, tickets: Ticket[]): void {
    this._artifact(workflowId, workspace, 'tickets.md', this._ticketsMarkdown(tickets));
    this._artifact(workflowId, workspace, 'tickets.json', JSON.stringify(tickets, null, 2));
  }

  private _specMarkdown(spec: ProductSpec, brief: string): string {
    const parts: string[] = [`# Product spec\n\n**Brief:** ${brief}\n`, spec.summary, '\n## User stories'];
    parts.push(...spec.user_stories.map((item: string) => `- ${item}`));
    parts.push('\n## Acceptance criteria');
    parts.push(...spec.acceptance_criteria.map((item: string) => `- ${item}`));
    parts.push('\n## Non-goals');
    parts.push(...spec.non_goals.map((item: string) => `- ${item}`));
    parts.push('\n## Risks');
    parts.push(...spec.risks.map((item: string) => `- ${item}`));
    parts.push('\n## Tasks');
    parts.push(...spec.tasks.map((task) => `- ${task.title} (${task.area})`));
    return parts.join('\n');
  }

  private _architectureMarkdown(architecture: Architecture): string {
    const parts: string[] = ['# Architecture\n', '## Stack'];
    parts.push(...architecture.stack.map((item: string) => `- ${item}`));
    parts.push('\n## Files');
    parts.push(
      ...architecture.files.map(
        (file: { path: string; purpose: string }) => `- \`${file.path}\` — ${file.purpose}`,
      ),
    );
    parts.push('\n## Data model', architecture.data_model, '\n## Interfaces', architecture.api);
    parts.push('\n## Test plan');
    parts.push(...architecture.test_plan.map((item: string) => `- ${item}`));
    parts.push('\n## Risks');
    parts.push(...architecture.risks.map((item: string) => `- ${item}`));
    return parts.join('\n');
  }

  private _developerMarkdown(report: DeveloperReport): string {
    const parts: string[] = ['# Developer report\n', report.summary, '\n## Files written'];
    parts.push(...report.files_written.map((item: string) => `- \`${item}\``));
    parts.push('\n## Tests run');
    parts.push(...report.tests_run.map((item: string) => `- ${item}`));
    parts.push('\n## Known issues');
    parts.push(...report.known_issues.map((item: string) => `- ${item}`));
    parts.push('\n## Tasks completed');
    parts.push(...report.tasks_completed.map((item: string) => `- ${item}`));
    return parts.join('\n');
  }

  private _techLeadMarkdown(report: TechLeadReview): string {
    const verdict = report.verdict ? 'PASS' : 'FAIL';
    const parts: string[] = [
      `# Tech lead review\n\n**Verdict:** ${verdict}\n`,
      report.summary,
      '\n## Issues',
    ];
    parts.push(...report.issues.map((item) => `- ${item}`));
    return parts.join('\n');
  }

  private _qaMarkdown(report: QAReport): string {
    const verdict = report.passed ? 'PASS' : 'FAIL';
    const parts: string[] = [
      `# QA report\n\n**Verdict:** ${verdict}\n`,
      report.summary,
      '\n## Tests run',
    ];
    parts.push(...report.tests_run.map((item) => `- ${item}`));
    parts.push('\n## Issues');
    parts.push(...report.issues.map((item) => `- ${item}`));
    parts.push('\n## Bugs opened');
    parts.push(...report.bugs.map((bug) => `- [${bug.severity}] ${bug.title} (${bug.area})`));
    parts.push('\n## Evidence');
    parts.push(...report.evidence.map((item) => `- ${item}`));
    parts.push('\n## Recommendation', report.recommendation);
    return parts.join('\n');
  }

  private _designReviewMarkdown(review: DesignReview): string {
    const parts: string[] = [
      `# Team lead design review\n\n**Approved:** ${review.approved ? 'yes' : 'no'}\n`,
      review.summary,
      '\n## Assignments',
    ];
    parts.push(
      ...review.assignments.map(
        (assignment) => `- ${assignment.task} → ${assignment.developer}${assignment.notes ? ` (${assignment.notes})` : ''}`,
      ),
    );
    parts.push('\n## Issues');
    parts.push(...review.issues.map((item) => `- ${item}`));
    parts.push('\n## Recommendations');
    parts.push(...review.recommendations.map((item) => `- ${item}`));
    return parts.join('\n');
  }

  private _triageMarkdown(triage: BugTriage): string {
    const parts: string[] = ['# Bug triage\n', triage.summary, '\n## Assignments'];
    parts.push(
      ...triage.assignments.map(
        (assignment) => `- ${assignment.task} → ${assignment.developer}${assignment.notes ? ` (${assignment.notes})` : ''}`,
      ),
    );
    parts.push('\n## Issues');
    parts.push(...triage.issues.map((item) => `- ${item}`));
    return parts.join('\n');
  }

  private _ticketsMarkdown(tickets: Ticket[]): string {
    const parts: string[] = [
      '# Task tracker',
      '',
      '| Key | Type | Title | Status | Assignee | Parent | Jira |',
      '|---|---|---|---|---|---|---|',
    ];
    for (const ticket of tickets) {
      parts.push(
        `| ${ticket.key} | ${ticket.type} | ${String(ticket.title).replace(/\|/g, '\\|')} | ${ticket.status} | ${ticket.assignee || '—'} | ${ticket.parent_key || '—'} | ${ticket.jira_key || '—'} |`,
      );
    }
    return parts.join('\n');
  }
}

function productSpecTask(
  title: string,
  description: string,
  area: 'backend' | 'frontend' | 'fullstack' | 'docs' | 'infra',
  acceptance: string[],
): TaskSpec {
  return {
    title,
    description,
    area,
    acceptance_criteria: acceptance,
  };
}

function bugSchemaFromIssue(issue: string): BugSpec {
  return {
    title: issue.slice(0, 120),
    description: issue,
    severity: 'major',
    area: 'backend',
    parent_task: '',
  };
}
