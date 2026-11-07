# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- DevOps agent role for CI/CD monitoring, GitOps, and deployment
- Per-role model overrides (different models for different agents)
- Multi-Ollama instance support (different base URLs per role)
- Tech lead status reporter (every 10 minutes)
- Agent conversation logging (step-by-step in DB)
- Agent detail page with full conversation log
- Chat UI with natural language support
- GitHub Projects integration (Issues + Projects v2)
- Per-role git identities for commits
- Progress bar and loader on build detail page
- TypeScript-only generated stack enforcement

### Changed
- Increased parallelism: 4 developer instances (2 backend + 2 frontend)
- Strengthened developer prompts for TypeScript-only output
- Status reporter posts to GitHub epic issue

## [0.1.0] - 2026-11-06

### Added
- Initial release
- SDLC agent firm: PM → architect → team lead → developers → tech lead → QA
- GitHub Projects integration (Issues + Projects v2)
- Per-role git identities
- Build pipeline with rejection/bug loops
- Status reporter (every 10 minutes)
- Web UI: dashboard, build lab, tickets, agents, runs, settings
- 37 tests, TypeScript strict mode
