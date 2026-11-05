"""Architect agent for the reusable build pipeline."""

from __future__ import annotations

from ...config import Settings
from ...llm.base import LLMClient
from ..base import Agent, AgentSpec
from ..build_schemas import Architecture, ProductSpec
from ..prompts import ARCHITECT
from ..runner import run_agent


class Architect:
    """Designs the smallest implementable architecture for a product spec."""

    role = "architect"

    def __init__(self, settings: Settings, llm: LLMClient) -> None:
        self.settings = settings
        self.llm = llm

    def run(self, spec: ProductSpec, *, workflow_run_id: int | None = None):
        agent = Agent(
            AgentSpec(
                name="architect",
                role="architect",
                system_prompt=ARCHITECT,
                temperature=0.2,
            ),
            self.llm,
            self.settings,
        )
        task = (
            "Design the smallest implementable architecture for this product spec.\n\n"
            f"## SPEC\n{spec.markdown}\n\n"
            f"## ACCEPTANCE CRITERIA\n"
            + "\n".join(f"- {x}" for x in spec.acceptance_criteria)
        )
        return run_agent(
            self.settings,
            agent,
            workflow="build",
            role="architect",
            task=task,
            schema=Architecture,
            workflow_run_id=workflow_run_id,
        )
