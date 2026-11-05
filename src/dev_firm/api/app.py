from __future__ import annotations

import os
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .. import db
from ..config import Settings, default_base_url_for, default_model_for
from ..llm import build_llm
from ..llm.mock import MockClient
from ..orchestrator.build import BuildService


def _llm_note(settings: Settings) -> str:
    llm = build_llm(settings)
    if isinstance(llm, MockClient):
        if llm.reason:
            return f"Offline mode: {llm.reason}. Open Settings to choose a provider."
        return (
            "Offline mode. The build team records placeholder artifacts. "
            "Open Settings to add a provider and API key."
        )
    return ""


def _current_base_url(settings: Settings) -> str:
    return settings.active_base_url


def _run_build(settings: Settings, workflow_id: int, brief: str) -> None:
    try:
        BuildService(settings).execute(workflow_id, brief)
    except Exception:
        # The service records the failure on the workflow.
        pass


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.load()
    settings.ensure_dirs()
    db.init_db(settings.db_path)
    with db.session(settings.db_path) as conn:
        stored = db.get_app_settings(conn)
    if stored:
        settings.apply_config(stored)
    try:
        os.chmod(settings.db_path, 0o600)
    except OSError:
        pass

    app = FastAPI(title="Dev Firm", version="0.1.0")
    app.state.settings = settings

    base = Path(__file__).parent
    templates = Jinja2Templates(directory=str(base / "templates"))
    app.mount("/static", StaticFiles(directory=str(base / "static")), name="static")

    @app.middleware("http")
    async def require_setup(request: Request, call_next):
        path = request.url.path
        if not settings.setup_complete and not (
            path in {"/setup", "/health", "/favicon.ico"} or path.startswith("/static/")
        ):
            return RedirectResponse("/setup", status_code=303)
        return await call_next(request)

    def page(request: Request, name: str, status_code: int = 200, **context):
        with db.session(settings.db_path) as conn:
            stats = db.stats(conn)
        context.setdefault("stats", stats)
        context.setdefault("llm_note", _llm_note(settings))
        context.setdefault("settings", settings)
        context.setdefault("active", "")
        return templates.TemplateResponse(request, name, context, status_code=status_code)

    def setup_page(request: Request, *, editing: bool, error: str = "", message: str = ""):
        return page(
            request,
            "setup.html",
            editing=editing,
            base_url=_current_base_url(settings),
            suggested_models={
                provider: default_model_for(provider)
                for provider in ("openai", "anthropic", "ollama", "opencode", "mock")
            },
            suggested_base_urls={
                provider: default_base_url_for(provider)
                for provider in ("openai", "anthropic", "ollama", "opencode")
            },
            error=error,
            message=message,
            active="settings",
            llm_note="",
        )

    @app.get("/setup", response_class=HTMLResponse)
    def setup_view(request: Request, message: str = "", error: str = ""):
        return setup_page(
            request,
            editing=settings.setup_complete,
            error=error,
            message=message,
        )

    @app.get("/settings", response_class=HTMLResponse)
    def settings_view(request: Request, message: str = "", error: str = ""):
        return setup_page(request, editing=True, error=error, message=message)

    @app.post("/setup")
    @app.post("/settings")
    async def save_configuration(
        request: Request,
        provider: str = Form("mock"),
        model: str = Form(""),
        api_key: str = Form(""),
        clear_key: str = Form(""),
        base_url: str = Form(""),
        temperature: str = Form("0.2"),
        max_tokens: str = Form("8192"),
        max_agent_steps: str = Form("16"),
        allow_heuristic_fallback: str = Form(""),
    ):
        editing = settings.setup_complete
        provider = provider.strip().lower()
        if provider not in {"openai", "anthropic", "ollama", "opencode", "mock"}:
            return setup_page(
                request,
                editing=editing,
                error="Choose a valid provider.",
            )

        key_cleared = clear_key.strip().lower() in {"1", "true", "yes", "on"}
        entered_key = "" if key_cleared else api_key.strip()
        existing_key = (
            settings.anthropic_api_key
            if provider == "anthropic"
            else settings.opencode_api_key
            if provider == "opencode"
            else settings.api_key
        )
        effective_key = entered_key or existing_key
        if provider == "openai" and not effective_key:
            return setup_page(
                request,
                editing=editing,
                error="An OpenAI API key is required. Choose Offline mode if you do not have one.",
            )
        if provider == "anthropic" and not effective_key:
            return setup_page(
                request,
                editing=editing,
                error="An Anthropic API key is required. Choose Offline mode if you do not have one.",
            )
        if provider == "opencode" and not effective_key:
            return setup_page(
                request,
                editing=editing,
                error="An OpenCode API key is required. Choose Offline mode if you do not have one.",
            )

        resolved_base = base_url.strip() or default_base_url_for(provider)
        updates: dict[str, str] = {
            "provider": provider,
            "model": model.strip() or default_model_for(provider),
            "temperature": temperature,
            "max_tokens": max_tokens,
            "max_agent_steps": max_agent_steps,
            "allow_heuristic_fallback": (
                "true"
                if allow_heuristic_fallback.strip().lower() in {"1", "true", "yes", "on"}
                else "false"
            ),
        }
        if provider == "anthropic":
            updates["anthropic_base_url"] = resolved_base
        elif provider == "ollama":
            updates["ollama_base_url"] = resolved_base
        elif provider == "opencode":
            updates["opencode_base_url"] = resolved_base
        else:
            updates["base_url"] = resolved_base

        if key_cleared:
            updates["api_key"] = ""
            updates["anthropic_api_key"] = ""
            updates["opencode_api_key"] = ""
        elif entered_key:
            if provider == "anthropic":
                updates["anthropic_api_key"] = entered_key
            elif provider == "opencode":
                updates["opencode_api_key"] = entered_key
            elif provider in {"openai", "ollama"}:
                updates["api_key"] = entered_key

        settings.apply_config(updates)
        settings.setup_complete = True
        with db.session(settings.db_path) as conn:
            db.save_app_settings(conn, settings.config_values(include_secrets=True))

        if editing:
            return RedirectResponse("/settings?message=Configuration+saved", status_code=303)
        return RedirectResponse("/?welcome=1", status_code=303)

    @app.get("/", response_class=HTMLResponse)
    def index(request: Request):
        with db.session(settings.db_path) as conn:
            workflows = db.list_workflows(conn, limit=12)
        message = (
            "Setup complete. Describe the first app you want the team to build."
            if request.query_params.get("welcome") == "1"
            else ""
        )
        return page(
            request,
            "index.html",
            workflows=workflows,
            active="home",
            message=message,
        )

    @app.get("/health")
    def health():
        with db.session(settings.db_path) as conn:
            return {
                "ok": True,
                "setup_complete": settings.setup_complete,
                "provider": settings.provider,
                "model": settings.model,
                "stats": db.stats(conn),
            }

    @app.get("/runs", response_class=HTMLResponse)
    def runs(request: Request):
        with db.session(settings.db_path) as conn:
            workflows = db.list_workflows(conn, limit=40)
            agent_runs = db.list_agent_runs(conn, limit=80)
        return page(
            request,
            "runs.html",
            workflows=workflows,
            agent_runs=agent_runs,
            active="runs",
        )

    @app.get("/build", response_class=HTMLResponse)
    def build_view(request: Request):
        with db.session(settings.db_path) as conn:
            workflows = db.list_workflows(conn, limit=30)
        return page(request, "build.html", workflows=workflows, active="build")

    @app.post("/build")
    def create_build(
        request: Request,
        background: BackgroundTasks,
        brief: str = Form(...),
        title: str = Form(""),
    ):
        if not brief.strip():
            with db.session(settings.db_path) as conn:
                workflows = db.list_workflows(conn, limit=30)
            return page(
                request,
                "build.html",
                workflows=workflows,
                error="Describe the app you want to build.",
                active="build",
                status_code=400,
            )
        with db.session(settings.db_path) as conn:
            workflow_id = db.create_workflow(
                conn,
                kind="build",
                title=title.strip() or brief.strip()[:80],
                input_payload={"brief": brief.strip()},
            )
        background.add_task(_run_build, settings, workflow_id, brief.strip())
        return RedirectResponse(f"/build/{workflow_id}", status_code=303)

    @app.get("/build/{workflow_id}", response_class=HTMLResponse)
    def build_detail(request: Request, workflow_id: int):
        with db.session(settings.db_path) as conn:
            workflow = db.get_workflow(conn, workflow_id)
            if not workflow:
                raise HTTPException(status_code=404, detail="Build run not found")
            artifacts = db.list_artifacts(conn, workflow_id)
            agent_runs = db.list_agent_runs(conn, workflow_run_id=workflow_id)
        return page(
            request,
            "build_detail.html",
            workflow=workflow,
            artifacts=artifacts,
            agent_runs=agent_runs,
            active="build",
        )

    @app.get("/build/{workflow_id}/status")
    def build_status(workflow_id: int):
        with db.session(settings.db_path) as conn:
            workflow = db.get_workflow(conn, workflow_id)
        if not workflow:
            raise HTTPException(status_code=404, detail="Build run not found")
        return JSONResponse(
            {"id": workflow["id"], "status": workflow["status"], "error": workflow["error"]}
        )

    return app
