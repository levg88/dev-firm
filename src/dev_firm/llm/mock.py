from __future__ import annotations

from typing import Any

from .base import LLMClient, LLMResponse


class MockClient(LLMClient):
    """Offline provider used for demos and tests.

    The firm agents short-circuit to deterministic heuristics when the provider
    is mock, so this client is mainly a safe fallback for the general build
    pipeline. It never invents API calls and never needs a key.
    """

    provider = "mock"
    model = "mock"

    def __init__(self, reason: str = "") -> None:
        self.reason = reason

    def complete(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        json_mode: bool = False,
    ) -> LLMResponse:
        system = "\n".join(
            str(m.get("content", "")) for m in messages if m.get("role") == "system"
        )
        if "OUTPUT JSON" in system or json_mode:
            return LLMResponse(text="{}", prompt_tokens=0, completion_tokens=0)
        return LLMResponse(
            text=(
                "# Mock agent output\n\n"
                "No model provider is configured, so this artifact was produced by "
                "the offline mock. Choose a provider and API key in the web app's "
                "Settings for real agent output."
            ),
            prompt_tokens=0,
            completion_tokens=0,
        )
