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
      allow_heuristic_fallback: bodyBool(req, 'allow_heuristic_fallback') ? 'true' : 'false',
      host: settings.host,
      port: String(settings.port),
      setup_complete: 'true',
    };
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
    res.json({
      ok: true,
      setup_complete: settings.setupComplete,
      provider: settings.provider,
      model: settings.model,
      stats: stats(),
    });
  });

  // ── runs ────────────────────────────────────────────────────────────────────
  app.get('/runs', (req, res) => {
    const workflows = db.withSession(settings.dbPath, (conn) => db.listWorkflows(conn, 40));
    const agentRuns = db.withSession(settings.dbPath, (conn) => db.listAgentRuns(conn, null, 80));
    page(res, 'runs', { workflows, agent_runs: agentRuns, active: 'runs' });
  });

  // ── build lab ───────────────────────────────────────────────────────────────
  app.get('/build', (req, res) => {
    const workflows = db.withSession(settings.dbPath, (conn) => db.listWorkflows(conn, 30));
    page(res, 'build', { workflows, active: 'build' });
  });

  app.post('/build', async (req, res) => {
    const brief = bodyString(req, 'brief');
    const workflows = db.withSession(settings.dbPath, (conn) => db.listWorkflows(conn, 30));
    if (!brief.trim()) {
      page(res, 'build', { workflows, error: 'Describe the app you want to build.', active: 'build' }, 400);
      return;
    }
    const repoPath = bodyString(req, 'repo_path').trim() || undefined;
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
    res.status(200).render('build_detail', {
      workflow,
      artifacts,
      agent_runs: agentRuns,
      stats: stats(),
      llm_note: llmNote(settings),
      error: '',
      message: '',
      active: 'build',
    });
  });

  app.get('/build/:workflowId/status', (req, res) => {
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
