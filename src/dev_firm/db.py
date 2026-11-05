from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

SCHEMA = """
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
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect(db_path: Path | str) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def session(db_path: Path | str) -> Iterator[sqlite3.Connection]:
    conn = connect(db_path)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db(db_path: Path | str) -> None:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    with session(db_path) as conn:
        conn.executescript(SCHEMA)


# ── runtime configuration ────────────────────────────────────────────────────

def get_app_settings(conn: sqlite3.Connection) -> dict[str, str]:
    rows = conn.execute("SELECT key, value FROM app_settings").fetchall()
    return {str(row["key"]): str(row["value"]) for row in rows}


def save_app_settings(conn: sqlite3.Connection, values: dict[str, str]) -> None:
    ts = now()
    for key, value in values.items():
        conn.execute(
            """INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                              updated_at = excluded.updated_at""",
            (key, str(value), ts),
        )


def clear_app_settings(conn: sqlite3.Connection) -> None:
    conn.execute("DELETE FROM app_settings")


def _dict(row: sqlite3.Row | None) -> dict | None:
    return dict(row) if row is not None else None


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


# ── workflows / agent runs / artifacts ───────────────────────────────────────

def create_workflow(
    conn: sqlite3.Connection,
    kind: str,
    title: str,
    input_payload: dict | None = None,
    workspace_path: str | None = None,
) -> int:
    cur = conn.execute(
        """INSERT INTO workflow_runs (kind, title, status, input_json, workspace_path, created_at)
           VALUES (?, ?, 'queued', ?, ?, ?)""",
        (kind, title, _json(input_payload or {}), workspace_path, now()),
    )
    return int(cur.lastrowid)


def update_workflow(conn: sqlite3.Connection, run_id: int, **fields: Any) -> None:
    allowed = {"status", "output_json", "workspace_path", "error", "finished_at"}
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        return
    assignments = ", ".join(f"{key} = ?" for key in updates)
    conn.execute(
        f"UPDATE workflow_runs SET {assignments} WHERE id = ?",
        (*updates.values(), run_id),
    )


def get_workflow(conn: sqlite3.Connection, run_id: int) -> dict | None:
    row = conn.execute("SELECT * FROM workflow_runs WHERE id = ?", (run_id,)).fetchone()
    if not row:
        return None
    item = dict(row)
    item["input"] = json.loads(item.pop("input_json") or "{}")
    item["output"] = json.loads(item.pop("output_json") or "null")
    return item


def list_workflows(conn: sqlite3.Connection, limit: int = 50) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM workflow_runs ORDER BY created_at DESC LIMIT ?", (limit,)
    ).fetchall()
    out = []
    for row in rows:
        item = dict(row)
        item["input"] = json.loads(item.pop("input_json") or "{}")
        item["output"] = json.loads(item.pop("output_json") or "null")
        out.append(item)
    return out


def start_agent_run(
    conn: sqlite3.Connection,
    workflow_run_id: int | None,
    workflow: str,
    role: str,
    input_payload: dict,
    provider: str,
    model: str,
) -> int:
    cur = conn.execute(
        """INSERT INTO agent_runs
           (workflow_run_id, workflow, role, status, input_json, provider, model, created_at)
           VALUES (?, ?, ?, 'running', ?, ?, ?, ?)""",
        (workflow_run_id, workflow, role, _json(input_payload), provider, model, now()),
    )
    return int(cur.lastrowid)


def finish_agent_run(
    conn: sqlite3.Connection,
    run_id: int,
    status: str,
    output: dict | None = None,
    error: str | None = None,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
) -> None:
    conn.execute(
        """UPDATE agent_runs
           SET status = ?, output_json = ?, error = ?, prompt_tokens = ?, completion_tokens = ?,
               finished_at = ?
           WHERE id = ?""",
        (
            status,
            _json(output) if output is not None else None,
            error,
            prompt_tokens,
            completion_tokens,
            now(),
            run_id,
        ),
    )


def list_agent_runs(
    conn: sqlite3.Connection, workflow_run_id: int | None = None, limit: int = 100
) -> list[dict]:
    if workflow_run_id is None:
        rows = conn.execute(
            "SELECT * FROM agent_runs ORDER BY created_at DESC, id DESC LIMIT ?", (limit,)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM agent_runs WHERE workflow_run_id = ? ORDER BY id ASC LIMIT ?",
            (workflow_run_id, limit),
        ).fetchall()
    out = []
    for row in rows:
        item = dict(row)
        item["input"] = json.loads(item.pop("input_json") or "{}")
        item["output"] = json.loads(item.pop("output_json") or "null")
        out.append(item)
    return out


def save_artifact(
    conn: sqlite3.Connection,
    workflow_run_id: int | None,
    agent_run_id: int | None,
    name: str,
    kind: str,
    content: str | None = None,
    path: str | None = None,
) -> int:
    cur = conn.execute(
        """INSERT INTO artifacts (workflow_run_id, agent_run_id, name, kind, content, path, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (workflow_run_id, agent_run_id, name, kind, content, path, now()),
    )
    return int(cur.lastrowid)


def list_artifacts(conn: sqlite3.Connection, workflow_run_id: int) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM artifacts WHERE workflow_run_id = ? ORDER BY id ASC",
        (workflow_run_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def stats(conn: sqlite3.Connection) -> dict:
    def count(table: str) -> int:
        return int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])

    return {
        "workflow_runs": count("workflow_runs"),
        "agent_runs": count("agent_runs"),
        "artifacts": count("artifacts"),
    }
