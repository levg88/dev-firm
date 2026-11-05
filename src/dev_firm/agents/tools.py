from __future__ import annotations

import json
import shlex
import subprocess
from pathlib import Path
from typing import Any

from .base import Tool, ToolRegistry


class SandboxError(RuntimeError):
    pass


class Sandbox:
    """Workspace-scoped file and command tools.

    This is an isolation convenience, not a security boundary: the app runs
    locally on the user's machine. Commands are restricted to a small allowlist
    and executed with the workspace as cwd.
    """

    ALLOWED_COMMANDS = {
        "pytest",
        "python",
        "python3",
        "pip",
        "ls",
        "cat",
        "grep",
        "rg",
        "find",
        "node",
        "npm",
        "pnpm",
        "yarn",
    }

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def resolve(self, relative: str) -> Path:
        if not relative:
            raise SandboxError("A path is required")
        candidate = Path(relative)
        if candidate.is_absolute():
            path = candidate.resolve()
        else:
            path = (self.root / candidate).resolve()
        if path != self.root and self.root not in path.parents:
            raise SandboxError(f"Path escapes the workspace: {relative}")
        return path

    def read_file(self, path: str) -> str:
        target = self.resolve(path)
        if not target.is_file():
            raise SandboxError(f"File not found: {path}")
        return target.read_text(encoding="utf-8", errors="replace")[:200000]

    def write_file(self, path: str, content: str) -> dict[str, Any]:
        target = self.resolve(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return {"ok": True, "path": str(target.relative_to(self.root)), "bytes": len(content.encode("utf-8"))}

    def list_files(self, path: str = ".") -> list[str]:
        base = self.resolve(path)
        if base.is_file():
            return [str(base.relative_to(self.root))]
        files = []
        for item in sorted(base.rglob("*")):
            rel = item.relative_to(self.root)
            if any(part.startswith(".") for part in rel.parts):
                continue
            if item.is_file():
                files.append(str(rel))
            if len(files) >= 300:
                break
        return files

    def run_command(self, command: str, timeout: int = 120) -> dict[str, Any]:
        try:
            argv = shlex.split(command)
        except ValueError as exc:
            raise SandboxError(f"Could not parse command: {exc}") from exc
        if not argv:
            raise SandboxError("A command is required")
        executable = Path(argv[0]).name
        if executable not in self.ALLOWED_COMMANDS:
            raise SandboxError(
                f"Command '{executable}' is not allowed. Allowed: {', '.join(sorted(self.ALLOWED_COMMANDS))}"
            )
        try:
            proc = subprocess.run(
                argv,
                cwd=str(self.root),
                capture_output=True,
                text=True,
                timeout=timeout,
                env={
                    "PATH": "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
                    "PYTHONPATH": str(self.root),
                    "HOME": str(Path.home()),
                },
            )
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": f"Timed out after {timeout}s", "command": command}
        return {
            "ok": proc.returncode == 0,
            "returncode": proc.returncode,
            "stdout": (proc.stdout or "")[-30000:],
            "stderr": (proc.stderr or "")[-30000:],
            "command": command,
        }


def make_tools(sandbox: Sandbox, *, read_only: bool = False) -> ToolRegistry:
    registry = ToolRegistry()
    registry.add(
        Tool(
            name="read_file",
            description="Read a UTF-8 text file from the workspace.",
            parameters={
                "type": "object",
                "properties": {"path": {"type": "string", "description": "Relative file path"}},
                "required": ["path"],
            },
            handler=sandbox.read_file,
        )
    )
    registry.add(
        Tool(
            name="list_files",
            description="List files in the workspace, optionally under a subdirectory.",
            parameters={
                "type": "object",
                "properties": {"path": {"type": "string", "default": "."}},
            },
            handler=sandbox.list_files,
        )
    )
    if not read_only:
        registry.add(
            Tool(
                name="write_file",
                description="Create or overwrite a UTF-8 file in the workspace. Always write complete file contents.",
                parameters={
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "content": {"type": "string"},
                    },
                    "required": ["path", "content"],
                },
                handler=sandbox.write_file,
            )
        )
    registry.add(
        Tool(
            name="run_command",
            description=(
                "Run an allowed command in the workspace and return stdout/stderr. "
                "Use it to run tests or inspect the project."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "timeout": {"type": "integer", "default": 120},
                },
                "required": ["command"],
            },
            handler=sandbox.run_command,
        )
    )
    return registry


def artifact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, default=str)
