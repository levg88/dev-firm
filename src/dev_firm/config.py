from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _load_dotenv(path: Path) -> None:
    """Minimal .env loader (no dependency, does not override real env vars)."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


def _default_provider() -> str:
    explicit = os.getenv("DEV_FIRM_PROVIDER")
    if explicit:
        return explicit.strip().lower()
    if os.getenv("OPENAI_API_KEY"):
        return "openai"
    if os.getenv("ANTHROPIC_API_KEY"):
        return "anthropic"
    return "mock"


def _default_model(provider: str) -> str:
    explicit = os.getenv("DEV_FIRM_MODEL")
    if explicit:
        return explicit
    return {
        "openai": "gpt-4.1",
        "anthropic": "claude-sonnet-4-20250514",
        "ollama": "llama3.1",
        "mock": "mock",
    }.get(provider, "gpt-4.1")


def default_model_for(provider: str) -> str:
    return {
        "openai": "gpt-4.1",
        "anthropic": "claude-sonnet-4-20250514",
        "ollama": "llama3.1",
        "mock": "mock",
    }.get(provider, "gpt-4.1")


def default_base_url_for(provider: str) -> str:
    return {
        "openai": "https://api.openai.com/v1",
        "anthropic": "https://api.anthropic.com/v1",
        "ollama": "http://localhost:11434/v1",
    }.get(provider, "")


@dataclass
class Settings:
    home: Path
    data_dir: Path
    db_path: Path
    storage_dir: Path
    runs_dir: Path
    provider: str
    model: str
    api_key: str
    base_url: str
    anthropic_api_key: str
    anthropic_base_url: str
    ollama_base_url: str
    temperature: float
    max_tokens: int
    timeout: float
    max_agent_steps: int
    allow_heuristic_fallback: bool
    host: str
    port: int
    setup_complete: bool = False

    @classmethod
    def load(cls) -> "Settings":
        # Look in the current directory first, then in the repository root.
        cwd = Path.cwd()
        _load_dotenv(cwd / ".env")
        repo_root = Path(__file__).resolve().parents[2]
        if repo_root != cwd:
            _load_dotenv(repo_root / ".env")

        home = Path(os.getenv("DEV_FIRM_HOME", "./data")).expanduser().resolve()
        provider = _default_provider()
        base_url = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
        if provider == "ollama":
            base_url = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434/v1").rstrip("/")
        env_configured = bool(
            os.getenv("DEV_FIRM_PROVIDER")
            or os.getenv("OPENAI_API_KEY")
            or os.getenv("ANTHROPIC_API_KEY")
        )

        settings = cls(
            home=home,
            data_dir=home,
            db_path=home / "dev.db",
            storage_dir=home / "storage",
            runs_dir=home / "runs",
            provider=provider,
            model=_default_model(provider),
            api_key=os.getenv("OPENAI_API_KEY", ""),
            base_url=base_url,
            anthropic_api_key=os.getenv("ANTHROPIC_API_KEY", ""),
            anthropic_base_url=os.getenv(
                "ANTHROPIC_BASE_URL", "https://api.anthropic.com/v1"
            ).rstrip("/"),
            ollama_base_url=os.getenv(
                "OLLAMA_BASE_URL", "http://localhost:11434/v1"
            ).rstrip("/"),
            temperature=_float("DEV_FIRM_TEMPERATURE", 0.2),
            max_tokens=_int("DEV_FIRM_MAX_TOKENS", 8192),
            timeout=_float("DEV_FIRM_TIMEOUT", 180),
            max_agent_steps=_int("DEV_FIRM_MAX_STEPS", 16),
            allow_heuristic_fallback=_bool("DEV_FIRM_HEURISTIC_FALLBACK", True),
            host=os.getenv("DEV_FIRM_HOST", "127.0.0.1"),
            port=_int("DEV_FIRM_PORT", 8766),
            setup_complete=_bool("DEV_FIRM_SETUP_COMPLETE", env_configured),
        )
        settings.ensure_dirs()
        return settings

    def ensure_dirs(self) -> None:
        for path in (self.data_dir, self.storage_dir, self.runs_dir):
            path.mkdir(parents=True, exist_ok=True)

    @property
    def is_mock(self) -> bool:
        return self.provider == "mock"

    def apply_config(self, values: dict[str, str]) -> None:
        """Apply settings stored by the web setup wizard."""
        if not values:
            return

        def as_float(key: str, current: float) -> float:
            try:
                return float(values[key])
            except (KeyError, TypeError, ValueError):
                return current

        def as_int(key: str, current: int) -> int:
            try:
                return int(values[key])
            except (KeyError, TypeError, ValueError):
                return current

        def as_bool(key: str, current: bool) -> bool:
            if key not in values:
                return current
            return str(values[key]).strip().lower() in {"1", "true", "yes", "on"}

        if "provider" in values:
            self.provider = (values["provider"] or "mock").strip().lower()
        if "model" in values:
            self.model = values["model"].strip() or default_model_for(self.provider)
        if "api_key" in values:
            self.api_key = values["api_key"].strip()
        if "base_url" in values:
            self.base_url = values["base_url"].strip().rstrip("/")
        if "anthropic_api_key" in values:
            self.anthropic_api_key = values["anthropic_api_key"].strip()
        if "anthropic_base_url" in values:
            self.anthropic_base_url = values["anthropic_base_url"].strip().rstrip("/")
        if "ollama_base_url" in values:
            self.ollama_base_url = values["ollama_base_url"].strip().rstrip("/")
        if "temperature" in values:
            self.temperature = as_float("temperature", self.temperature)
        if "max_tokens" in values:
            self.max_tokens = as_int("max_tokens", self.max_tokens)
        if "timeout" in values:
            self.timeout = as_float("timeout", self.timeout)
        if "max_agent_steps" in values:
            self.max_agent_steps = as_int("max_agent_steps", self.max_agent_steps)
        if "allow_heuristic_fallback" in values:
            self.allow_heuristic_fallback = as_bool(
                "allow_heuristic_fallback", self.allow_heuristic_fallback
            )
        if "host" in values:
            self.host = values["host"].strip() or "127.0.0.1"
        if "port" in values:
            self.port = as_int("port", self.port)
        if "setup_complete" in values:
            self.setup_complete = as_bool("setup_complete", self.setup_complete)

    def config_values(self, *, include_secrets: bool = False) -> dict[str, str]:
        """Serialize settings for the local database."""
        values = {
            "provider": self.provider,
            "model": self.model,
            "base_url": self.base_url,
            "anthropic_base_url": self.anthropic_base_url,
            "ollama_base_url": self.ollama_base_url,
            "temperature": str(self.temperature),
            "max_tokens": str(self.max_tokens),
            "timeout": str(self.timeout),
            "max_agent_steps": str(self.max_agent_steps),
            "allow_heuristic_fallback": "true" if self.allow_heuristic_fallback else "false",
            "host": self.host,
            "port": str(self.port),
            "setup_complete": "true" if self.setup_complete else "false",
        }
        if include_secrets:
            values["api_key"] = self.api_key
            values["anthropic_api_key"] = self.anthropic_api_key
        return values

    @property
    def active_api_key(self) -> str:
        if self.provider == "anthropic":
            return self.anthropic_api_key
        return self.api_key

    @property
    def api_key_hint(self) -> str:
        key = self.active_api_key
        if not key:
            return ""
        if len(key) <= 8:
            return "••••••••"
        return f"{key[:3]}…{key[-4:]}"

    def public_dict(self) -> dict:
        """Safe to print/return — never includes secrets."""
        return {
            "provider": self.provider,
            "model": self.model,
            "base_url": self.base_url if self.provider != "mock" else "",
            "data_dir": str(self.data_dir),
            "db_path": str(self.db_path),
            "runs_dir": str(self.runs_dir),
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "max_agent_steps": self.max_agent_steps,
            "heuristic_fallback": self.allow_heuristic_fallback,
            "setup_complete": self.setup_complete,
            "api_key_hint": self.api_key_hint,
        }
