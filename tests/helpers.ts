import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Settings } from '../src/config';
import * as db from '../src/db';

export const SAMPLE_BRIEF = `A local CLI that manages a reading list.

Requirements:
- add, list, and remove books
- tag books by status
- search by title or author
- export to JSON
`;

const MANAGED_ENV = [
  'DEV_FIRM_HOME',
  'DEV_FIRM_PROVIDER',
  'DEV_FIRM_MODEL',
  'DEV_FIRM_HEURISTIC_FALLBACK',
  'DEV_FIRM_SETUP_COMPLETE',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENCODE_API_KEY',
];

type EnvSnapshot = Map<string, string | undefined>;

export function snapshotEnv(): EnvSnapshot {
  return new Map(MANAGED_ENV.map((key) => [key, process.env[key]]));
}

export function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export interface SettingsOptions {
  home?: string;
  provider?: string;
  setupComplete?: boolean;
}

export function makeSettings(options: SettingsOptions = {}): Settings {
  const home = options.home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dev-firm-'));
  const snapshot = snapshotEnv();
  process.env.DEV_FIRM_HOME = home;
  process.env.DEV_FIRM_PROVIDER = options.provider ?? 'mock';
  process.env.DEV_FIRM_MODEL = options.provider ?? 'mock';
  process.env.DEV_FIRM_HEURISTIC_FALLBACK = 'true';
  process.env.DEV_FIRM_SETUP_COMPLETE = options.setupComplete === false ? 'false' : 'true';
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENCODE_API_KEY;

  const settings = Settings.load();
  restoreEnv(snapshot);
  settings.ensureDirs();
  db.initDb(settings.dbPath);
  return settings;
}

export function makeFreshSettings(): Settings {
  return makeSettings({ setupComplete: false });
}

export function profileId(settings: Settings): number {
  return db.withSession(settings.dbPath, (conn) => Number(db.getProfile(conn, 1).id));
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
