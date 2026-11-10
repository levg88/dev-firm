/**
 * Express application: routes and web UI endpoints for the dev firm.
 *
 * @module api/app
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import express, { type NextFunction, type Request, type Response } from 'express';
import { Settings, defaultBaseUrlFor, defaultModelFor } from '../config';
import * as db from '../db';
import { buildLlm, MockClient } from '../llm';
import { ChatService } from '../chat/agent';
import { RepoCatalog } from '../chat/repos';
import { BuildService } from '../orchestrator/build';
import { applyStoredSettings } from '../runtime';

/** PROVIDERS constant. */
const PROVIDERS: Array<[string, string]> = [
  ['openai', 'OpenAI / OpenAI-compatible'],
  ['anthropic', 'Anthropic'],
  ['ollama', 'Ollama (local)'],
  ['opencode', 'OpenCode (free & paid models)'],
  ['mock', 'Offline mode (no key)'],
];

/** llmNote function. */
function llmNote(settings: Settings): string {
  const llm = buildLlm(settings);
  if (llm instanceof MockClient) {
    if (llm.reason) {
      return `Offline mode: ${llm.reason}. Open Settings to choose a provider.`;
    }
    return (
      'Offline mode. The build team records placeholder artifacts. Open Settings to add a provider and API key.'
    );
  }
  return '';
}

/** bodyString function. */
function bodyString(req: Request, key: string): string {
  const value = (req.body ?? {})[key];
  if (Array.isArray(value)) return String(value[value.length - 1] ?? '');
  return value === undefined || value === null ? '' : String(value);
}

/** bodyBool function. */
function bodyBool(req: Request, key: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(bodyString(req, key).trim().toLowerCase());
}

/** currentBaseUrl function. */
function currentBaseUrl(settings: Settings): string {
  return settings.activeBaseUrl;
}

async function runBuild(
  settings: Settings,
  workflowId: number,
  brief: string,
  repoPath?: string,
): Promise<void> {
  try {
    await new BuildService(settings).execute(workflowId, brief, repoPath);
  } catch {
    // The service records the failure on the workflow.
  }
}

/** Create and configure the Express app. */
export function createApp(initialSettings?: Settings): express.Express {
  const settings = initialSettings ?? Settings.load();
  settings.ensureDirs();
  db.initDb(settings.dbPath);
  applyStoredSettings(settings);

  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');

  const root = path.resolve(__dirname, '..', '..');
  app.set('views', path.join(root, 'views'));
  app.use('/static', express.static(path.join(root, 'public')));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestPath = req.path;
    if (
      !settings.setupComplete &&
      !['/setup', '/health', '/favicon.ico'].includes(requestPath) &&
      !requestPath.startsWith('/static/')
    ) {
      res.redirect(303, '/setup');
      return;
    }
    next();
  });

  /** stats function. */
  function stats() {
    return db.withSession(settings.dbPath, (conn) => db.stats(conn));
  }

  /** page function. */
  function page(
    res: Response,
    name: string,
    extras: Record<string, any> = {},
    statusCode = 200,
  ): void {
    res.status(statusCode).render(name, {
      stats: stats(),
      llm_note: llmNote(settings),
      settings,
      active: '',
      error: '',
      message: '',
      ...extras,
    });
  }

  /** setupPage function. */
  function setupPage(
    res: Response,
    options: { editing: boolean; error?: string; message?: string; statusCode?: number },
  ): void {
    page(
      res,
      'setup',
      {
        editing: options.editing,
        base_url: currentBaseUrl(settings),
        providers: PROVIDERS,
        suggested_models: Object.fromEntries(
          ['openai', 'anthropic', 'ollama', 'opencode', 'mock'].map((provider) => [
            provider,
            defaultModelFor(provider),
          ]),
        ),
        suggested_base_urls: Object.fromEntries(
          ['openai', 'anthropic', 'ollama', 'opencode'].map((provider) => [
            provider,
            defaultBaseUrlFor(provider),
          ]),
        ),
        error: options.error ?? '',
        message: options.message ?? '',
        active: 'settings',
        llm_note: '',
      },
      options.statusCode ?? 200,
    );
  }

  // ── setup / settings ────────────────────────────────────────────────────────
  app.get('/setup', (req, res) => {
    setupPage(res, {
      editing: settings.setupComplete,
      message: bodyString(req, 'message'),
      error: bodyString(req, 'error'),
    });
  });

  app.get('/settings', (req, res) => {
    setupPage(res, {
      editing: true,
      message: bodyString(req, 'message'),
      error: bodyString(req, 'error'),
    });
  });

  app.post(['/setup', '/settings'], async (req, res) => {
    const editing = settings.setupComplete;
    const provider = bodyString(req, 'provider').trim().toLowerCase() || 'mock';
    if (!['openai', 'anthropic', 'ollama', 'opencode', 'mock'].includes(provider)) {
      setupPage(res, { editing, error: 'Choose a valid provider.' });
      return;
    }

    const keyCleared = bodyBool(req, 'clear_key');
    const enteredKey = keyCleared ? '' : bodyString(req, 'api_key').trim();
    const existingKey =
      provider === 'anthropic'
        ? settings.anthropicApiKey
        : provider === 'opencode'
          ? settings.opencodeApiKey
          : settings.apiKey;
    const effectiveKey = enteredKey || existingKey;
    if (provider === 'openai' && !effectiveKey) {
      setupPage(res, {
        editing,
        error: 'An OpenAI API key is required. Choose Offline mode if you do not have one.',
      });
      return;
    }
    if (provider === 'anthropic' && !effectiveKey) {
      setupPage(res, {
        editing,
        error: 'An Anthropic API key is required. Choose Offline mode if you do not have one.',
      });
      return;
    }
    if (provider === 'opencode' && !effectiveKey) {
      setupPage(res, {
        editing,
        error: 'An OpenCode API key is required. Choose Offline mode if you do not have one.',
      });
      return;
    }

    const resolvedBase = bodyString(req, 'base_url').trim() || defaultBaseUrlFor(provider);
    const updates: Record<string, string> = {
      provider,
      model: bodyString(req, 'model').trim() || defaultModelFor(provider),
      base_url: resolvedBase,
      temperature: bodyString(req, 'temperature') || String(settings.temperature),
      max_tokens: bodyString(req, 'max_tokens') || String(settings.maxTokens),
      max_agent_steps: bodyString(req, 'max_agent_steps') || String(settings.maxAgentSteps),
      max_build_iterations:
        bodyString(req, 'max_build_iterations') || String(settings.maxBuildIterations),
      allow_heuristic_fallback: bodyBool(req, 'allow_heuristic_fallback') ? 'true' : 'false',
      repos_dir: bodyString(req, 'repos_dir').trim() || settings.reposDir,
      concierge_provider: bodyString(req, 'concierge_provider').trim(),
      concierge_model: bodyString(req, 'concierge_model').trim(),
      concierge_base_url: bodyString(req, 'concierge_base_url').trim(),
      concierge_fallback_models: bodyString(req, 'concierge_fallback_models').trim(),
      host: settings.host,
      port: String(settings.port),
      setup_complete: 'true',
      ticket_prefix: bodyString(req, 'ticket_prefix').trim() || settings.ticketPrefix,
      github_enabled: bodyBool(req, 'github_enabled') ? 'true' : 'false',
      github_owner: bodyString(req, 'github_owner').trim() || settings.githubOwner,
      github_repo: bodyString(req, 'github_repo').trim() || settings.githubRepo,
      github_project_title:
        bodyString(req, 'github_project_title').trim() || settings.githubProjectTitle,
      github_project_number:
        bodyString(req, 'github_project_number').trim() || String(settings.githubProjectNumber),
      github_auto_create: bodyBool(req, 'github_auto_create') ? 'true' : 'false',
      github_default_assignee: bodyString(req, 'github_default_assignee').trim(),
    };
    const githubTokenCleared = bodyBool(req, 'clear_github_token');
    const enteredGithubToken = githubTokenCleared
      ? ''
      : bodyString(req, 'github_token').trim();
    if (githubTokenCleared || enteredGithubToken) {
      updates.github_token = enteredGithubToken;
    }
    const githubAssignees = bodyString(req, 'github_assignees_json').trim();
    if (githubAssignees) updates.github_assignees_json = githubAssignees;
    const enteredConciergeKey = bodyString(req, 'concierge_api_key').trim();
    if (enteredConciergeKey) updates.concierge_api_key = enteredConciergeKey;
    if (provider === 'anthropic') updates.anthropic_base_url = resolvedBase;
    else if (provider === 'ollama') updates.ollama_base_url = resolvedBase;
    else if (provider === 'opencode') updates.opencode_base_url = resolvedBase;

    if (keyCleared) {
      updates.api_key = '';
      updates.anthropic_api_key = '';
      updates.opencode_api_key = '';
    } else if (enteredKey) {
      if (provider === 'anthropic') updates.anthropic_api_key = enteredKey;
      else if (provider === 'opencode') updates.opencode_api_key = enteredKey;
      else if (provider === 'openai' || provider === 'ollama') updates.api_key = enteredKey;
    }

    settings.applyConfig(updates);
    settings.setupComplete = true;
    db.withSession(settings.dbPath, (conn) =>
      db.saveAppSettings(conn, settings.configValues({ includeSecrets: true })),
    );

    if (editing) {
      res.redirect(303, '/settings?message=Configuration+saved');
      return;
    }
    res.redirect(303, '/?welcome=1');
  });

  // ── dashboard / health ──────────────────────────────────────────────────────
  app.get('/', (req, res) => {
    const workflows = db.withSession(settings.dbPath, (conn) => db.listWorkflows(conn, 12));
    const message =
      String(req.query.welcome ?? '') === '1'
        ? 'Setup complete. Describe the first app you want the team to build.'
        : '';
    page(res, 'index', { workflows, active: 'home', message });
  });

  app.get('/health', (_req, res) => {
    const latest = db.withSession(settings.dbPath, (conn) => db.latestAgentRunsByRole(conn));
    res.json({
      ok: true,
      setup_complete: settings.setupComplete,
      provider: settings.provider,
      model: settings.model,
      stats: stats(),
      agents: Object.fromEntries(
        [
          'product_manager',
          'architect',
          'team_lead',
          'backend_developer',
          'frontend_developer',
          'tech_lead',
          'qa',
          'devops',
        ].map((role) => [
          role,
          latest[role]
            ? { status: latest[role].status, model: latest[role].model, finished_at: latest[role].finished_at }
            : { status: 'never-run' },
        ]),
      ),
    });
  });

  // ── runs ────────────────────────────────────────────────────────────────────
  app.get('/runs', (req, res) => {
    const workflows = db.withSession(settings.dbPath, (conn) => db.listWorkflows(conn, 40));
    const agentRuns = db.withSession(settings.dbPath, (conn) => db.listAgentRuns(conn, null, 80));
    page(res, 'runs', { workflows, agent_runs: agentRuns, active: 'runs' });
  });

  // ── task tracker ────────────────────────────────────────────────────────────
  app.get('/tickets', (req, res) => {
    const tickets = db.withSession(settings.dbPath, (conn) => db.listTickets(conn, null, 300));
    const columns = ['todo', 'design', 'team_review', 'in_progress', 'in_review', 'qa', 'blocked', 'done'];
    const board = Object.fromEntries(
      columns.map((status) => [status, tickets.filter((ticket) => ticket.status === status)]),
    );
    page(res, 'tickets', { tickets, board, columns, active: 'tickets' });
  });

  app.get('/tickets/:key', (req, res) => {
    const key = String(req.params.key);
    const ticket = db.withSession(settings.dbPath, (conn) => db.getTicket(conn, key));
    if (!ticket) {
      res.status(404).send('Ticket not found');
      return;
    }
    const events = db.withSession(settings.dbPath, (conn) => db.listTicketEvents(conn, key));
    page(res, 'ticket_detail', { ticket, events, active: 'tickets' });
  });

  // ── agents health ────────────────────────────────────────────────────────────
  app.get('/agents', (req, res) => {
    const agentRuns = db.withSession(settings.dbPath, (conn) =>
      db.listAgentRuns(conn, null, 200),
    );
    // Group by role, showing all instances (most recent first within each role)
    const byRole: Record<string, typeof agentRuns> = {};
    for (const run of agentRuns) {
      const role = String(run.role);
      if (!byRole[role]) byRole[role] = [];
      byRole[role].push(run);
    }
    const roles = Object.keys(byRole).sort();
    page(res, 'agents', { by_role: byRole, roles, active: 'agents' });
  });

  app.get('/agents/:runId', (req, res) => {
    const runId = Number.parseInt(req.params.runId, 10);
    const agentRuns = db.withSession(settings.dbPath, (conn) =>
      db.listAgentRuns(conn, null, 1000),
    );
    const run = agentRuns.find((r) => r.id === runId);
    if (!run) {
      res.status(404).send('Agent run not found');
      return;
    }
    const steps = db.withSession(settings.dbPath, (conn) =>
      db.listAgentSteps(conn, runId),
    );
    const artifacts = db.withSession(settings.dbPath, (conn) =>
      db.listArtifactsForAgentRun(conn, runId),
    );
    // Get tickets for this workflow
    const tickets = db.withSession(settings.dbPath, (conn) =>
      run.workflow_run_id
        ? db.listTickets(conn, run.workflow_run_id, 300)
        : [],
    );
    page(res, 'agent_detail', {
      run,
      steps,
      artifacts,
      tickets,
      active: 'agents',
    });
  });

  // ── build lab ───────────────────────────────────────────────────────────────
  app.get('/build', (req, res) => {
    const workflows = db.withSession(settings.dbPath, (conn) => db.listWorkflows(conn, 30));
    page(res, 'build', { workflows, active: 'build' });
  });

  app.get('/chat', (req, res) => {
    const messages = db.withSession(settings.dbPath, (conn) =>
      db.listRecentChatMessages(conn, 100),
    );
    let repos: ReturnType<RepoCatalog['list']> = [];
    try {
      repos = new RepoCatalog(settings.reposDir).list();
    } catch {
      repos = [];
    }
    page(res, 'chat', { messages, repos, repos_root: settings.reposDir, active: 'chat' });
  });

  app.post('/build', async (req, res) => {
    const brief = bodyString(req, 'brief');
    const workflows = db.withSession(settings.dbPath, (conn) => db.listWorkflows(conn, 30));
    if (!brief.trim()) {
      page(res, 'build', { workflows, error: 'Describe the app you want to build.', active: 'build' }, 400);
      return;
    }
    const repoPath = bodyString(req, 'repo_path').trim() || undefined;
    const maxIterations = Number.parseInt(bodyString(req, 'max_iterations'), 10);
    if (Number.isFinite(maxIterations) && maxIterations > 0) {
      settings.maxBuildIterations = Math.max(1, maxIterations);
      db.withSession(settings.dbPath, (conn) =>
        db.saveAppSettings(conn, { max_build_iterations: String(settings.maxBuildIterations) }),
      );
    }
    const workflowId = db.withSession(settings.dbPath, (conn) =>
      db.createWorkflow(
        conn,
        'build',
        bodyString(req, 'title').trim() || brief.trim().slice(0, 80),
        { brief: brief.trim(), repo_path: repoPath ?? '' },
      ),
    );
    setImmediate(() => {
      void runBuild(settings, workflowId, brief.trim(), repoPath);
    });
    res.redirect(303, `/build/${workflowId}`);
  });

  app.get('/build/:workflowId', (req, res) => {
    const workflowId = Number.parseInt(req.params.workflowId, 10);
    const workflow = db.withSession(settings.dbPath, (conn) => db.getWorkflow(conn, workflowId));
    if (!workflow) {
      res.status(404).send('Build run not found');
      return;
    }
    const artifacts = db.withSession(settings.dbPath, (conn) => db.listArtifacts(conn, workflowId));
    const agentRuns = db.withSession(settings.dbPath, (conn) =>
      db.listAgentRuns(conn, workflowId, 80),
    );
    const tickets = db.withSession(settings.dbPath, (conn) => db.listTickets(conn, workflowId, 300));

    // Parse progress from the latest status artifact
    let phase = 'starting';
    let phaseLabel = 'Build starting';
    let iteration = 0;
    let maxIterations = settings.maxBuildIterations;
    const statusArtifact = artifacts.find((a) => a.name === 'status.md');
    if (statusArtifact?.content) {
      const content = String(statusArtifact.content);
      const phaseMatch = content.match(/- Phase: (.+)/);
      if (phaseMatch) phaseLabel = phaseMatch[1].trim();
      const iterMatch = content.match(/- Iteration: (\d+)\/(\d+)/);
      if (iterMatch) {
        iteration = Number(iterMatch[1]);
        maxIterations = Number(iterMatch[2]);
      }
      const phaseLower = phaseLabel.toLowerCase();
      if (phaseLower.includes('architect')) phase = 'architect';
      else if (phaseLower.includes('team lead')) phase = 'team_review';
      else if (phaseLower.includes('developer')) phase = 'developers';
      else if (phaseLower.includes('tech lead')) phase = 'tech_lead';
      else if (phaseLower.includes('qa')) phase = 'qa';
      else if (phaseLower.includes('devops') || phaseLower.includes('deploy')) phase = 'devops';
      else if (phaseLower.includes('done') || phaseLower.includes('passed')) phase = 'done';
      else if (phaseLower.includes('blocked')) phase = 'blocked';
    }

    res.status(200).render('build_detail', {
      workflow,
      artifacts,
      agent_runs: agentRuns,
      tickets,
      stats: stats(),
      llm_note: llmNote(settings),
      error: '',
      message: '',
      active: 'build',
      phase,
      phaseLabel,
      iteration,
      maxIterations,
    });
  });

  app.get('/build/:workflowId/status', (req, res) => {
    const workflowId = Number.parseInt(req.params.workflowId, 10);
    const workflow = db.withSession(settings.dbPath, (conn) => db.getWorkflow(conn, workflowId));
    if (!workflow) {
      res.status(404).json({ detail: 'Build run not found' });
      return;
    }
    const artifacts = db.withSession(settings.dbPath, (conn) => db.listArtifacts(conn, workflowId));
    const statusArtifact = artifacts.find((a) => a.name === 'status.md');
    let phase = 'starting';
    let phaseLabel = 'Build starting';
    let iteration = 0;
    let maxIterations = settings.maxBuildIterations;
    if (statusArtifact?.content) {
      const content = String(statusArtifact.content);
      const phaseMatch = content.match(/- Phase: (.+)/);
      if (phaseMatch) phaseLabel = phaseMatch[1].trim();
      const iterMatch = content.match(/- Iteration: (\d+)\/(\d+)/);
      if (iterMatch) {
        iteration = Number(iterMatch[1]);
        maxIterations = Number(iterMatch[2]);
      }
      const phaseLower = phaseLabel.toLowerCase();
      if (phaseLower.includes('architect')) phase = 'architect';
      else if (phaseLower.includes('team lead')) phase = 'team_review';
      else if (phaseLower.includes('developer')) phase = 'developers';
      else if (phaseLower.includes('tech lead')) phase = 'tech_lead';
      else if (phaseLower.includes('qa')) phase = 'qa';
      else if (phaseLower.includes('devops') || phaseLower.includes('deploy')) phase = 'devops';
      else if (phaseLower.includes('done') || phaseLower.includes('passed')) phase = 'done';
      else if (phaseLower.includes('blocked')) phase = 'blocked';
    }
    res.json({
      id: workflow.id,
      status: workflow.status,
      error: workflow.error,
      phase,
      phaseLabel,
      iteration,
      maxIterations,
    });
  });

  // ── agent detail API ─────────────────────────────────────────────────────────
  app.get('/api/agents', (_req, res) => {
    const agentRuns = db.withSession(settings.dbPath, (conn) =>
      db.listAgentRuns(conn, null, 200),
    );
    // Group by role, showing all instances (most recent first within each role)
    const byRole: Record<string, typeof agentRuns> = {};
    for (const run of agentRuns) {
      const role = String(run.role);
      if (!byRole[role]) byRole[role] = [];
      byRole[role].push(run);
    }
    res.json({ by_role: byRole, total: agentRuns.length });
  });

  app.get('/api/agents/:runId', (req, res) => {
    const runId = Number.parseInt(req.params.runId, 10);
    const agentRuns = db.withSession(settings.dbPath, (conn) =>
      db.listAgentRuns(conn, null, 1000),
    );
    const run = agentRuns.find((r) => r.id === runId);
    if (!run) {
      res.status(404).json({ detail: 'Agent run not found' });
      return;
    }
    const steps = db.withSession(settings.dbPath, (conn) =>
      db.listAgentSteps(conn, runId),
    );
    const artifacts = db.withSession(settings.dbPath, (conn) =>
      db.listArtifactsForAgentRun(conn, runId),
    );
    res.json({ run, steps, artifacts });
  });

  // ── build status API (alias for polling) ─────────────────────────────────────
  app.get('/api/builds/:workflowId/status', (req, res) => {
    const workflowId = Number.parseInt(req.params.workflowId, 10);
    const workflow = db.withSession(settings.dbPath, (conn) => db.getWorkflow(conn, workflowId));
    if (!workflow) {
      res.status(404).json({ detail: 'Build run not found' });
      return;
    }
    res.json({
      id: workflow.id,
      status: workflow.status,
      error: workflow.error,
    });
  });

  // ── chat API ─────────────────────────────────────────────────────────────────
  app.get('/api/chat', (_req, res) => {
    const messages = db.withSession(settings.dbPath, (conn) =>
      db.listRecentChatMessages(conn, 100),
    );
    res.json({ messages });
  });

  app.delete('/api/chat', (_req, res) => {
    const cleared = db.withSession(settings.dbPath, (conn) => db.clearChatMessages(conn));
    res.json({ cleared });
  });

  app.get('/api/repos', (_req, res) => {
    try {
      const catalog = new RepoCatalog(settings.reposDir);
      res.json({ root: catalog.root, repositories: catalog.list() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/chat', async (req, res) => {
    const content = bodyString(req, 'content').trim();
    if (!content) {
      res.status(400).json({ error: 'Message content is required.' });
      return;
    }

    // Load the conversation before saving this turn so the model sees prior
    // context exactly once (the new message is passed as the current task).
    const historyRows = db.withSession(settings.dbPath, (conn) =>
      db.listRecentChatMessages(conn, 60),
    );
    const history = ChatService.historyFromRows(historyRows);

    const userMsg = db.withSession(settings.dbPath, (conn) =>
      db.saveChatMessage(conn, { workflowRunId: null, role: 'user', content }),
    );

    let reply = '';
    let workflowId: number | null = null;
    let metadata: Record<string, unknown> = {};

    try {
      const result = await new ChatService(settings).run(content, history);
      reply = result.reply;
      workflowId = result.workflowId;
      metadata = result.metadata;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply =
        `I hit a problem while working on that: ${message}\n\n` +
        'You can retry the request, or check Settings if the model provider is unavailable.';
      metadata = { agent: 'concierge', error: message };
    }

    db.withSession(settings.dbPath, (conn) =>
      db.saveChatMessage(conn, {
        workflowRunId: workflowId,
        role: 'assistant',
        content: reply,
        agentRole: 'concierge',
        metadata,
      }),
    );

    res.json({
      user_message: userMsg,
      assistant_message: reply,
      workflow_id: workflowId,
      metadata,
    });
  });

  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).send(message);
  });

  return app;
}
