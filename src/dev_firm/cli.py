from __future__ import annotations

import argparse
import json
import os
import sys

from . import db
from .config import Settings
from .llm import build_llm
from .llm.mock import MockClient
from .orchestrator.build import BuildService


def _apply_stored_settings(settings: Settings) -> Settings:
    db.init_db(settings.db_path)
    with db.session(settings.db_path) as conn:
        stored = db.get_app_settings(conn)
    if stored:
        settings.apply_config(stored)
    try:
        os.chmod(settings.db_path, 0o600)
    except OSError:
        pass
    return settings


def cmd_init(settings: Settings, args) -> int:
    settings.ensure_dirs()
    db.init_db(settings.db_path)
    print(f"Initialised Dev Firm in {settings.data_dir}")
    print(f"  database: {settings.db_path}")
    print(f"  provider: {settings.provider} / {settings.model}")
    print("Next: dev-firm serve, then open the printed URL and finish setup.")
    return 0


def cmd_config(settings: Settings, args) -> int:
    print(json.dumps(settings.public_dict(), indent=2))
    return 0


def cmd_doctor(settings: Settings, args) -> int:
    db.init_db(settings.db_path)
    llm = build_llm(settings)
    print("Dev Firm doctor")
    print(f"  python: {sys.version.split()[0]}")
    print(f"  data: {settings.data_dir}")
    print(f"  database: {settings.db_path}")
    print(f"  provider: {settings.provider}")
    print(f"  model: {settings.model}")
    if isinstance(llm, MockClient) and llm.reason:
        print(
            f"  WARNING: running offline ({llm.reason}). "
            "Open Settings in the web app to choose a provider."
        )
    else:
        print(f"  client: {type(llm).__name__}")
    for module in ("fastapi", "uvicorn", "jinja2", "httpx"):
        try:
            __import__(module)
            print(f"  dependency {module}: ok")
        except Exception as exc:
            print(f"  dependency {module}: MISSING ({exc})")
    with db.session(settings.db_path) as conn:
        print("  stats: " + json.dumps(db.stats(conn)))
    return 0


def cmd_build(settings: Settings, args) -> int:
    db.init_db(settings.db_path)
    print("Running the PM → architect → developer → QA pipeline...")
    try:
        result = BuildService(settings).run(args.brief, title=args.title or "")
    except Exception as exc:
        print(f"FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    print(f"Workflow #{result['workflow_id']}")
    print(f"  workspace: {result['workspace']}")
    if result.get("mock"):
        print("  offline mock: configure a provider for real implementation output")
    else:
        qa = result.get("qa", {})
        print(f"  QA: {'PASS' if qa.get('passed') else 'FAIL'} — {qa.get('summary', '')[:200]}")
    return 0


def cmd_serve(settings: Settings, args) -> int:
    import uvicorn

    from .api.app import create_app

    host = args.host or settings.host
    port = args.port or settings.port
    app = create_app(settings)
    print(f"Dev Firm on http://{host}:{port}")
    uvicorn.run(app, host=host, port=port, log_level="info")
    return 0


def cmd_agents(settings: Settings, args) -> int:
    from .agents import prompts

    roles = {
        "product_manager": ("Product Manager", prompts.PM),
        "architect": ("Architect", prompts.ARCHITECT),
        "developer": ("Developer", prompts.DEVELOPER),
        "qa": ("QA", prompts.QA),
    }
    if args.prompt:
        if args.prompt not in roles:
            raise SystemExit(f"Unknown role. Choose: {', '.join(roles)}")
        print(roles[args.prompt][1])
        return 0
    for key, (label, prompt) in roles.items():
        print(f"{key:<18} {label:<18} {prompt.strip().splitlines()[0][:100]}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="dev-firm",
        description="Boutique agent-run development firm: brief → spec → architecture → code → QA.",
    )
    parser.add_argument("--home", help="Data directory (overrides DEV_FIRM_HOME)")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("init", help="Initialise the local database and data directories")
    sub.add_parser("config", help="Print the effective configuration")
    sub.add_parser("doctor", help="Check dependencies, provider, and database")

    build = sub.add_parser("build", help="Run the PM/architect/developer/QA pipeline")
    build.add_argument("brief")
    build.add_argument("--title", default="")

    serve = sub.add_parser("serve", help="Run the local web app")
    serve.add_argument("--host", default=None)
    serve.add_argument("--port", type=int, default=None)

    agents = sub.add_parser("agents", help="List agent roles or print a role prompt")
    agents.add_argument("--prompt", help="Print the full prompt for a role")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 0
    if args.home:
        os.environ["DEV_FIRM_HOME"] = args.home
    settings = _apply_stored_settings(Settings.load())
    if args.command == "init":
        return cmd_init(settings, args)
    if args.command == "config":
        return cmd_config(settings, args)
    if args.command == "doctor":
        return cmd_doctor(settings, args)
    if args.command == "build":
        return cmd_build(settings, args)
    if args.command == "agents":
        return cmd_agents(settings, args)
    if args.command == "serve":
        return cmd_serve(settings, args)
    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
