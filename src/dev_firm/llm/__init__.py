from __future__ import annotations

from ..config import Settings
from .anthropic import AnthropicClient
from .base import LLMClient, LLMError, LLMResponse, ToolCall, parse_json_object
from .mock import MockClient
from .openai_compat import OpenAICompatClient

__all__ = [
    "LLMClient",
    "LLMError",
    "LLMResponse",
    "ToolCall",
    "MockClient",
    "OpenAICompatClient",
    "AnthropicClient",
    "build_llm",
    "parse_json_object",
]


def build_llm(settings: Settings) -> LLMClient:
    provider = settings.provider
    if provider == "mock":
        return MockClient(reason="Offline mode selected")

    if provider == "anthropic":
        if not settings.anthropic_api_key:
            return MockClient(reason="No Anthropic API key is configured")
        return AnthropicClient(
            api_key=settings.anthropic_api_key,
            base_url=settings.anthropic_base_url,
            model=settings.model,
            temperature=settings.temperature,
            max_tokens=settings.max_tokens,
            timeout=settings.timeout,
        )

    if provider == "ollama":
        return OpenAICompatClient(
            api_key="ollama",
            base_url=settings.ollama_base_url,
            model=settings.model,
            temperature=settings.temperature,
            max_tokens=settings.max_tokens,
            timeout=settings.timeout,
            provider="ollama",
        )

    if provider == "openai":
        if not settings.api_key:
            return MockClient(reason="No OpenAI API key is configured")
        return OpenAICompatClient(
            api_key=settings.api_key,
            base_url=settings.base_url,
            model=settings.model,
            temperature=settings.temperature,
            max_tokens=settings.max_tokens,
            timeout=settings.timeout,
            provider="openai",
        )

    if provider == "opencode":
        if not settings.opencode_api_key:
            return MockClient(reason="No OpenCode API key is configured")
        return OpenAICompatClient(
            api_key=settings.opencode_api_key,
            base_url=settings.opencode_base_url,
            model=settings.model,
            temperature=settings.temperature,
            max_tokens=settings.max_tokens,
            timeout=settings.timeout,
            provider="opencode",
        )

    raise LLMError(f"Unknown provider: {provider}")
