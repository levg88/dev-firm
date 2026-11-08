import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { bugInboxDir, logPipelineError } from '../src/orchestrator/buglog';

const previous = process.env.DEV_FIRM_BUGS_DIR;

afterEach(() => {
  if (previous === undefined) delete process.env.DEV_FIRM_BUGS_DIR;
  else process.env.DEV_FIRM_BUGS_DIR = previous;
});

describe('pipeline bug logging', () => {
  it('writes a tagged entry the fixer can process', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-firm-bugs-'));
    try {
      process.env.DEV_FIRM_BUGS_DIR = directory;
      const file = logPipelineError(
        { provider: 'mock' },
        {
          workflowId: 42,
          stage: 'tech lead review',
          message: 'provider timed out',
          workspace: '/tmp/workspace',
        },
      );
      expect(file).toBe(
        path.join(
          directory,
          `${new Date().toISOString().slice(0, 10)}_pipeline-workflow-42-tech-lead-review.md`,
        ),
      );
      const text = fs.readFileSync(String(file), 'utf8');
      expect(text).toContain('tech lead review failed in workflow #42');
      expect(text).toContain('provider timed out');
      expect(text).toContain('(mock /');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('appends repeated failures for the same workflow and stage', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-firm-bugs-'));
    try {
      process.env.DEV_FIRM_BUGS_DIR = directory;
      logPipelineError({ provider: 'mock' }, { workflowId: 7, stage: 'qa', message: 'first' });
      const file = logPipelineError(
        { provider: 'mock' },
        { workflowId: 7, stage: 'qa', message: 'second' },
      );
      const text = fs.readFileSync(String(file), 'utf8');
      expect(text).toContain('first');
      expect(text).toContain('second');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('falls back to the repo bug inbox', () => {
    delete process.env.DEV_FIRM_BUGS_DIR;
    expect(bugInboxDir()).toBe(path.resolve('Bugs', '_inbox'));
  });
});
