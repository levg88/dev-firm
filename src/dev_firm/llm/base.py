from __future__ import annotations

import json
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


class LLMError(RuntimeError):
    """Raised when a model call fails or returns unusable output."""


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any] = field(default_factory=dict)


@dataclass
class LLMResponse:
    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    prompt_tokens: int = 0
    completion_tokens: int = 0
    raw: dict[str, Any] = field(default_factory=dict)


class LLMClient(ABC):
    provider = "unknown"
    model = "unknown"

    @abstractmethod
    def complete(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        json_mode: bool = False,
    ) -> LLMResponse:
        raise NotImplementedError


_FENCE_RE = re.compile(r"^\s*```(?:json|JSON)?\s*|\s*```\s*$", re.MULTILINE)


def parse_json_object(text: str) -> dict[str, Any]:
    """Extract the first JSON object from a model response.

    Models sometimes wrap JSON in prose or code fences. We try strict parsing
    first, then the outermost balanced object, then a light trailing-comma fix.
    """
    if not text or not text.strip():
        raise LLMError("The model returned an empty response where JSON was required.")

    cleaned = _FENCE_RE.sub("", text).strip()
    candidates = [cleaned]
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start != -1 and end > start:
        candidates.append(cleaned[start : end + 1])

    for candidate in candidates:
        try:
            value = json.loads(candidate)
            if isinstance(value, dict):
                return value
        except json.JSONDecodeError:
            pass
        fixed = re.sub(r",\s*([}\]])", r"\1", candidate)
        try:
            value = json.loads(fixed)
            if isinstance(value, dict):
                return value
        except json.JSONDecodeError:
            continue

    snippet = cleaned[:500].replace("\n", " ")
    raise LLMError(f"Could not parse JSON from model response: {snippet}")


def content_as_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") in {"text", "output_text"}:
                parts.append(str(block.get("text", "")))
        return "".join(parts)
    return str(content)
