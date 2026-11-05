from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from dev_firm import db
from dev_firm.config import Settings

SAMPLE_BRIEF = """A local CLI that manages a reading list.

Requirements:
- add, list, and remove books
- tag books by status
- search by title or author
- export to JSON
"""


@pytest.fixture
def settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Settings:
    monkeypatch.setenv("DEV_FIRM_HOME", str(tmp_path / "data"))
    monkeypatch.setenv("DEV_FIRM_PROVIDER", "mock")
    monkeypatch.setenv("DEV_FIRM_MODEL", "mock")
    monkeypatch.setenv("DEV_FIRM_HEURISTIC_FALLBACK", "true")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    settings = Settings.load()
    db.init_db(settings.db_path)
    return settings


@pytest.fixture
def sample_brief() -> str:
    return SAMPLE_BRIEF
