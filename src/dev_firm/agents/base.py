from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable

from pydantic import BaseModel

from ..config import Settings
from ..llm.base import LLMClient, LLMError, LLMResponse, parse_json_object


class AgentError(RuntimeError):
    pass


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict[str, Any]
    handler: Callable[..., Any]

    def schema(self) -> dict[str, Any]:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


class ToolRegistry:
    def __init__(self, tools: list[Tool] | None = None) -> None:
        self._tools: dict[str, Tool] = {tool.name: tool for tool in tools or []}

    def add(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def schemas(self) -> list[dict[str, Any]]:
        return [tool.schema() for tool in self._tools.values()]

    def execute(self, name: str, arguments: dict[str, Any]) -> str:
        tool = self._tools.get(name)
        if not tool:
            return json.dumps({"ok": False, "error": f"Unknown tool: {name}"})
        try:
            result = tool.handler(**arguments)
            if isinstance(result, str):
                payload = result
            else:
                payload = json.dumps(result, ensure_ascii=False, default=str)
        except Exception as exc:  # tools report errors back to the model
            payload = json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        return payload[:120000]


@dataclass
class AgentSpec:
    name: str
    role: str
    system_prompt: str
    temperature: float = 0.2
    max_tokens: int | None = None


@dataclass
class AgentResult:
    text: str
    data: dict[str, Any] | None = None
    steps: int = 1
    prompt_tokens: int = 0
    completion_tokens: int = 0
    response: LLMResponse | None = None


class Agent:
    """A small provider-agnostic tool-calling agent.

    Messages use the OpenAI wire shape internally; the Anthropic adapter
    translates them. Tools are plain Python callables registered in a
    ``ToolRegistry``. The loop is deliberately bounded and observable.
    """

    def __init__(
        self,
        spec: AgentSpec,
        llm: LLMClient,
        settings: Settings,
        tools: ToolRegistry | None = None,
    ) -> None:
        self.spec = spec
        self.llm = llm
        self.settings = settings
        self.tools = tools or ToolRegistry()

    def run(
        self,
        task: str,
        *,
        context: str = "",
        schema: type[BaseModel] | None = None,
        max_steps: int | None = None,
    ) -> AgentResult:
        system = self.spec.system_prompt.strip()
        if schema is not None:
            try:
                schema_json = json.dumps(schema.model_json_schema(), ensure_ascii=False, indent=2)
            except Exception:
                schema_json = "{}"
            system += (
                "\n\nOUTPUT JSON\n"
                "Return only one valid JSON object, with no prose before or after it. "
                "It must conform to this JSON Schema:\n" + schema_json
            )

        user = task.strip()
        if context.strip():
            user += "\n\nCONTEXT\n" + context.strip()
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]

        tool_schemas = self.tools.schemas()
        prompt_tokens = 0
        completion_tokens = 0
        last_response: LLMResponse | None = None
        json_attempts = 0
        steps = 0
        limit = max_steps or self.settings.max_agent_steps

        for step in range(1, limit + 1):
            steps = step
            response = self.llm.complete(
                messages,
                tools=tool_schemas or None,
                temperature=self.spec.temperature,
                max_tokens=self.spec.max_tokens,
                # JSON mode and tool calls do not mix reliably on all providers.
                json_mode=bool(schema is not None and not tool_schemas),
            )
            last_response = response
            prompt_tokens += response.prompt_tokens
            completion_tokens += response.completion_tokens

            if response.tool_calls:
                assistant_calls = []
                for call in response.tool_calls:
                    assistant_calls.append(
                        {
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.name,
                                "arguments": json.dumps(call.arguments, ensure_ascii=False),
                            },
                        }
                    )
                messages.append(
                    {
                        "role": "assistant",
                        "content": response.text or "",
                        "tool_calls": assistant_calls,
                    }
                )
                for call in response.tool_calls:
                    result = self.tools.execute(call.name, call.arguments)
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": call.id,
                            "name": call.name,
                            "content": result,
                        }
                    )
                continue

            if schema is None:
                return AgentResult(
                    text=response.text.strip(),
                    data=None,
                    steps=steps,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    response=last_response,
                )

            try:
                data = parse_json_object(response.text)
                return AgentResult(
                    text=response.text,
                    data=data,
                    steps=steps,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    response=last_response,
                )
            except LLMError as exc:
                json_attempts += 1
                if json_attempts > 1:
                    raise AgentError(str(exc)) from exc
                messages.append({"role": "assistant", "content": response.text})
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            "That response was not valid JSON. Return ONLY the JSON object, "
                            "with no markdown fences or commentary."
                        ),
                    }
                )

        raise AgentError(
            f"Agent '{self.spec.name}' exceeded {limit} steps without a final answer."
        )
