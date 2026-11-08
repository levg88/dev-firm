/**
 * Command-line interface for the dev firm.
 *
 * @module cli
 */
import fs from 'node:fs';
import path from 'node:path';

import { Settings, defaultBaseUrlFor, defaultModelFor } from './config';
import * as db from './db';
import { loadAgentDefinitions } from './agents/definitions';
import { BuildService } from './orchestrator/build';
import { buildLlm, MockClient } from './llm';
import { applyStoredSettings } from './runtime';
import { createTracker, GitHubTracker } from './tracker';

/** ParsedArguments interface. */
interface ParsedArguments {
  positionals: string[];
  options: Record<string, string | boolean>;
}

/** parseArguments function. */
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

/** optionString function. */
function optionString(options: Record<string, string | boolean>, key: string): string {
  const value = options[key];
  return typeof value === 'string' ? value : '';
}

/** optionBool function. */
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

/** cmdConfig function. */
function cmdConfig(settings: Settings): number {
  console.log(JSON.stringify(settings.publicDict(), null, 2));
  return 0;
}

/** cmdDoctor function. */
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

/** List the markdown agent definitions or print one agent's system prompt. */
function cmdAgents(settings: Settings, options: Record<string, string | boolean>): number {
  const definitions = loadAgentDefinitions({ extraDirs: [settings.agentsDir] });
  const selected = optionString(options, 'prompt');
  if (selected) {
    const found = definitions.find(
      (definition) =>
        definition.id === selected ||
        definition.name.toLowerCase() === selected.toLowerCase(),
    );
    if (!found) {
      throw new Error(
        `Unknown agent. Choose: ${definitions.map((definition) => definition.id).join(', ')}`,
      );
    }
    console.log(found.systemPrompt);
    return 0;
  }
  for (const definition of definitions) {
    const summary =
      definition.description || (definition.systemPrompt.split('\n')[0] ?? '');
    console.log(
      `${definition.id.padEnd(20)} ${definition.name.padEnd(20)} ${summary.slice(0, 100)}`,
    );
  }
  return 0;
}

async function cmdGithub(
  settings: Settings,
  positionals: string[],
  options: Record<string, string | boolean>,
): Promise<number> {
  db.initDb(settings.dbPath);
  if (optionString(options, 'owner')) settings.githubOwner = optionString(options, 'owner').trim();
  if (optionString(options, 'repo')) settings.githubRepo = optionString(options, 'repo').trim();
  if (optionString(options, 'title')) {
    settings.githubProjectTitle = optionString(options, 'title').trim();
  }
  if (optionString(options, 'project')) {
    settings.githubProjectNumber = Number.parseInt(optionString(options, 'project'), 10) || 0;
  }
  if (optionString(options, 'prefix')) {
    settings.ticketPrefix =
      optionString(options, 'prefix').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '') || 'CAREER';
  }
  const subcommand = positionals[0] || 'status';
  if (subcommand === 'status') {
    console.log('GitHub Projects integration');
    console.log(`  enabled: ${settings.githubEnabled ? 'yes' : 'no'}`);
    console.log(`  configured: ${settings.githubConfigured ? 'yes' : 'no'}`);
    console.log(`  repository: ${settings.githubOwner}/${settings.githubRepo}`);
    console.log(`  project: ${settings.githubProjectTitle} (#${settings.githubProjectNumber || 'auto'})`);
    console.log(`  ticket prefix: ${settings.ticketPrefix}`);
    console.log(`  token: ${settings.githubTokenHint || '(using gh CLI login)'}`);
    if (!settings.githubConfigured) {
      console.log(
        '  Enable sync with: dev-firm github init  (the local ticket board always works).',
      );
      return 0;
    }
    const tracker = createTracker(settings);
    const project = await tracker.ensureProject();
    if (project.error) {
      console.error(`  error: ${project.error}`);
      console.error('  If this mentions scopes, run: gh auth refresh -s project');
      return 1;
    }
    console.log(`  remote project: ${project.name}${project.created ? ' (created)' : ' (existing)'}`);
    if (project.url) console.log(`  url: ${project.url}`);
    return 0;
  }
  if (subcommand === 'init') {
    settings.githubEnabled = true;
    const tracker = createTracker(settings);
    const project = await tracker.ensureProject();
    if (project.error) {
      console.error(`GitHub project setup failed: ${project.error}`);
      console.error('  Authenticate the GitHub CLI with project access: gh auth refresh -s project');
      return 1;
    }
    db.withSession(settings.dbPath, (conn) =>
      db.saveAppSettings(conn, settings.configValues({ includeSecrets: true })),
    );
    console.log(
      `GitHub project ${settings.githubProjectTitle} is ${project.created ? 'ready (created)' : 'ready (existing)'}.`,
    );
    console.log(`  repository: ${settings.githubOwner}/${settings.githubRepo}`);
    if (project.url) console.log(`  url: ${project.url}`);
    console.log(`  saved: GitHub sync is now enabled for ticket prefix ${settings.ticketPrefix}.`);
    return 0;
  }
  if (subcommand === 'sync') {
    const tracker = createTracker(settings);
    if (!(tracker instanceof GitHubTracker)) {
      console.error('GitHub sync is not enabled. Run: dev-firm github init');
      return 1;
    }
    const run = Number.parseInt(optionString(options, 'run'), 10);
    const result = await tracker.syncAll(Number.isFinite(run) && run > 0 ? run : null);
    console.log(`Synced ${result.synced} ticket(s); ${result.failed} still have sync warnings.`);
    return result.failed ? 1 : 0;
  }
  throw new Error(`Unknown github subcommand "${subcommand}". Use: github status | github init | github sync`);
}

/** HELP constant. */
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
  agents               List agent definitions or print one (--prompt ID)
  github status        Show GitHub Projects config and verify the project
  github init          Create/verify the project and enable sync
                       (--owner/--repo/--title/--project/--prefix)
  github sync          Re-apply local tickets to GitHub (--run ID, default all)
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
    if (command === 'agents') return cmdAgents(settings, global.options);
    if (command === 'github') {
      return await cmdGithub(settings, positionals.slice(1), global.options);
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
