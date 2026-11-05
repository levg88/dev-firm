from __future__ import annotations

import json
import time
from typing import Any

import httpx

from .base import LLMClient, LLMError, LLMResponse, ToolCall, content_as_text


class OpenAICompatClient(LLMClient):
    """Works with OpenAI, Ollama's /v1 endpoint, OpenRouter, vLLM, etc."""

    provider = "openai"

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        model: str,
        temperature: float = 0.2,
        max_tokens: int = 8192,
        timeout: float = 180,
        provider: str = "openai",
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.timeout = timeout
        self.provider = provider

    @property
    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def complete(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        json_mode: bool = False,
    ) -> LLMResponse:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature if temperature is None else temperature,
            "max_tokens": self.max_tokens if max_tokens is None else max_tokens,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        if json_mode:
            payload["response_format"] = {"type": "json_object"}

        data = self._post(payload)
        message = (data.get("choices") or [{}])[0].get("message") or {}
        text = content_as_text(message.get("content"))
        tool_calls: list[ToolCall] = []
        for call in message.get("tool_calls") or []:
            fn = call.get("function") or {}
            raw_args = fn.get("arguments") or "{}"
            try:
                args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
            except json.JSONDecodeError:
                args = {}
            tool_calls.append(
                ToolCall(
                    id=str(call.get("id") or f"call_{len(tool_calls)}"),
                    name=str(fn.get("name") or ""),
                    arguments=args if isinstance(args, dict) else {},
                )
            )
        usage = data.get("usage") or {}
        return LLMResponse(
            text=text,
            tool_calls=tool_calls,
            prompt_tokens=int(usage.get("prompt_tokens") or 0),
            completion_tokens=int(usage.get("completion_tokens") or 0),
            raw=data,
        )

    def _post(self, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.base_url}/chat/completions"
        last_error = ""
        for attempt in range(3):
            try:
                response = httpx.post(
                    url,
                    headers=self._headers,
                    json=payload,
                    timeout=self.timeout,
                )
            except httpx.HTTPError as exc:
                last_error = f"network error: {exc}"
                if attempt < 2:
                    time.sleep(1.5 * (attempt + 1))
                    continue
                raise LLMError(f"Could not reach {url}: {exc}") from exc

            if response.status_code < 400:
                return response.json()

            body = response.text[:1500]
            last_error = f"HTTP {response.status_code}: {body}"

            # Some newer OpenAI models renamed max_tokens / reject temperature.
            if response.status_code == 400 and "max_tokens" in body and "max_completion_tokens" in body:
                payload = dict(payload)
                payload["max_completion_tokens"] = payload.pop("max_tokens", self.max_tokens)
                continue
            if response.status_code == 400 and "temperature" in body and "unsupported" in body.lower():
                payload = dict(payload)
                payload.pop("temperature", None)
                continue
            if response.status_code == 400 and "response_format" in body:
                payload = dict(payload)
                payload.pop("response_format", None)
                continue
            if response.status_code in {408, 409, 429, 500, 502, 503, 504} and attempt < 2:
                time.sleep(2.0 * (attempt + 1))
                continue
            raise LLMError(f"Model request failed ({self.provider}/{self.model}): {last_error}")

        raise LLMError(f"Model request failed ({self.provider}/{self.model}): {last_error}")
