"""Developer agent for the reusable build pipeline."""

from __future__ import annotations

from ...config import Settings
from ...llm.base import LLMClient
from ..base import Agent, AgentSpec
from ..build_schemas import Architecture, DeveloperReport, ProductSpec
from ..prompts import DEVELOPER
from ..runner import run_agent
from ..tools import Sandbox, make_tools


class Developer:
    """Implements a real application inside an isolated workspace."""

    role = "developer"

    def __init__(self, settings: Settings, llm: LLMClient) -> None:
        self.settings = settings
        self.llm = llm

    def run(
        self,
        spec: ProductSpec,
        architecture: Architecture,
        sandbox: Sandbox,
        *,
        feedback: str = "",
        workflow_run_id: int | None = None,
    ):
        agent = Agent(
            AgentSpec(
                name="developer",
                role="developer",
                system_prompt=DEVELOPER,
                temperature=0.2,
            ),
            self.llm,
            self.settings,
            tools=make_tools(sandbox),
        )
        task = (
            "Implement the application in the workspace. Use the tools; do not just describe the code.\n\n"
            f"## SPEC\n{spec.markdown}\n\n"
            f"## ARCHITECTURE\n{architecture.markdown}\n\n"
            f"## FILE PLAN\n{architecture.model_dump_json(indent=2)}\n\n"
            f"## TEST PLAN\n" + "\n".join(f"- {x}" for x in architecture.test_plan)
        )
        if feedback:
            task += "\n\n## QA FEEDBACK TO FIX\n" + feedback
        return run_agent(
            self.settings,
            agent,
            workflow="build",
            role="developer",
            task=task,
            schema=DeveloperReport,
            workflow_run_id=workflow_run_id,
        )
