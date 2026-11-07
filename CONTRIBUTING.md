# Contributing to Dev Firm

Thank you for your interest in contributing! This guide explains how to set up the project,
run tests, and submit changes.

## Getting started

1. Fork the repository on GitHub.
2. Clone your fork locally.
3. Install dependencies:
   ```bash
   npm install
   ```
4. Run the test suite to confirm everything works:
   ```bash
   npm test
   npm run typecheck
   ```

## Development workflow

- Create a feature branch from `main`:
  ```bash
  git checkout -b feat/your-feature-name
  ```
- Make your changes following the existing code style.
- Add or update tests as needed.
- Run `npm test` and `npm run typecheck` before committing.
- Commit with a clear, descriptive message.
- Push your branch and open a pull request.

## Code style

- TypeScript with strict mode (`tsc --noEmit`).
- No `.js` source files — only `.ts`.
- Prefer the built-in `node:sqlite` module for persistence; do not add native addons.
- Keep dependencies minimal and declare them in `package.json`.
- Follow the existing naming conventions and file structure.

## Reporting bugs

Please use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.yml) and include
reproduction steps, expected vs actual behavior, and your environment details.

## Requesting features

Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.yml).

## Pull requests

- Keep PRs focused on a single change.
- Include tests for new functionality.
- Update documentation if needed.
- Link to the relevant issue.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
