import fs from 'node:fs';
import path from 'node:path';

import { Settings } from './config';
import * as db from './db';

/** Apply settings stored in the local database, then lock the database down. */
export function applyStoredSettings(settings: Settings): Settings {
  db.initDb(settings.dbPath);
  const stored = db.withSession(settings.dbPath, (conn) => db.getAppSettings(conn));
  if (Object.keys(stored).length) settings.applyConfig(stored);
  try {
    fs.chmodSync(settings.dbPath, 0o600);
  } catch {
    // Best-effort on platforms where chmod is not meaningful.
  }
  return settings;
}

/** Sanitise a user-supplied filename for storage. */
export function safeFilename(name: string): string {
  const base = path.basename(name || 'upload');
  const cleaned = [...base]
    .map((char) => (/[\p{L}\p{N}._\- ]/u.test(char) ? char : '_'))
    .join('')
    .trim();
  return cleaned.slice(0, 120) || 'upload';
}
