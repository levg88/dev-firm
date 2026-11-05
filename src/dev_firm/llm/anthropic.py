from __future__ import annotations

import time
from typing import Any

import httpx

from .base import LLMClient, LLMError, LLMResponse, ToolCall, content_as_text


class AnthropicClient(LLMClient):
    provider = "anthropic"

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        model: str,
        temperature: float = 0.2,
        max_tokens: int = 8192,
        timeout: float = 180,
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.timeout = timeout

    def _convert_messages(
        self, messages: list[dict[str, Any]]
    ) -> tuple[str, list[dict[str, Any]]]:
        system_parts: list[str] = []
        converted: list[dict[str, Any]] = []
        pending_tool_results: list[dict[str, Any]] = []

        def flush_tools() -> None:
            nonlocal pending_tool_results
            if pending_tool_results:
                converted.append({"role": "user", "content": pending_tool_results})
                pending_tool_results = []

        for msg in messages:
            role = msg.get("role")
            if role == "system":
                system_parts.append(content_as_text(msg.get("content")))
                continue
            if role == "tool":
                pending_tool_results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": msg.get("tool_call_id", ""),
                        "content": content_as_text(msg.get("content")),
                    }
                )
                continue

            flush_tools()
            if role == "user":
                converted.append(
                    {"role": "user", "content": [{"type": "text", "text": content_as_text(msg.get("content"))}]}
                )
            elif role == "assistant":
                blocks: list[dict[str, Any]] = []
                text = content_as_text(msg.get("content"))
                if text:
                    blocks.append({"type": "text", "text": text})
                for call in msg.get("tool_calls") or []:
                    fn = call.get("function") or {}
                    try:
                        import json

                        args = json.loads(fn.get("arguments") or "{}")
                    except Exception:
                        args = {}
                    blocks.append(
                        {
                            "type": "tool_use",
                            "id": call.get("id", ""),
                            "name": fn.get("name", ""),
                            "input": args,
                        }
                    )
                if blocks:
                    converted.append({"role": "assistant", "content": blocks})

        flush_tools()
        return "\n\n".join(p for p in system_parts if p), converted

    def complete(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        json_mode: bool = False,
    ) -> LLMResponse:
        system, converted = self._convert_messages(messages)
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": converted,
            "max_tokens": self.max_tokens if max_tokens is None else max_tokens,
            "temperature": self.temperature if temperature is None else temperature,
        }
        if system:
            payload["system"] = system
        if tools:
            payload["tools"] = [
                {
                    "name": tool["function"]["name"],
                    "description": tool["function"].get("description", ""),
                    "input_schema": tool["function"].get("parameters", {"type": "object"}),
                }
                for tool in tools
            ]

        headers = {
            "Content-Type": "application/json",
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
        }
        url = f"{self.base_url}/messages"
        last_error = ""
        for attempt in range(3):
            try:
                response = httpx.post(url, headers=headers, json=payload, timeout=self.timeout)
            except httpx.HTTPError as exc:
                last_error = f"network error: {exc}"
                if attempt < 2:
                    time.sleep(1.5 * (attempt + 1))
                    continue
                raise LLMError(f"Could not reach {url}: {exc}") from exc

            if response.status_code < 400:
                data = response.json()
                text_parts: list[str] = []
                tool_calls: list[ToolCall] = []
                for block in data.get("content") or []:
                    if block.get("type") == "text":
                        text_parts.append(str(block.get("text", "")))
                    elif block.get("type") == "tool_use":
                        tool_calls.append(
                            ToolCall(
                                id=str(block.get("id") or f"call_{len(tool_calls)}"),
                                name=str(block.get("name") or ""),
                                arguments=block.get("input") or {},
                            )
                        )
                usage = data.get("usage") or {}
                return LLMResponse(
                    text="".join(text_parts),
                    tool_calls=tool_calls,
                    prompt_tokens=int(usage.get("input_tokens") or 0),
                    completion_tokens=int(usage.get("output_tokens") or 0),
                    raw=data,
                )

            last_error = f"HTTP {response.status_code}: {response.text[:1500]}"
            if response.status_code in {408, 409, 429, 500, 502, 503, 504} and attempt < 2:
                time.sleep(2.0 * (attempt + 1))
                continue
            raise LLMError(f"Model request failed (anthropic/{self.model}): {last_error}")

        raise LLMError(f"Model request failed (anthropic/{self.model}): {last_error}")
