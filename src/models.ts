import { z } from 'zod';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** LLMs occasionally return a string, dict of lists, or list of objects. */
export function asList(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    return value.trim() ? [value.trim()] : [];
  }
  if (isRecord(value)) {
    const out: string[] = [];
    for (const [key, item] of Object.entries(value)) {
      if (Array.isArray(item)) {
        out.push(...item.filter((x) => String(x).trim()).map((x) => `${key}: ${x}`));
      } else if (String(item).trim()) {
        out.push(`${key}: ${item}`);
      }
    }
    return out;
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (isRecord(item)) {
        out.push(String(item.text || item.name || item.requirement || String(item)));
      } else if (String(item).trim()) {
        out.push(String(item).trim());
      }
    }
    return out;
  }
  return [String(value)];
}

export function coerceText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).trim();
}

const textField = z.preprocess((value) => coerceText(value), z.string().default(''));
const listField = z.preprocess((value) => asList(value), z.array(z.string()).default([]));

export const qaReportSchema = z.object({
  passed: z.preprocess(
    (value) => value === true || value === 'true' || value === 'True',
    z.boolean().default(false),
  ),
  summary: textField,
  issues: listField,
  tests_run: listField,
  recommendation: textField,
});

export const filePlanSchema = z.object({
  path: z.preprocess((value) => coerceText(value), z.string().default('')),
  purpose: z.preprocess((value) => coerceText(value), z.string().default('')),
});

export const architectureSchema = z.object({
  markdown: z.preprocess((value) => coerceText(value), z.string().default('')),
  stack: z.preprocess((value) => asList(value), z.array(z.string()).default([])),
  files: z.preprocess((value) => {
    if (value === null || value === undefined) return [];
    if (Array.isArray(value)) {
      return value.map((item) => (typeof item === 'string' ? { path: item, purpose: '' } : item));
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>).map(
        ([key, item]) => ({ path: key, purpose: String(item ?? '') }),
      );
      return entries;
    }
    return [];
  }, z.array(filePlanSchema).default([])),
  data_model: z.preprocess((value) => coerceText(value), z.string().default('')),
  api: z.preprocess((value) => coerceText(value), z.string().default('')),
  test_plan: z.preprocess((value) => asList(value), z.array(z.string()).default([])),
  risks: z.preprocess((value) => asList(value), z.array(z.string()).default([])),
});

export const productSpecSchema = z.object({
  markdown: z.preprocess((value) => coerceText(value), z.string().default('')),
  summary: z.preprocess((value) => coerceText(value), z.string().default('')),
  user_stories: z.preprocess((value) => asList(value), z.array(z.string()).default([])),
  acceptance_criteria: z.preprocess((value) => asList(value), z.array(z.string()).default([])),
  non_goals: z.preprocess((value) => asList(value), z.array(z.string()).default([])),
  risks: z.preprocess((value) => asList(value), z.array(z.string()).default([])),
});

export const developerReportSchema = z.object({
  summary: z.preprocess((value) => coerceText(value), z.string().default('')),
  files_written: z.preprocess((value) => asList(value), z.array(z.string()).default([])),
  tests_run: z.preprocess((value) => asList(value), z.array(z.string()).default([])),
  known_issues: z.preprocess((value) => asList(value), z.array(z.string()).default([])),
});

export const techLeadReviewSchema = z.object({
  verdict: z.preprocess(
    (value) => value === true || value === 'true' || value === 'True',
    z.boolean().default(false),
  ),
  summary: textField,
  issues: listField,
});

export type QAReport = z.infer<typeof qaReportSchema>;
export type ProductSpec = z.infer<typeof productSpecSchema>;
export type Architecture = z.infer<typeof architectureSchema>;
export type DeveloperReport = z.infer<typeof developerReportSchema>;
export type FilePlan = z.infer<typeof filePlanSchema>;
export type TechLeadReview = z.infer<typeof techLeadReviewSchema>;
