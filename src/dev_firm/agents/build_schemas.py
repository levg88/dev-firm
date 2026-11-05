from __future__ import annotations

from pydantic import BaseModel, Field, field_validator


def _list(value):
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [str(v) for v in value]
    return [str(value)]


class ProductSpec(BaseModel):
    markdown: str = ""
    summary: str = ""
    user_stories: list[str] = Field(default_factory=list)
    acceptance_criteria: list[str] = Field(default_factory=list)
    non_goals: list[str] = Field(default_factory=list)
    risks: list[str] = Field(default_factory=list)

    @field_validator("user_stories", "acceptance_criteria", "non_goals", "risks", mode="before")
    @classmethod
    def _lists(cls, value):
        return _list(value)


class FilePlan(BaseModel):
    path: str = ""
    purpose: str = ""


class Architecture(BaseModel):
    markdown: str = ""
    stack: list[str] = Field(default_factory=list)
    files: list[FilePlan] = Field(default_factory=list)
    data_model: str = ""
    api: str = ""
    test_plan: list[str] = Field(default_factory=list)
    risks: list[str] = Field(default_factory=list)

    @field_validator("stack", "test_plan", "risks", mode="before")
    @classmethod
    def _lists(cls, value):
        return _list(value)

    @field_validator("files", mode="before")
    @classmethod
    def _files(cls, value):
        if value is None:
            return []
        if isinstance(value, dict):
            return [{"path": k, "purpose": str(v)} for k, v in value.items()]
        out = []
        for item in value:
            if isinstance(item, str):
                out.append({"path": item, "purpose": ""})
            elif isinstance(item, dict):
                out.append(item)
        return out


class DeveloperReport(BaseModel):
    summary: str = ""
    files_written: list[str] = Field(default_factory=list)
    tests_run: list[str] = Field(default_factory=list)
    known_issues: list[str] = Field(default_factory=list)

    @field_validator("files_written", "tests_run", "known_issues", mode="before")
    @classmethod
    def _lists(cls, value):
        return _list(value)
