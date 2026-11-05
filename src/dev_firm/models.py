from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


def _as_list(value: Any) -> list[str]:
    """LLMs occasionally return a string, dict of lists, or list of objects."""
    if value is None:
        return []
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if isinstance(value, dict):
        out: list[str] = []
        for key, item in value.items():
            if isinstance(item, list):
                out.extend(f"{key}: {x}" for x in item if str(x).strip())
            elif str(item).strip():
                out.append(f"{key}: {item}")
        return out
    if isinstance(value, (list, tuple, set)):
        out = []
        for item in value:
            if isinstance(item, dict):
                out.append(
                    str(
                        item.get("text")
                        or item.get("name")
                        or item.get("requirement")
                        or item
                    )
                )
            elif str(item).strip():
                out.append(str(item).strip())
        return out
    return [str(value)]


def _coerce_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return str(value)
    return str(value).strip()


class QAReport(BaseModel):
    model_config = ConfigDict(extra="ignore")

    passed: bool = False
    summary: str = ""
    issues: list[str] = Field(default_factory=list)
    tests_run: list[str] = Field(default_factory=list)
    recommendation: str = ""

    @field_validator("issues", "tests_run", mode="before")
    @classmethod
    def _lists(cls, value: Any) -> list[str]:
        return _as_list(value)

    @field_validator("summary", "recommendation", mode="before")
    @classmethod
    def _strings(cls, value: Any) -> str:
        return _coerce_text(value)
