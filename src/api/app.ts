import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import express, { type NextFunction, type Request, type Response } from 'express';
import { Settings, defaultBaseUrlFor, defaultModelFor } from '../config';
import * as db from '../db';
import { buildLlm, MockClient } from '../llm';
import { BuildService } from '../orchestrator/build';
import { applyStoredSettings } from '../runtime';

const PROVIDERS: Array<[string, string]> = [
  ['openai', 'OpenAI / OpenAI-compatible'],
  ['anthropic', 'Anthropic'],
  ['ollama', 'Ollama (local)'],
  ['opencode', 'OpenCode (free & paid models)'],
  ['mock', 'Offline mode (no key)'],
];

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

function bodyString(req: Request, key: string): string {
  const value = (req.body ?? {})[key];
  if (Array.isArray(value)) return String(value[value.length - 1] ?? '');
  return value === undefined || value === null ? '' : String(value);
}

function bodyBool(req: Request, key: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(bodyString(req, key).trim().toLowerCase());
}

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

  function stats() {
    return db.withSession(settings.dbPath, (conn) => db.stats(conn));
  }

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
    page(res, 'chat', { messages, active: 'chat' });
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

  app.post('/api/chat', async (req, res) => {
    const content = bodyString(req, 'content').trim();
    if (!content) {
      res.status(400).json({ error: 'Message content is required.' });
      return;
    }

    // Save the user message.
    const userMsg = db.withSession(settings.dbPath, (conn) =>
      db.saveChatMessage(conn, { workflowRunId: null, role: 'user', content }),
    );

    // ── 1. Gather current firm state for LLM context ─────────────────────────
    const allWorkflows = db.withSession(settings.dbPath, (conn) =>
      db.listWorkflows(conn, 10),
    );
    const activeBuilds = allWorkflows.filter((w) => w.status === 'running' || w.status === 'queued');
    const allTickets = db.withSession(settings.dbPath, (conn) =>
      db.listTickets(conn, null, 30),
    );
    const openTickets = allTickets.filter((t) => t.status !== 'done');
    const allAgentRuns = db.withSession(settings.dbPath, (conn) =>
      db.listAgentRuns(conn, null, 30),
    );
    const latestByRole: Record<string, any> = {};
    for (const ar of allAgentRuns) {
      latestByRole[ar.role] = ar;
    }

    // ── 2. Ask the LLM to classify intent and pick an action ─────────────────
    let llmDecision: { action: string; repos?: string[]; brief?: string; response?: string } | null = null;

    try {
      const llm = buildLlm(settings);
      if (!(llm instanceof MockClient)) {
        const systemPrompt = `You are the Dev Firm team coordinator. Analyze the user's message and decide what action to take.

Available actions:
1. check_repo_access — user wants to verify GitHub repo accessibility. params: { repos: ["owner/repo", ...] }
2. compare_repos — user wants to compare two repos for tech stack, patterns, design. params: { repos: ["owner/repo1", "owner/repo2"] }
3. start_build — user wants to build something new. params: { brief: "description of what to build" }
4. get_status — user wants status of builds, tickets, agents. params: {}
5. converse — general conversation, no action needed. params: { response: "your conversational reply" }

Current firm state:
- Active builds: ${activeBuilds.length} (${activeBuilds.map((w) => '#'+w.id+' '+w.title).join(', ') || 'none'})
- Open tickets: ${openTickets.length}
- Agent status: ${Object.entries(latestByRole).map(([role, r]: [string, any]) => role+': '+(r ? r.status+' ('+r.model+')' : 'never run')).join(', ')}

IMPORTANT: When the user mentions a repo like "career-firm" or "niw-tracker", always use the full format "levg88/career-firm" or "levg88/niw-tracker" (the owner is levg88). Never use just the repo name or "owner/repo".

Reply with ONLY a JSON object:
{"action": "check_repo_access|compare_repos|start_build|get_status|converse", "repos": [...], "brief": "...", "response": "..."}

Only include the fields relevant to the chosen action. For "converse", include a helpful "response" field. Do not add any other text.`;

        const llmResp = await llm.complete(
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content },
          ],
          { temperature: 0.2, maxTokens: 512 },
        );
        const raw = llmResp.text.trim();
        try {
          llmDecision = JSON.parse(raw);
        } catch {
          // Try to extract JSON from the response
          const start = raw.indexOf('{');
          const end = raw.lastIndexOf('}');
          if (start !== -1 && end > start) {
            try {
              llmDecision = JSON.parse(raw.slice(start, end + 1));
            } catch {
              llmDecision = null;
            }
          }
        }
      }
    } catch {
      llmDecision = null;
    }

    // ── 3. Execute the decided action ────────────────────────────────────────
    let workflowId: number | null = null;
    let reply = '';

    if (llmDecision && llmDecision.action === 'check_repo_access' && llmDecision.repos) {
      // Normalize repo names: prepend levg88/ if no owner prefix
      const normalizedRepos = llmDecision.repos.map((r) => r.includes('/') ? r : 'levg88/' + r);
      const results: Array<{ repo: string; accessible: boolean; status?: number }> = [];
      for (const repo of normalizedRepos) {
        try {
          const ghResp = await fetch(`https://api.github.com/repos/${repo}`, {
            headers: { Accept: 'application/vnd.github+json' },
          });
          results.push({ repo, accessible: ghResp.ok, status: ghResp.status });
        } catch {
          results.push({ repo, accessible: false, status: 0 });
        }
      }
      const allAccessible = results.every((r) => r.accessible);
      reply =
        `GitHub repo access check:\n` +
        results
          .map((r) => `  • ${r.repo}: ${r.accessible ? '✓ accessible' : '✗ not accessible (HTTP ' + r.status + ')'}`)
          .join('\n') +
        `\n\n${allAccessible ? 'All requested repositories are accessible.' : 'Some repositories are not accessible.'}`;
    } else if (llmDecision && llmDecision.action === 'compare_repos' && llmDecision.repos && llmDecision.repos.length >= 2) {
      // Normalize repo names: prepend levg88/ if no owner prefix
      const [repoA, repoB] = llmDecision.repos.map((r) => r.includes('/') ? r : 'levg88/' + r);
      const fetchRepo = async (repo: string) => {
        try {
          const resp = await fetch(`https://api.github.com/repos/${repo}`, {
            headers: { Accept: 'application/vnd.github+json' },
          });
          if (!resp.ok) return { repo, accessible: false, status: resp.status };
          const data = await resp.json() as { description?: string; language?: string; default_branch?: string; updated_at?: string; size?: number };
          return { repo, accessible: true, ...data };
        } catch {
          return { repo, accessible: false, status: 0 };
        }
      };
      const [infoA, infoB] = await Promise.all([fetchRepo(repoA), fetchRepo(repoB)]);
      const ia = infoA as { accessible: boolean; status?: number; description?: string; language?: string; default_branch?: string; updated_at?: string; size?: number };
      const ib = infoB as { accessible: boolean; status?: number; description?: string; language?: string; default_branch?: string; updated_at?: string; size?: number };

      if (!ia.accessible || !ib.accessible) {
        reply = `Could not fully compare because one or both repos are not accessible:\n` +
          `  • ${repoA}: ${ia.accessible ? '✓ accessible' : '✗ not accessible (HTTP ' + ia.status + ')'}\n` +
          `  • ${repoB}: ${ib.accessible ? '✓ accessible' : '✗ not accessible (HTTP ' + ib.status + ')'}`;
      } else {
        reply = `Repository comparison:\n\n` +
          `📦 ${repoA}\n` +
          `  Description: ${ia.description || '—'}\n` +
          `  Primary language: ${ia.language || '—'}\n` +
          `  Default branch: ${ia.default_branch || '—'}\n` +
          `  Size: ${ia.size || 0} KB\n` +
          `  Last updated: ${ia.updated_at || '—'}\n\n` +
          `📦 ${repoB}\n` +
          `  Description: ${ib.description || '—'}\n` +
          `  Primary language: ${ib.language || '—'}\n` +
          `  Default branch: ${ib.default_branch || '—'}\n` +
          `  Size: ${ib.size || 0} KB\n` +
          `  Last updated: ${ib.updated_at || '—'}\n\n` +
          `Both repositories are on GitHub under the levg88 organization. For a deeper tech/patterns/design comparison, clone both repos and examine their source code, package.json, tsconfig.json, and architecture documents directly.`;
      }
    } else if (llmDecision && llmDecision.action === 'start_build' && llmDecision.brief) {
      const buildBrief = llmDecision.brief;
      workflowId = db.withSession(settings.dbPath, (conn) =>
        db.createWorkflow(
          conn,
          'build',
          buildBrief.slice(0, 80),
          { brief: buildBrief, source: 'chat' },
        ),
      );
      setImmediate(() => {
        void runBuild(settings, workflowId!, buildBrief, undefined);
      });
      reply = `I've started a new build for: "${buildBrief}". The team (PM → architect → team lead → developers → tech lead → QA) is on it. Watch progress at /build/${workflowId}.`;
    } else if (llmDecision && llmDecision.action === 'get_status') {
      let lines = [
        `Here's the current status of the dev firm:`,
        ``,
        `• Active builds: ${activeBuilds.length} (${activeBuilds.map((w) => `#${w.id} ${w.title}`).join(', ') || 'none'})`,
        `• Open tickets: ${openTickets.length}`,
        `• Recent agent runs: ${allAgentRuns.length}`,
        ``,
        `Latest by role:`,
      ];
      for (const role of [
        'product_manager',
        'architect',
        'team_lead',
        'backend_developer',
        'frontend_developer',
        'tech_lead',
        'qa',
      ]) {
        const r = latestByRole[role];
        lines.push(`  - ${role}: ${r ? `${r.status} (${r.model})` : 'never run'}`);
      }
      reply = lines.join('\n');
    } else if (llmDecision && llmDecision.action === 'converse' && llmDecision.response) {
      reply = llmDecision.response;
    } else {
      // Fallback: LLM didn't return a usable decision, generate a conversational response
      try {
        const llm = buildLlm(settings);
        if (llm instanceof MockClient) {
          reply = `I received your message: "${content}". I can help you start builds, check status, or validate/compare GitHub repositories. What would you like to do?`;
        } else {
          const systemPrompt = `You are the Dev Firm team coordinator. The user said: "${content}". Respond helpfully and concisely. You can offer to start builds, check status, or compare repositories.`;
          const llmResp2 = await llm.complete(
            [
              { role: 'system', content: systemPrompt },
              { role: 'user', content },
            ],
            { temperature: 0.3, maxTokens: 1024 },
          );
          reply = llmResp2.text.trim() || `I received your message. I can help you start a build, check team status, or compare GitHub repositories. What would you like to do?`;
        }
      } catch {
        reply = `I received your message: "${content}". I can help you start builds, check team status, or validate/compare GitHub repositories. What would you like to do?`;
      }
    }

    // Save the assistant reply.
    db.withSession(settings.dbPath, (conn) =>
      db.saveChatMessage(conn, {
        workflowRunId: workflowId,
        role: 'assistant',
        content: reply,
        agentRole: 'system',
        metadata: { intent: llmDecision?.action || 'fallback', llmDecision: llmDecision ?? null },
      }),
    );

    res.json({
      user_message: userMsg,
      assistant_message: reply,
      workflow_id: workflowId,
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
