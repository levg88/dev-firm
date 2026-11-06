import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workflow_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',
    input_json TEXT NOT NULL DEFAULT '{}',
    output_json TEXT,
    workspace_path TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_workflow_created ON workflow_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_run_id INTEGER REFERENCES workflow_runs(id) ON DELETE CASCADE,
    workflow TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    input_json TEXT NOT NULL DEFAULT '{}',
    output_json TEXT,
    error TEXT,
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_created ON agent_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_run_id INTEGER REFERENCES workflow_runs(id) ON DELETE CASCADE,
    agent_run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'text',
    content TEXT,
    path TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_workflow ON artifacts(workflow_run_id);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_run_id INTEGER REFERENCES workflow_runs(id) ON DELETE CASCADE,
    project_key TEXT NOT NULL DEFAULT '',
    key TEXT NOT NULL UNIQUE,
    jira_key TEXT,
    type TEXT NOT NULL DEFAULT 'task',
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    assignee TEXT NOT NULL DEFAULT '',
    reporter TEXT NOT NULL DEFAULT 'product_manager',
    parent_key TEXT,
    labels_json TEXT NOT NULL DEFAULT '[]',
    links_json TEXT NOT NULL DEFAULT '[]',
    evidence TEXT,
    sync_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_workflow ON tickets(workflow_run_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);

CREATE TABLE IF NOT EXISTS ticket_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_key TEXT NOT NULL,
    event TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ticket_events_key ON ticket_events(ticket_key);
`;

export type Row = Record<string, any>;
export type Conn = Database.Database;

export function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

export function connect(dbPath: string): Conn {
  const conn = new Database(dbPath, { timeout: 30000 });
  conn.pragma('foreign_keys = ON');
  return conn;
}

export function withSession<T>(dbPath: string, fn: (conn: Conn) => T): T {
  const conn = connect(dbPath);
  try {
    conn.exec('BEGIN');
    const result = fn(conn);
    conn.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      conn.exec('ROLLBACK');
    } catch {
      // Ignore rollback failures; the original error is more useful.
    }
    throw error;
  } finally {
    conn.close();
  }
}

export function initDb(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const conn = connect(dbPath);
  try {
    conn.exec(SCHEMA);
  } finally {
    conn.close();
  }
}

// ── runtime configuration ────────────────────────────────────────────────────

export function getAppSettings(conn: Conn): Record<string, string> {
  const rows = conn.prepare('SELECT key, value FROM app_settings').all() as Row[];
  const out: Record<string, string> = {};
  for (const row of rows) out[String(row.key)] = String(row.value);
  return out;
}

export function saveAppSettings(conn: Conn, values: Record<string, string>): void {
  const ts = now();
  const stmt = conn.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                            updated_at = excluded.updated_at`,
  );
  for (const [key, value] of Object.entries(values)) {
    stmt.run(key, String(value), ts);
  }
}

export function clearAppSettings(conn: Conn): void {
  conn.prepare('DELETE FROM app_settings').run();
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// ── workflows / agent runs / artifacts ───────────────────────────────────────

export function createWorkflow(
  conn: Conn,
  kind: string,
  title: string,
  inputPayload: unknown = {},
  workspacePath: string | null = null,
): number {
  const info = conn
    .prepare(
      `INSERT INTO workflow_runs (kind, title, status, input_json, workspace_path, created_at)
       VALUES (?, ?, 'queued', ?, ?, ?)`,
    )
    .run(kind, title, json(inputPayload ?? {}), workspacePath, now());
  return Number(info.lastInsertRowid);
}

export function updateWorkflow(conn: Conn, runId: number, fields: Row): void {
  const allowed = new Set(['status', 'output_json', 'workspace_path', 'error', 'finished_at']);
  const updates: Row = {};
  for (const [key, value] of Object.entries(fields)) {
    if (allowed.has(key)) updates[key] = value;
  }
  if (Object.keys(updates).length === 0) return;
  const assignments = Object.keys(updates).map((key) => `${key} = ?`).join(', ');
  conn.prepare(`UPDATE workflow_runs SET ${assignments} WHERE id = ?`).run(...Object.values(updates), runId);
}

function workflowFromRow(row: Row): Row {
  const item: Row = { ...row };
  item.input = parseJson(item.input_json, {});
  item.output = parseJson(item.output_json, null);
  delete item.input_json;
  delete item.output_json;
  return item;
}

export function getWorkflow(conn: Conn, runId: number): Row | null {
  const row = conn.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId) as Row | undefined;
  return row ? workflowFromRow(row) : null;
}

export function listWorkflows(conn: Conn, limit = 50): Row[] {
  const rows = conn
    .prepare('SELECT * FROM workflow_runs ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Row[];
  return rows.map(workflowFromRow);
}

export function startAgentRun(
  conn: Conn,
  workflowRunId: number | null,
  workflow: string,
  role: string,
  inputPayload: unknown,
  provider: string,
  model: string,
): number {
  const info = conn
    .prepare(
      `INSERT INTO agent_runs
       (workflow_run_id, workflow, role, status, input_json, provider, model, created_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
    )
    .run(workflowRunId, workflow, role, json(inputPayload), provider, model, now());
  return Number(info.lastInsertRowid);
}

export function finishAgentRun(
  conn: Conn,
  runId: number,
  status: string,
  output?: unknown,
  error?: string | null,
  promptTokens = 0,
  completionTokens = 0,
): void {
  conn
    .prepare(
      `UPDATE agent_runs
       SET status = ?, output_json = ?, error = ?, prompt_tokens = ?, completion_tokens = ?,
           finished_at = ?
       WHERE id = ?`,
    )
    .run(
      status,
      output === undefined ? null : json(output),
      error ?? null,
      promptTokens,
      completionTokens,
      now(),
      runId,
    );
}

function agentRunFromRow(row: Row): Row {
  const item: Row = { ...row };
  item.input = parseJson(item.input_json, {});
  item.output = parseJson(item.output_json, null);
  delete item.input_json;
  delete item.output_json;
  return item;
}

export function listAgentRuns(
  conn: Conn,
  workflowRunId: number | null = null,
  limit = 100,
): Row[] {
  const rows =
    workflowRunId === null
      ? (conn
          .prepare('SELECT * FROM agent_runs ORDER BY created_at DESC, id DESC LIMIT ?')
          .all(limit) as Row[])
      : (conn
          .prepare('SELECT * FROM agent_runs WHERE workflow_run_id = ? ORDER BY id ASC LIMIT ?')
          .all(workflowRunId, limit) as Row[]);
  return rows.map(agentRunFromRow);
}

export function saveArtifact(
  conn: Conn,
  workflowRunId: number | null,
  agentRunId: number | null,
  name: string,
  kind: string,
  content: string | null = null,
  artifactPath: string | null = null,
): number {
  const info = conn
    .prepare(
      `INSERT INTO artifacts (workflow_run_id, agent_run_id, name, kind, content, path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(workflowRunId, agentRunId, name, kind, content, artifactPath, now());
  return Number(info.lastInsertRowid);
}

export function listArtifacts(conn: Conn, workflowRunId: number): Row[] {
  return conn
    .prepare('SELECT * FROM artifacts WHERE workflow_run_id = ? ORDER BY id ASC')
    .all(workflowRunId) as Row[];
}

export function latestAgentRunsByRole(conn: Conn): Record<string, Row> {
  const rows = conn
    .prepare(
      `SELECT ar.* FROM agent_runs ar
       INNER JOIN (
         SELECT role, MAX(id) AS max_id FROM agent_runs GROUP BY role
       ) latest ON latest.role = ar.role AND latest.max_id = ar.id`,
    )
    .all() as Row[];
  const out: Record<string, Row> = {};
  for (const row of rows) {
    const item = agentRunFromRow(row);
    out[String(item.role)] = item;
  }
  return out;
}

// ── tickets / task tracker ───────────────────────────────────────────────────

export interface TicketCreateInput {
  workflowRunId: number | null;
  projectKey: string;
  type: string;
  title: string;
  description?: string;
  status?: string;
  assignee?: string;
  reporter?: string;
  parentKey?: string | null;
  labels?: string[];
  links?: string[];
}

export function ticketFromRow(row: Row): Row {
  const item: Row = { ...row };
  item.labels = parseJson(item.labels_json, []);
  item.links = parseJson(item.links_json, []);
  delete item.labels_json;
  delete item.links_json;
  return item;
}

export function createTicket(conn: Conn, input: TicketCreateInput): Row {
  const ts = now();
  const placeholder = `${input.projectKey}-pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const info = conn
    .prepare(
      `INSERT INTO tickets
       (workflow_run_id, project_key, key, jira_key, type, title, description, status,
        assignee, reporter, parent_key, labels_json, links_json, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.workflowRunId,
      input.projectKey,
      placeholder,
      input.type,
      input.title,
      input.description ?? '',
      input.status ?? 'todo',
      input.assignee ?? '',
      input.reporter ?? 'product_manager',
      input.parentKey ?? null,
      json(input.labels ?? []),
      json(input.links ?? []),
      ts,
      ts,
    );
  const id = Number(info.lastInsertRowid);
  const key = `${input.projectKey}-${id}`;
  conn.prepare('UPDATE tickets SET key = ?, updated_at = ? WHERE id = ?').run(key, ts, id);
  addTicketEvent(conn, key, 'created', input.reporter ?? 'product_manager', input.title);
  return getTicket(conn, key) as Row;
}

export function getTicket(conn: Conn, key: string): Row | null {
  const row = conn.prepare('SELECT * FROM tickets WHERE key = ? OR jira_key = ?').get(key, key) as
    | Row
    | undefined;
  return row ? ticketFromRow(row) : null;
}

export function listTickets(
  conn: Conn,
  workflowRunId: number | null = null,
  limit = 300,
): Row[] {
  const rows =
    workflowRunId === null
      ? (conn.prepare('SELECT * FROM tickets ORDER BY id DESC LIMIT ?').all(limit) as Row[])
      : (conn
          .prepare('SELECT * FROM tickets WHERE workflow_run_id = ? ORDER BY id ASC LIMIT ?')
          .all(workflowRunId, limit) as Row[]);
  return rows.map(ticketFromRow);
}

export function updateTicketRecord(conn: Conn, key: string, fields: Row): Row | null {
  const allowed = new Set([
    'jira_key',
    'type',
    'title',
    'description',
    'status',
    'assignee',
    'reporter',
    'parent_key',
    'labels_json',
    'links_json',
    'evidence',
    'sync_error',
  ]);
  const updates: Row = {};
  for (const [field, value] of Object.entries(fields)) {
    if (!allowed.has(field)) continue;
    if (field === 'labels_json' || field === 'links_json') updates[field] = json(value);
    else updates[field] = value;
  }
  if (Object.keys(updates).length === 0) return getTicket(conn, key);
  updates.updated_at = now();
  const assignments = Object.keys(updates).map((field) => `${field} = ?`).join(', ');
  conn.prepare(`UPDATE tickets SET ${assignments} WHERE key = ?`).run(...Object.values(updates), key);
  return getTicket(conn, key);
}

export function addTicketEvent(
  conn: Conn,
  ticketKey: string,
  event: string,
  actor = '',
  body = '',
): void {
  conn
    .prepare(
      'INSERT INTO ticket_events (ticket_key, event, actor, body, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(ticketKey, event, actor, body, now());
}

export function listTicketEvents(conn: Conn, key: string, limit = 200): Row[] {
  return conn
    .prepare('SELECT * FROM ticket_events WHERE ticket_key = ? ORDER BY id ASC LIMIT ?')
    .all(key, limit) as Row[];
}

export function stats(conn: Conn): Record<string, number> {
  const count = (table: string): number =>
    Number((conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as Row).n);
  return {
    workflow_runs: count('workflow_runs'),
    agent_runs: count('agent_runs'),
    artifacts: count('artifacts'),
    tickets: count('tickets'),
  };
}
