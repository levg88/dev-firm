from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from .. import db
from ..agents.build_schemas import Architecture, DeveloperReport, ProductSpec
from ..agents.build_team import BuildAgents
from ..agents.tools import Sandbox
from ..config import Settings
from ..llm import build_llm
from ..llm.mock import MockClient
from ..models import QAReport


class BuildService:
    """PM → architect → developer → QA workflow.

    It writes a real application into an isolated workspace and records every
    agent call and artifact. This is the core of the boutique development firm.
    """

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.llm = build_llm(settings)
        self.agents = BuildAgents(settings, self.llm)

    def run(self, brief: str, title: str = "") -> dict:
        with db.session(self.settings.db_path) as conn:
            workflow_id = db.create_workflow(
                conn,
                kind="build",
                title=title or brief[:80],
                input_payload={"brief": brief},
            )
        return self.execute(workflow_id, brief)

    def execute(self, workflow_id: int, brief: str) -> dict:
        with db.session(self.settings.db_path) as conn:
            workflow = db.get_workflow(conn, workflow_id)
            if not workflow:
                raise ValueError(f"Build run {workflow_id} not found")
            workspace = Path(
                workflow.get("workspace_path")
                or str(self.settings.runs_dir / f"build_{workflow_id}" / "workspace")
            )
            db.update_workflow(
                conn, workflow_id, status="running", workspace_path=str(workspace)
            )
        workspace.mkdir(parents=True, exist_ok=True)

        try:
            if self.settings.is_mock or isinstance(self.llm, MockClient):
                output = self._mock_build(workflow_id, workspace, brief)
            else:
                output = self._real_build(workflow_id, workspace, brief)
            with db.session(self.settings.db_path) as conn:
                db.update_workflow(
                    conn,
                    workflow_id,
                    status="done",
                    output_json=json.dumps(output, ensure_ascii=False),
                    finished_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                )
            return {"workflow_id": workflow_id, "workspace": str(workspace), **output}
        except Exception as exc:
            with db.session(self.settings.db_path) as conn:
                db.update_workflow(
                    conn,
                    workflow_id,
                    status="failed",
                    error=f"{type(exc).__name__}: {exc}",
                    finished_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                )
            raise

    def _real_build(self, workflow_id: int, workspace: Path, brief: str) -> dict:
        sandbox = Sandbox(workspace)
        pm_result = self.agents.pm(brief, workflow_run_id=workflow_id)
        spec = ProductSpec.model_validate(pm_result.data or {})
        spec_md = spec.markdown or self._spec_markdown(spec, brief)
        self._artifact(workflow_id, workspace, "product_spec.md", spec_md)
        self._artifact(workflow_id, workspace, "product_spec.json", spec.model_dump_json(indent=2))

        arch_result = self.agents.architect(spec, workflow_run_id=workflow_id)
        architecture = Architecture.model_validate(arch_result.data or {})
        arch_md = architecture.markdown or self._architecture_markdown(architecture)
        self._artifact(workflow_id, workspace, "architecture.md", arch_md)
        self._artifact(workflow_id, workspace, "architecture.json", architecture.model_dump_json(indent=2))

        dev_result = self.agents.developer(spec, architecture, sandbox, workflow_run_id=workflow_id)
        dev_report = DeveloperReport.model_validate(dev_result.data or {})
        self._artifact(workflow_id, workspace, "developer_report.md", self._developer_markdown(dev_report))
        self._artifact(workflow_id, workspace, "developer_report.json", dev_report.model_dump_json(indent=2))

        qa_result = self.agents.qa(spec, architecture, sandbox, workflow_run_id=workflow_id)
        qa = QAReport.model_validate(qa_result.data or {})
        if not qa.passed:
            feedback = "\n".join(f"- {issue}" for issue in qa.issues) or qa.summary
            dev_result = self.agents.developer(
                spec, architecture, sandbox, feedback=feedback, workflow_run_id=workflow_id
            )
            dev_report = DeveloperReport.model_validate(dev_result.data or {})
            self._artifact(
                workflow_id, workspace, "developer_report_retry.md", self._developer_markdown(dev_report)
            )
            qa_result = self.agents.qa(spec, architecture, sandbox, workflow_run_id=workflow_id)
            qa = QAReport.model_validate(qa_result.data or {})

        self._artifact(workflow_id, workspace, "qa_report.md", self._qa_markdown(qa))
        self._artifact(workflow_id, workspace, "qa_report.json", qa.model_dump_json(indent=2))
        return {
            "workspace": str(workspace),
            "spec": spec.model_dump(),
            "architecture": architecture.model_dump(),
            "developer": dev_report.model_dump(),
            "qa": qa.model_dump(),
        }

    def _mock_build(self, workflow_id: int, workspace: Path, brief: str) -> dict:
        spec = ProductSpec(
            markdown=(
                "# Mock product spec\n\n"
                f"**Brief:** {brief}\n\n"
                "No model provider is configured. This placeholder demonstrates the pipeline; "
                "choose a provider in Settings to generate a real spec and implementation."
            ),
            summary=brief,
            acceptance_criteria=["Configure a model provider", "Run the build again"],
            non_goals=["Producing production code without a model"],
            risks=["Offline mock output is not a substitute for the real pipeline"],
        )
        architecture = Architecture(
            markdown="# Mock architecture\n\nThe real architect agent runs when a provider is configured.",
            stack=["python"],
            files=[],
            test_plan=["Configure a provider and rerun"],
        )
        dev = DeveloperReport(summary="Mock build only; no code was written.")
        qa = QAReport(passed=True, summary="Mock pipeline completed. Configure a provider for real output.")

        self._artifact(workflow_id, workspace, "product_spec.md", spec.markdown)
        self._artifact(workflow_id, workspace, "product_spec.json", spec.model_dump_json(indent=2))
        self._artifact(workflow_id, workspace, "architecture.md", architecture.markdown)
        self._artifact(workflow_id, workspace, "architecture.json", architecture.model_dump_json(indent=2))
        self._artifact(workflow_id, workspace, "developer_report.md", self._developer_markdown(dev))
        self._artifact(workflow_id, workspace, "qa_report.md", self._qa_markdown(qa))
        return {
            "mock": True,
            "spec": spec.model_dump(),
            "architecture": architecture.model_dump(),
            "developer": dev.model_dump(),
            "qa": qa.model_dump(),
        }

    def _artifact(
        self, workflow_id: int, workspace: Path, name: str, content: str
    ) -> None:
        path = workspace / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        with db.session(self.settings.db_path) as conn:
            db.save_artifact(
                conn,
                workflow_run_id=workflow_id,
                agent_run_id=None,
                name=name,
                kind="markdown" if name.endswith(".md") else "json",
                content=content[:200000],
                path=str(path),
            )

    @staticmethod
    def _spec_markdown(spec: ProductSpec, brief: str) -> str:
        parts = [f"# Product spec\n\n**Brief:** {brief}\n", spec.summary, "\n## User stories"]
        parts += [f"- {item}" for item in spec.user_stories]
        parts += ["\n## Acceptance criteria"] + [f"- {item}" for item in spec.acceptance_criteria]
        parts += ["\n## Non-goals"] + [f"- {item}" for item in spec.non_goals]
        parts += ["\n## Risks"] + [f"- {item}" for item in spec.risks]
        return "\n".join(parts)

    @staticmethod
    def _architecture_markdown(architecture: Architecture) -> str:
        parts = ["# Architecture\n", "## Stack"] + [f"- {item}" for item in architecture.stack]
        parts += ["\n## Files"] + [f"- `{f.path}` — {f.purpose}" for f in architecture.files]
        parts += ["\n## Data model", architecture.data_model, "\n## Interfaces", architecture.api]
        parts += ["\n## Test plan"] + [f"- {item}" for item in architecture.test_plan]
        parts += ["\n## Risks"] + [f"- {item}" for item in architecture.risks]
        return "\n".join(parts)

    @staticmethod
    def _developer_markdown(report: DeveloperReport) -> str:
        parts = ["# Developer report\n", report.summary, "\n## Files written"]
        parts += [f"- `{item}`" for item in report.files_written]
        parts += ["\n## Tests run"] + [f"- {item}" for item in report.tests_run]
        parts += ["\n## Known issues"] + [f"- {item}" for item in report.known_issues]
        return "\n".join(parts)

    @staticmethod
    def _qa_markdown(report: QAReport) -> str:
        verdict = "PASS" if report.passed else "FAIL"
        parts = [f"# QA report\n\n**Verdict:** {verdict}\n", report.summary, "\n## Tests run"]
        parts += [f"- {item}" for item in report.tests_run]
        parts += ["\n## Issues"] + [f"- {item}" for item in report.issues]
        parts += ["\n## Recommendation", report.recommendation]
        return "\n".join(parts)
