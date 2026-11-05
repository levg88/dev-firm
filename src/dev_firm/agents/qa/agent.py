"""QA agent for the reusable build pipeline."""

from __future__ import annotations

from ...config import Settings
from ...llm.base import LLMClient
from ...models import QAReport
from ..base import Agent, AgentSpec
from ..build_schemas import Architecture, ProductSpec
from ..prompts import QA
from ..runner import run_agent
from ..tools import Sandbox, make_tools


class QA:
    """Reviews the implementation and runs the test suite."""

    role = "qa"

    def __init__(self, settings: Settings, llm: LLMClient) -> None:
        self.settings = settings
        self.llm = llm

    def run(
        self,
        spec: ProductSpec,
        architecture: Architecture,
        sandbox: Sandbox,
        *,
        workflow_run_id: int | None = None,
    ):
        agent = Agent(
            AgentSpec(
                name="qa",
                role="qa",
                system_prompt=QA,
                temperature=0.1,
            ),
            self.llm,
            self.settings,
            tools=make_tools(sandbox, read_only=True),
        )
        files = sandbox.list_files()
        task = (
            "Review the implementation and run the tests.\n\n"
            f"## SPEC\n{spec.markdown}\n\n"
            f"## ARCHITECTURE\n{architecture.markdown}\n\n"
            f"## FILE PLAN\n{architecture.model_dump_json(indent=2)}\n\n"
            f"## FILES PRESENT\n" + "\n".join(f"- {path}" for path in files[:200])
        )
        return run_agent(
            self.settings,
            agent,
            workflow="build",
            role="qa",
            task=task,
            schema=QAReport,
            workflow_run_id=workflow_run_id,
        )
