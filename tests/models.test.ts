import { describe, expect, it } from 'vitest';

import {
  architectureSchema,
  developerReportSchema,
  productSpecSchema,
  qaReportSchema,
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

  it('fills defaults for empty model output', () => {
    const spec = productSpecSchema.parse({});
    expect(spec.markdown).toBe('');
    expect(spec.acceptance_criteria).toEqual([]);
    const architecture = architectureSchema.parse({});
    expect(architecture.stack).toEqual([]);
    const developer = developerReportSchema.parse({});
    expect(developer.files_written).toEqual([]);
  });
});
