from __future__ import annotations

from pydantic import BaseModel

from .. import db
from ..config import Settings
from .base import Agent, AgentResult


def run_agent(
    settings: Settings,
    agent: Agent,
    *,
    workflow: str,
    role: str,
    task: str,
    context: str = "",
    schema: type[BaseModel] | None = None,
    workflow_run_id: int | None = None,
) -> AgentResult:
    """Run an agent and persist a complete audit record of the call."""
    input_payload = {
        "task": task[:8000],
        "context_chars": len(context),
    }
    with db.session(settings.db_path) as conn:
        run_id = db.start_agent_run(
            conn,
            workflow_run_id=workflow_run_id,
            workflow=workflow,
            role=role,
            input_payload=input_payload,
            provider=agent.llm.provider,
            model=agent.llm.model,
        )
    try:
        result = agent.run(task, context=context, schema=schema)
    except Exception as exc:
        with db.session(settings.db_path) as conn:
            db.finish_agent_run(conn, run_id, "failed", error=f"{type(exc).__name__}: {exc}")
        raise

    output = result.data if result.data is not None else {"text": result.text[:40000]}
    with db.session(settings.db_path) as conn:
        db.finish_agent_run(
            conn,
            run_id,
            "ok",
            output=output,
            prompt_tokens=result.prompt_tokens,
            completion_tokens=result.completion_tokens,
        )
    return result


def record_heuristic_run(
    settings: Settings,
    *,
    workflow: str,
    role: str,
    input_payload: dict,
    output: dict,
    workflow_run_id: int | None = None,
    reason: str = "offline deterministic agent",
) -> int:
    """Record a deterministic fallback so the audit trail stays complete."""
    with db.session(settings.db_path) as conn:
        run_id = db.start_agent_run(
            conn,
            workflow_run_id=workflow_run_id,
            workflow=workflow,
            role=role,
            input_payload={**input_payload, "reason": reason},
            provider="heuristic",
            model="deterministic",
        )
        db.finish_agent_run(conn, run_id, "ok", output=output)
    return run_id
