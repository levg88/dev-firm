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

function asObjectList(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value;
  if (isRecord(value)) return Object.entries(value).map(([key, item]) =>
    isRecord(item) ? { title: key, ...item } : { title: key, description: String(item ?? '') },
  );
  if (typeof value === 'string') {
    return value.trim() ? value.split(/\n+/).filter(Boolean).map((line) => ({ title: line.trim() })) : [];
  }
  return [];
}

function asBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes', 'on', 'pass', 'passed', 'approved', 'ok'].includes(
    String(value ?? '').trim().toLowerCase(),
  );
}

const textField = z.preprocess((value) => coerceText(value), z.string().default(''));
const listField = z.preprocess((value) => asList(value), z.array(z.string()).default([]));
const boolField = z.preprocess((value) => asBool(value), z.boolean().default(false));

export const TASK_AREAS = ['backend', 'frontend', 'fullstack', 'docs', 'infra'] as const;
export type TaskArea = (typeof TASK_AREAS)[number];

export const DEVELOPER_ROLES = ['backend_developer', 'frontend_developer'] as const;
export type DeveloperRole = (typeof DEVELOPER_ROLES)[number];

export const AGENT_ROLES = [
  'product_manager',
  'architect',
  'team_lead',
  'backend_developer',
  'frontend_developer',
  'tech_lead',
  'qa',
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export function coerceArea(value: unknown): TaskArea {
  const text = coerceText(value).toLowerCase();
  if (text.includes('front') || text.includes('ui') || text.includes('web') || text.includes('client')) {
    return 'frontend';
  }
  if (text.includes('full') || text.includes('both')) return 'fullstack';
  if (text.includes('doc')) return 'docs';
  if (text.includes('infra') || text.includes('devops')) return 'infra';
  return 'backend';
}

export function coerceDeveloper(value: unknown): DeveloperRole {
  const text = coerceText(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (text.includes('front')) return 'frontend_developer';
  return 'backend_developer';
}

const areaField = z.preprocess((value) => coerceArea(value), z.enum(TASK_AREAS).default('backend'));
const developerField = z.preprocess(
  (value) => coerceDeveloper(value),
  z.enum(DEVELOPER_ROLES).default('backend_developer'),
);

export const taskSchema = z.object({
  title: textField,
  description: textField,
  area: areaField,
  acceptance_criteria: listField,
});

export const assignmentSchema = z.object({
  task: textField,
  developer: developerField,
  notes: textField,
});

export const bugSchema = z.object({
  title: textField,
  description: textField,
  severity: z.preprocess(
    (value) => {
      const text = coerceText(value).toLowerCase();
      if (text.startsWith('block')) return 'blocker';
      if (text.startsWith('min')) return 'minor';
      return 'major';
    },
    z.enum(['blocker', 'major', 'minor']).default('major'),
  ),
  area: areaField,
  parent_task: textField,
});

export const qaReportSchema = z.object({
  passed: z.preprocess(
    (value) => value === true || value === 'true' || value === 'True',
    z.boolean().default(false),
  ),
  summary: textField,
  issues: listField,
  tests_run: listField,
  recommendation: textField,
  evidence: listField,
  bugs: z.preprocess((value) => asObjectList(value), z.array(bugSchema).default([])),
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
  tasks: z.preprocess((value) => asObjectList(value), z.array(taskSchema).default([])),
});

export const developerReportSchema = z.object({
  summary: z.preprocess((value) => coerceText(value), z.string().default('')),
  files_written: z.preprocess((value) => asList(value), z.array(z.string()).default([])),
  tests_run: z.preprocess((value) => asList(value), z.array(z.string()).default([])),
  known_issues: z.preprocess((value) => asList(value), z.array(z.string()).default([])),
  tasks_completed: z.preprocess((value) => asList(value), z.array(z.string()).default([])),
});

export const techLeadReviewSchema = z.object({
  verdict: z.preprocess(
    (value) => value === true || value === 'true' || value === 'True',
    z.boolean().default(false),
  ),
  summary: textField,
  issues: listField,
});

export const designReviewSchema = z.object({
  approved: boolField,
  summary: textField,
  assignments: z.preprocess((value) => asObjectList(value), z.array(assignmentSchema).default([])),
  issues: listField,
  recommendations: listField,
});

export const bugTriageSchema = z.object({
  summary: textField,
  assignments: z.preprocess((value) => asObjectList(value), z.array(assignmentSchema).default([])),
  issues: listField,
});

export type QAReport = z.infer<typeof qaReportSchema>;
export type ProductSpec = z.infer<typeof productSpecSchema>;
export type Architecture = z.infer<typeof architectureSchema>;
export type DeveloperReport = z.infer<typeof developerReportSchema>;
export type FilePlan = z.infer<typeof filePlanSchema>;
export type TechLeadReview = z.infer<typeof techLeadReviewSchema>;
export type DesignReview = z.infer<typeof designReviewSchema>;
export type BugTriage = z.infer<typeof bugTriageSchema>;
export type TaskSpec = z.infer<typeof taskSchema>;
export type BugSpec = z.infer<typeof bugSchema>;
export type Assignment = z.infer<typeof assignmentSchema>;
