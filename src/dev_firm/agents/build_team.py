"""The reusable four-role software build team.

Each role lives in its own package so the team can be replaced, extended, or
tested independently. This class is the small orchestration facade used by the
build pipeline.
"""

from __future__ import annotations

from ..config import Settings
from ..llm.base import LLMClient
from .tools import Sandbox
from .architect import Architect
from .developer import Developer
from .product_manager import ProductManager
from .qa import QA


class BuildAgents:
    """Convenience facade over the PM, Architect, Developer, and QA agents."""

    def __init__(self, settings: Settings, llm: LLMClient) -> None:
        self.settings = settings
        self.llm = llm
        self._pm = ProductManager(settings, llm)
        self._architect = Architect(settings, llm)
        self._developer = Developer(settings, llm)
        self._qa = QA(settings, llm)

    def pm(self, brief: str, *, workflow_run_id: int | None = None):
        return self._pm.run(brief, workflow_run_id=workflow_run_id)

    def architect(self, spec, *, workflow_run_id: int | None = None):
        return self._architect.run(spec, workflow_run_id=workflow_run_id)

    def developer(
        self,
        spec,
        architecture,
        sandbox: Sandbox,
        *,
        feedback: str = "",
        workflow_run_id: int | None = None,
    ):
        return self._developer.run(
            spec,
            architecture,
            sandbox,
            feedback=feedback,
            workflow_run_id=workflow_run_id,
        )

    def qa(
        self,
        spec,
        architecture,
        sandbox: Sandbox,
        *,
        workflow_run_id: int | None = None,
    ):
        return self._qa.run(
            spec,
            architecture,
            sandbox,
            workflow_run_id=workflow_run_id,
        )
