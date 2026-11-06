import fs from 'node:fs';
import path from 'node:path';

import { Settings, defaultBaseUrlFor, defaultModelFor } from './config';
import * as db from './db';
import { BuildService } from './orchestrator/build';
import { buildLlm, MockClient } from './llm';
import { applyStoredSettings } from './runtime';
import { createTracker } from './tracker';

interface ParsedArguments {
  positionals: string[];
  options: Record<string, string | boolean>;
}

function parseArguments(args: string[]): ParsedArguments {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith('--')) {
      let key = arg.slice(2);
      let value: string | boolean = true;
      const equals = key.indexOf('=');
      if (equals !== -1) {
        value = key.slice(equals + 1);
        key = key.slice(0, equals);
      } else if (index + 1 < args.length && !args[index + 1].startsWith('--')) {
        value = args[index + 1];
        index += 1;
      }
      options[key] = value;
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, options };
}

function optionString(options: Record<string, string | boolean>, key: string): string {
  const value = options[key];
  return typeof value === 'string' ? value : '';
}

function optionBool(options: Record<string, string | boolean>, key: string): boolean {
  return options[key] !== undefined && options[key] !== false && options[key] !== 'false';
}

async function cmdInit(settings: Settings): Promise<number> {
  settings.ensureDirs();
  db.initDb(settings.dbPath);
  console.log(`Initialised Dev Firm in ${settings.dataDir}`);
  console.log(`  database: ${settings.dbPath}`);
  console.log(`  provider: ${settings.provider} / ${settings.model}`);
  console.log('Next: dev-firm serve, then open the printed URL and finish setup.');
  return 0;
}

function cmdConfig(settings: Settings): number {
  console.log(JSON.stringify(settings.publicDict(), null, 2));
  return 0;
}

function cmdDoctor(settings: Settings): number {
  db.initDb(settings.dbPath);
  const llm = buildLlm(settings);
  console.log('Dev Firm doctor');
  console.log(`  node: ${process.version.replace(/^v/, '')}`);
  console.log(`  data: ${settings.dataDir}`);
  console.log(`  database: ${settings.dbPath}`);
  console.log(`  provider: ${settings.provider}`);
  console.log(`  model: ${settings.model}`);
  if (llm instanceof MockClient && llm.reason) {
    console.log(
      `  WARNING: running offline (${llm.reason}). Open Settings in the web app to choose a provider.`,
    );
  } else {
    console.log(`  client: ${llm.constructor.name}`);
  }
  for (const moduleName of ['express', 'better-sqlite3', 'ejs', 'zod']) {
    try {
      require.resolve(moduleName);
      console.log(`  dependency ${moduleName}: ok`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  dependency ${moduleName}: MISSING (${message})`);
    }
  }
  const stats = db.withSession(settings.dbPath, (conn) => db.stats(conn));
  console.log(`  stats: ${JSON.stringify(stats)}`);
  return 0;
}

async function cmdBuild(settings: Settings, positionals: string[], options: Record<string, string | boolean>): Promise<number> {
  const brief = positionals.join(' ').trim();
  if (!brief) {
    throw new Error('A product brief is required. Usage: dev-firm build "<brief>" --title "Title"');
  }
  db.initDb(settings.dbPath);
  const maxIterations = Number.parseInt(optionString(options, 'max-iterations'), 10);
  if (Number.isFinite(maxIterations) && maxIterations > 0) {
    settings.maxBuildIterations = maxIterations;
  }
  console.log('Running the PM → architect → team lead → developers → tech lead → QA loop...');
  try {
    const result = await new BuildService(settings).run(brief, optionString(options, 'title'), optionString(options, 'repo') || undefined);
    console.log(`Workflow #${result.workflow_id}`);
    console.log(`  workspace: ${result.workspace}`);
    console.log(
      `  delivery: ${result.passed ? 'PASSED' : 'BLOCKED'} after ${result.iterations} iteration(s)`,
    );
    console.log(`  tickets: ${result.tickets.length} tracked`);
    if (result.blocked_reason) console.log(`  reason: ${result.blocked_reason}`);
    if (result.mock) {
      console.log('  offline mock: configure a provider for real implementation output');
    } else {
      const qa = result.qa as Record<string, any>;
      console.log(`  QA: ${qa?.passed ? 'PASS' : 'FAIL'} — ${String(qa?.summary ?? '').slice(0, 200)}`);
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(`FAILED: ${err.name}: ${err.message}`);
    return 1;
  }
  return 0;
}

async function cmdServe(settings: Settings, options: Record<string, string | boolean>): Promise<number> {
  const { startServer } = await import('./server');
  const host = optionString(options, 'host') || settings.host;
  const port = Number.parseInt(optionString(options, 'port'), 10) || settings.port;
  startServer({ settings, host, port });
  return 0;
}

function cmdAgents(options: Record<string, string | boolean>): number {
  const roles: Record<string, [string, string]> = {
    product_manager: ['Product Manager', 'You are a senior product manager.'],
    architect: ['Architect', 'You are a pragmatic software architect.'],
    team_lead: ['Team Lead', 'You are the team lead for a small engineering team.'],
    backend_developer: [
      'Backend Developer',
      'You are a senior backend developer implementing the server, data layer, API, CLI, and persistence.',
    ],
    frontend_developer: [
      'Frontend Developer',
      'You are a senior frontend developer implementing the user interface, templates, components, client-side behaviour, and styling.',
    ],
    tech_lead: ['Tech Lead', 'You are a rigorous tech lead.'],
    qa: ['QA', 'You are a rigorous QA engineer.'],
  };
  const selected = optionString(options, 'prompt');
  if (selected) {
    if (!(selected in roles)) {
      throw new Error(`Unknown role. Choose: ${Object.keys(roles).join(', ')}`);
    }
    console.log(roles[selected][1]);
    return 0;
  }
  for (const [key, [label, firstLine]] of Object.entries(roles)) {
    console.log(`${key.padEnd(20)} ${label.padEnd(20)} ${firstLine}`);
  }
  return 0;
}

async function cmdJira(
  settings: Settings,
  positionals: string[],
  options: Record<string, string | boolean>,
): Promise<number> {
  db.initDb(settings.dbPath);
  if (optionString(options, 'project-key')) {
    settings.jiraProjectKey = optionString(options, 'project-key')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '');
  }
  if (optionString(options, 'project-name')) {
    settings.jiraProjectName = optionString(options, 'project-name').trim();
  }
  const subcommand = positionals[0] || 'status';
  if (subcommand === 'status') {
    console.log('Jira integration');
    console.log(`  enabled: ${settings.jiraEnabled ? 'yes' : 'no'}`);
    console.log(`  configured: ${settings.jiraConfigured ? 'yes' : 'no'}`);
    console.log(`  site: ${settings.jiraBaseUrl}`);
    console.log(`  project: ${settings.jiraProjectKey} (${settings.jiraProjectName})`);
    console.log(`  email: ${settings.jiraEmail || '(not set)'}`);
    console.log(`  token: ${settings.jiraTokenHint || '(not set)'}`);
    if (!settings.jiraConfigured) {
      console.log(
        '  Set JIRA_EMAIL and JIRA_API_TOKEN (or use Settings) to enable remote sync. Local tickets always work.',
      );
      return 0;
    }
    const tracker = createTracker(settings);
    const project = await tracker.ensureProject();
    console.log(
      `  remote project: ${project.key} — ${project.name}${project.created ? ' (created)' : ' (existing)'}`,
    );
    if (project.error) console.error(`  error: ${project.error}`);
    return project.error ? 1 : 0;
  }
  if (subcommand === 'init') {
    if (!settings.jiraConfigured) {
      console.error(
        'Jira credentials are missing. Set JIRA_EMAIL and JIRA_API_TOKEN, or start the web app and use Settings → Task tracker / Jira.',
      );
      return 1;
    }
    const tracker = createTracker(settings);
    const project = await tracker.ensureProject();
    if (project.error) {
      console.error(`Jira project setup failed: ${project.error}`);
      return 1;
    }
    console.log(
      `Jira project ${project.key} (${project.name}) is ${project.created ? 'ready (created)' : 'ready (existing)'}.`,
    );
    console.log(`  ${settings.jiraBaseUrl}/jira/software/projects/${project.key}/boards`);
    return 0;
  }
  throw new Error(`Unknown jira subcommand "${subcommand}". Use: jira status | jira init`);
}

export const HELP = `usage: dev-firm [--home HOME] <command> ...

Agent-run development firm: brief → spec → design → code → review → QA, tracked in tickets.

commands:
  init                 Initialise the local database and data directories
  config               Print the effective configuration
  doctor               Check provider, dependencies, and database stats
  build <brief> [--title T] [--repo PATH] [--max-iterations N]
                       Run PM → architect → team lead → developers → tech lead → QA,
                       looping on review/QA failures until QA passes or the limit is hit
  serve                Run the local web app (--host/--port)
  agents               List agent roles or print a role prompt (--prompt ROLE)
  jira status          Show Jira configuration and verify the project
  jira init            Create/verify the Jira project (--project-key/--project-name)
`;

export async function main(argv: string[]): Promise<number> {
  const global = parseArguments(argv);
  let positionals = global.positionals;
  const home = optionString(global.options, 'home');
  if (home) process.env.DEV_FIRM_HOME = home;

  const command = positionals[0];
  if (!command) {
    console.log(HELP);
    return 0;
  }

  const settings = applyStoredSettings(Settings.load());

  try {
    if (command === 'init') return await cmdInit(settings);
    if (command === 'config') return cmdConfig(settings);
    if (command === 'doctor') return cmdDoctor(settings);
    if (command === 'build') {
      return await cmdBuild(settings, positionals.slice(1), global.options);
    }
    if (command === 'serve') return await cmdServe(settings, global.options);
    if (command === 'agents') return cmdAgents(global.options);
    if (command === 'jira') {
      return await cmdJira(settings, positionals.slice(1), global.options);
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(`Error: ${err.message}`);
    return 1;
  }

  console.log(HELP);
  return 1;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code) process.exitCode = code;
    })
    .catch((error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    });
}
