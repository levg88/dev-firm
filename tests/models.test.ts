import { describe, expect, it } from 'vitest';

import {
  architectureSchema,
  bugTriageSchema,
  designReviewSchema,
  developerReportSchema,
  productSpecSchema,
  qaReportSchema,
  taskSchema,
  techLeadReviewSchema,
} from '../src/agents/build_schemas';

describe('build schemas', () => {
  it('accepts QA report loose list shapes', () => {
    const report = qaReportSchema.parse({
      passed: true,
      summary: 'Looks good',
      issues: 'minor naming',
      tests_run: { pytest: ['test_app.py'] },
    });
    expect(report.passed).toBe(true);
    expect(report.issues).toEqual(['minor naming']);
    expect(report.tests_run).toEqual(['pytest: test_app.py']);
  });

  it('accepts tech lead review loose list shapes', () => {
    const review = techLeadReviewSchema.parse({
      verdict: true,
      summary: 'Looks aligned',
      issues: 'minor naming',
    });
    expect(review.verdict).toBe(true);
    expect(review.summary).toBe('Looks aligned');
    expect(review.issues).toEqual(['minor naming']);
  });

  it('fills defaults for empty model output', () => {
    const spec = productSpecSchema.parse({});
    expect(spec.markdown).toBe('');
    expect(spec.acceptance_criteria).toEqual([]);
    const architecture = architectureSchema.parse({});
    expect(architecture.stack).toEqual([]);
    const developer = developerReportSchema.parse({});
    expect(developer.files_written).toEqual([]);
  });

  it('coerces task areas and developer assignments', () => {
    const spec = productSpecSchema.parse({
      tasks: [
        {
          title: 'Build the API',
          description: 'Server work',
          area: 'Backend services',
          acceptance_criteria: 'GET /health works',
        },
        {
          title: 'Build the dashboard',
          description: 'UI work',
          area: 'UI',
          acceptance_criteria: ['Dashboard renders'],
        },
      ],
    });
    expect(spec.tasks.map((task) => task.area)).toEqual(['backend', 'frontend']);
    expect(spec.tasks[0].acceptance_criteria).toEqual(['GET /health works']);

    const review = designReviewSchema.parse({
      approved: 'yes',
      assignments: [
        { task: 'CAREER-1', developer: 'frontend' },
        { task: 'CAREER-2', developer: 'Backend Developer' },
      ],
    });
    expect(review.approved).toBe(true);
    expect(review.assignments[0].developer).toBe('frontend_developer');
    expect(review.assignments[1].developer).toBe('backend_developer');
  });

  it('normalises bugs and bug triage from loose output', () => {
    const qa = qaReportSchema.parse({
      passed: false,
      summary: 'One failure',
      bugs: [
        {
          title: 'Crash',
          description: 'It crashes',
          severity: 'Blocking',
          area: 'web UI',
          parent_task: 'CAREER-1',
        },
      ],
    });
    expect(qa.bugs[0].severity).toBe('blocker');
    expect(qa.bugs[0].area).toBe('frontend');

    const triage = bugTriageSchema.parse({
      assignments: [{ task: 'CAREER-3', developer: 'frontend developer' }],
    });
    expect(triage.assignments[0].developer).toBe('frontend_developer');
    expect(
      taskSchema.parse({
        title: 'Docs',
        area: 'documentation',
        acceptance_criteria: { docs: ['README updated'] },
      }).area,
    ).toBe('docs');
  });
});
