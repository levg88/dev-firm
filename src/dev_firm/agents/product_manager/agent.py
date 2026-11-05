"""Product Manager agent for the reusable build pipeline."""

from __future__ import annotations

from ...config import Settings
from ...llm.base import LLMClient
from ..base import Agent, AgentSpec
from ..build_schemas import ProductSpec
from ..prompts import PM
from ..runner import run_agent


class ProductManager:
    """Turns a rough brief into a build-ready product specification."""

    role = "product_manager"

    def __init__(self, settings: Settings, llm: LLMClient) -> None:
        self.settings = settings
        self.llm = llm

    def run(self, brief: str, *, workflow_run_id: int | None = None):
        agent = Agent(
            AgentSpec(
                name="product_manager",
                role="product_manager",
                system_prompt=PM,
                temperature=0.3,
            ),
            self.llm,
            self.settings,
        )
        return run_agent(
            self.settings,
            agent,
            workflow="build",
            role="product_manager",
            task="Turn this brief into a build-ready product specification:\n\n" + brief,
            schema=ProductSpec,
            workflow_run_id=workflow_run_id,
        )
