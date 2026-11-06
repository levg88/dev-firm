import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { Settings } from '../config';
import * as db from '../db';
import { buildLlm, LLMClient, MockClient } from '../llm';
import {
  Architecture,
  DeveloperReport,
  ProductSpec,
  QAReport,
  TechLeadReview,
  architectureSchema,
  developerReportSchema,
  productSpecSchema,
  qaReportSchema,
  techLeadReviewSchema,
} from '../agents/build_schemas';
import { AgentResult } from '../agents/base';
import { BuildAgents } from '../agents/build_team';
import { Sandbox } from '../agents/tools';

export interface BuildResult {
  workflow_id: number;
  workspace: string;
  mock: boolean;
  spec: Record<string, any>;
  architecture: Record<string, any>;
  developer: Record<string, any>;
  tech_lead: Record<string, any>;
  qa: Record<string, any>;
}

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
        ? this._mockBuild(workflowId, workspace, brief)
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
        spec: (output as Record<string, any>).spec ?? {},
        architecture: (output as Record<string, any>).architecture ?? {},
        developer: (output as Record<string, any>).developer ?? {},
        tech_lead: (output as Record<string, any>).tech_lead ?? {},
        qa: (output as Record<string, any>).qa ?? {},
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

  private async _realBuild(workflowId: number, workspace: string, brief: string): Promise<Record<string, any>> {
    const sandbox = new Sandbox(workspace);
    const validation = await this._validate(workflowId, workspace, sandbox);
    const pmTask = validation ? `Project validation:\n${validation}\n\nBrief for the product manager:\n${brief}` : brief;
    const pmResult = await this.agents.pm(pmTask, { workflowRunId: workflowId });
    const spec = productSpecSchema.parse(pmResult.data ?? {});
    const specMd = spec.markdown || this._specMarkdown(spec, brief);
    this._artifact(workflowId, workspace, 'product_spec.md', specMd);
    this._artifact(workflowId, workspace, 'product_spec.json', JSON.stringify(spec));
    this._commit(workspace, `dev-firm: product spec (${brief.slice(0, 60)})`);

    const archResult = await this.agents.architect(spec, { workflowRunId: workflowId });
    const architecture = architectureSchema.parse(archResult.data ?? {});
    const archMd = architecture.markdown || this._architectureMarkdown(architecture);
    this._artifact(workflowId, workspace, 'architecture.md', archMd);
    this._artifact(workflowId, workspace, 'architecture.json', JSON.stringify(architecture));

    const devResult = await this.agents.developer(spec, architecture, sandbox, {
      workflowRunId: workflowId,
    });
    const devReport = developerReportSchema.parse(devResult.data ?? {});
    this._artifact(workflowId, workspace, 'developer_report.md', this._developerMarkdown(devReport));
    this._artifact(workflowId, workspace, 'developer_report.json', JSON.stringify(devReport));

    const tlResult = await this.agents.tech_lead(spec, architecture, devReport, { workflowRunId: workflowId });
    const techLead = techLeadReviewSchema.parse(tlResult.data ?? {});
    this._artifact(workflowId, workspace, 'tech_lead_report.md', this._techLeadMarkdown(techLead));
    this._artifact(workflowId, workspace, 'tech_lead_report.json', JSON.stringify(techLead));

    const qaResult = await this.agents.qa(spec, architecture, sandbox, { workflowRunId: workflowId });
    const qa = qaReportSchema.parse(qaResult.data ?? {});
    if (!qa.passed) {
      const feedback = qa.issues.join('\n') || qa.summary;
      const retryResult = await this.agents.developer(spec, architecture, sandbox, {
        feedback,
        workflowRunId: workflowId,
      });
      const retryReport = developerReportSchema.parse(retryResult.data ?? {});
      this._artifact(workflowId, workspace, 'developer_report_retry.md', this._developerMarkdown(retryReport));
      const retryQaResult = await this.agents.qa(spec, architecture, sandbox, { workflowRunId: workflowId });
      const retryQa = qaReportSchema.parse(retryQaResult.data ?? {});
      this._artifact(workflowId, workspace, 'qa_report.md', this._qaMarkdown(retryQa));
      return {
        workspace,
        spec: JSON.parse(JSON.stringify(spec)),
        architecture: JSON.parse(JSON.stringify(architecture)),
        developer: JSON.parse(JSON.stringify(retryReport)),
        tech_lead: JSON.parse(JSON.stringify(techLead)),
        qa: JSON.parse(JSON.stringify(retryQa)),
      };
    }

    this._artifact(workflowId, workspace, 'qa_report.md', this._qaMarkdown(qa));
    this._commit(workspace, `dev-firm: build (${brief.slice(0, 60)})`);
    return {
      workspace,
      spec: JSON.parse(JSON.stringify(spec)),
      architecture: JSON.parse(JSON.stringify(architecture)),
      developer: JSON.parse(JSON.stringify(devReport)),
      tech_lead: JSON.parse(JSON.stringify(techLead)),
      qa: JSON.parse(JSON.stringify(qa)),
    };
  }

  private async _validate(workflowId: number, workspace: string, sandbox: Sandbox): Promise<string> {
    const pkgPath = path.join(workspace, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      const validation = '# Project validation\n\nNo package.json found in the workspace; skipping build/test validation.';
      this._artifact(workflowId, workspace, 'validation.md', validation);
      return validation;
    }
    const sections: string[] = [];
    for (const script of ['typecheck', 'build', 'test']) {
      const result = await sandbox.runCommand({ command: `npm run ${script}`, timeout: 120000 });
      const ok = (result as Record<string, any>).ok === true;
      const detail = ok
        ? String((result as Record<string, any>).stdout ?? '')
        : String((result as Record<string, any>).error ?? (result as Record<string, any>).stderr ?? (result as Record<string, any>).stdout ?? '');
      sections.push(`### npm run ${script}\nstatus: ${ok ? 'ok' : 'failed'}\n${detail.slice(0, 3000)}`);
    }
    const validation = [`# Project validation\n`, ...sections].join('\n\n');
    this._artifact(workflowId, workspace, 'validation.md', validation);
    return validation;
  }

  private _mockBuild(workflowId: number, workspace: string, brief: string): Record<string, any> {
    const spec: Record<string, any> = {
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
    };
    const architecture: Record<string, any> = {
      markdown: '# Mock architecture\n\nThe real architect agent runs when a provider is configured.',
      stack: ['mock'],
      files: [],
      data_model: '',
      api: '',
      test_plan: ['Configure a provider and rerun'],
      risks: ['Offline mock output is not a substitute for the real pipeline'],
    };
    const developer: DeveloperReport = {
      summary: 'Mock build only; no code was written.',
      files_written: [],
      tests_run: [],
      known_issues: [],
    };
    const techLead: TechLeadReview = {
      verdict: true,
      summary: 'Mock tech lead review passed.',
      issues: [],
    };
    const qa: QAReport = {
      passed: true,
      summary: 'Mock pipeline completed. Configure a provider for real output.',
      issues: [],
      tests_run: [],
      recommendation: '',
    };

    this._artifact(workflowId, workspace, 'product_spec.md', String(spec.markdown));
    this._artifact(workflowId, workspace, 'product_spec.json', JSON.stringify(spec));
    this._artifact(workflowId, workspace, 'architecture.md', String(architecture.markdown));
    this._artifact(workflowId, workspace, 'architecture.json', JSON.stringify(architecture));
    this._artifact(workflowId, workspace, 'developer_report.md', this._developerMarkdown(developer));
    this._artifact(workflowId, workspace, 'tech_lead_report.md', this._techLeadMarkdown(techLead));
    this._artifact(workflowId, workspace, 'tech_lead_report.json', JSON.stringify(techLead));
    this._artifact(workflowId, workspace, 'qa_report.md', this._qaMarkdown(qa));
    return {
      mock: true,
      spec,
      architecture,
      developer,
      tech_lead: techLead,
      qa,
    };
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
      db.saveArtifact(conn, workflowId, null, name, name.endsWith('.md') ? 'markdown' : 'json', content.slice(0, 200000), target),
    );
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
    return parts.join('\n');
  }

  private _architectureMarkdown(architecture: Architecture): string {
    const parts: string[] = ['# Architecture\n', '## Stack'];
    parts.push(...architecture.stack.map((item: string) => `- ${item}`));
    parts.push('\n## Files');
    parts.push(...architecture.files.map((file: { path: string; purpose: string }) => `- \`${file.path}\` — ${file.purpose}`));
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
    return parts.join('\n');
  }

  private _techLeadMarkdown(report: TechLeadReview): string {
    const verdict = report.verdict ? 'PASS' : 'FAIL';
    const parts: string[] = [`# Tech lead review\n\n**Verdict:** ${verdict}\n`, report.summary, '\n## Issues'];
    parts.push(...report.issues.map((item) => `- ${item}`));
    return parts.join('\n');
  }

  private _qaMarkdown(report: QAReport): string {
    const verdict = report.passed ? 'PASS' : 'FAIL';
    const parts: string[] = [`# QA report\n\n**Verdict:** ${verdict}\n`, report.summary, '\n## Tests run'];
    parts.push(...report.tests_run.map((item: string) => `- ${item}`));
    parts.push('\n## Issues');
    parts.push(...report.issues.map((item) => `- ${item}`));
    parts.push('\n## Recommendation', report.recommendation);
    return parts.join('\n');
  }
}
