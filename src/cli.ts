import fs from 'node:fs';
import path from 'node:path';

import { Settings, defaultBaseUrlFor, defaultModelFor } from './config';
import * as db from './db';
import { BuildService } from './orchestrator/build';
import { buildLlm, MockClient } from './llm';
import { applyStoredSettings } from './runtime';

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
  console.log('Running the PM → architect → developer → QA pipeline...');
  try {
    const result = await new BuildService(settings).run(brief, optionString(options, 'title'));
    console.log(`Workflow #${result.workflow_id}`);
    console.log(`  workspace: ${result.workspace}`);
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
    developer: ['Developer', 'You are a senior developer implementing a small application.'],
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
    console.log(`${key.padEnd(18)} ${label.padEnd(18)} ${firstLine}`);
  }
  return 0;
}

export const HELP = `usage: dev-firm [--home HOME] <command> ...

Agent-run development firm: brief → spec → architecture → code → QA.

commands:
  init                 Initialise the local database and data directories
  config               Print the effective configuration
  doctor               Check provider, dependencies, and database stats
  build <brief> [--title T]   Run the PM/architect/developer/QA pipeline
  serve                Run the local web app (--host/--port)
  agents              List agent roles or print a role prompt (--prompt ROLE)
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
