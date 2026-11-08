---
id: typescript-runtime
name: TypeScript Runtime
description: Current Node.js and TypeScript constraints for generated projects.
agents: architect, backend_developer, frontend_developer, tech_lead, qa, devops
---

- Target the current Node.js runtime and TypeScript only. Plan and create `.ts`
  source files; never create `.js` source files.
- Every project gets a strict `tsconfig.json` with `strict: true`, and these
  package scripts: `typecheck`: `tsc --noEmit`, `build`: `tsc`, `test`:
  `vitest run`.
- Use the built-in `node:sqlite` module for persistence. Never add native addons
  such as `better-sqlite3`, `sqlite3`, or `bcrypt`; they fail to install in this
  environment.
- Declare every runtime import in `dependencies` and every test-only import in
  `devDependencies`. The workspace starts with no modules.
- Prefer current package majors (`express` ^5, `ejs` ^3, `vitest` ^3,
  `supertest` ^7, `typescript` ^5). Never specify versions that fail on the
  current Node runtime.
- Keep the process local-first and single-process unless the product spec
  explicitly requires more. Avoid cloud services, native services, and
  unnecessary frameworks.
