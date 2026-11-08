/**
 * @file Deterministic bug-inbox logging for pipeline failures.
 *
 * The fixer agent consumes `Bugs/_inbox/`. Agents are told to log defects they
 * discover, but some failures are caught by the orchestrator itself (a provider
 * error, a stage that could not run, a fatal workflow exception). This module
 * makes those failures visible to the fixer without relying on the model.
 *
 * One file per workflow/stage/day keeps parallel runs from interleaving. Set
 * `DEV_FIRM_BUGS_DIR` to redirect the inbox (used by tests and headless runs).
 */

import fs from 'node:fs';
import path from 'node:path';

import type { Settings } from '../config';

export interface PipelineErrorDetails {
  workflowId: number | null;
  stage: string;
  message: string;
  workspace?: string;
}

/** Resolve the bug inbox directory. */
export function bugInboxDir(): string {
  const override = process.env.DEV_FIRM_BUGS_DIR?.trim();
  if (override) return path.resolve(override);
  return path.resolve(__dirname, '..', '..', 'Bugs', '_inbox');
}

/**
 * Append a tagged pipeline failure to the bug inbox. Returns the file path, or
 * `null` when logging is impossible (the build must not fail because the inbox
 * is read-only).
 */
export function logPipelineError(
  settings: Pick<Settings, 'provider'>,
  details: PipelineErrorDetails,
): string | null {
  try {
    const dir = bugInboxDir();
    fs.mkdirSync(dir, { recursive: true });

    const date = new Date().toISOString().slice(0, 10);
    const workflow = details.workflowId ?? 0;
    const stage = details.stage
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'pipeline';
    const file = path.join(dir, `${date}_pipeline-workflow-${workflow}-${stage}.md`);
    const message = details.message.replace(/\r/g, '').slice(0, 4000);
    const tag = `(${settings.provider} / ${process.platform}, ${date})`;

    const entry = [
      `## [Issue: ${details.stage} failed in workflow #${workflow}]`,
      `- ${message}`,
      `- Stage: ${details.stage}; workflow: ${workflow}; workspace: ${details.workspace ?? 'unknown'}.`,
      `- Reproduction: inspect workflow #${workflow} in the Dev Firm database and the artifacts for this stage.`,
      `- ${tag}`,
      '',
    ].join('\n');

    fs.appendFileSync(file, entry, 'utf8');
    return file;
  } catch {
    return null;
  }
}
