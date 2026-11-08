/**
 * Zod schemas describing every structured payload produced and consumed by the
 * dev-firm agents, plus the coercion helpers that normalise the loosely-typed
 * JSON an LLM returns into those schemas.
 *
 * The schemas are intentionally permissive: each field preprocesses its input
 * through `coerceText`/`asList`/etc. so that a model returning a string where an
 * array was expected (or a dict of lists, a list of objects, ...) still validates.
 * Downstream code can therefore trust the inferred TypeScript types.
 *
 * @module models
 */

import { z } from 'zod';

/** UnknownRecord type. */
type UnknownRecord = Record<string, unknown>;

/** Type guard: a non-null, non-array object record. */
function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalise a value that may be a string, a dict of lists, a list of objects,
 * or a single scalar into a flat list of strings. LLMs are inconsistent about
 * which shape they emit, so this is used as the preprocessor for every
 * `listField` in the schemas.
 */
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

/** Coerce any value into a trimmed string (objects become JSON). */
export function coerceText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value).trim();
}

/** Normalise a value into a list of records (used for task/bug/assignment lists). */
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

/** Coerce a truthy-ish value into a boolean. */
function asBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes', 'on', 'pass', 'passed', 'approved', 'ok'].includes(
    String(value ?? '').trim().toLowerCase(),
  );
}

const textField = z.preprocess((value) => coerceText(value), z.string().default(''));
const listField = z.preprocess((value) => asList(value), z.array(z.string()).default([]));
const boolField = z.preprocess((value) => asBool(value), z.boolean().default(false));

/** Allowed work areas a task can target. */
export const TASK_AREAS = ['backend', 'frontend', 'fullstack', 'docs', 'infra'] as const;
/** TaskArea type. */
export type TaskArea = (typeof TASK_AREAS)[number];

/** Agent roles that can implement code. */
export const DEVELOPER_ROLES = ['backend_developer', 'frontend_developer'] as const;
/** DeveloperRole type. */
export type DeveloperRole = (typeof DEVELOPER_ROLES)[number];

/** All agent roles participating in a build. */
export const AGENT_ROLES = [
  'product_manager',
  'architect',
  'team_lead',
  'backend_developer',
  'frontend_developer',
  'tech_lead',
  'qa',
  'devops',
] as const;
/** AgentRole type. */
export type AgentRole = (typeof AGENT_ROLES)[number];

/**
 * Coerce a free-form area string into one of the canonical {@link TaskArea}
 * values, defaulting to `backend` when nothing matches.
 */
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

/** Coerce a free-form developer name into a canonical {@link DeveloperRole}. */
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

/** Schema for a single task produced by the product manager. */
export const taskSchema = z.object({
  title: textField,
  description: textField,
  area: areaField,
  acceptance_criteria: listField,
});

/** Schema for a task->developer assignment decided by the team lead. */
export const assignmentSchema = z.object({
  task: textField,
  developer: developerField,
  notes: textField,
});

/** Schema for a bug filed by QA. */
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

/** Schema for the QA report returned at the end of a build iteration. */
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

/** Schema for a single file in an architecture file plan. */
export const filePlanSchema = z.object({
  path: z.preprocess((value) => coerceText(value), z.string().default('')),
  purpose: z.preprocess((value) => coerceText(value), z.string().default('')),
});

/** Schema for the architect's design document. */
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

/** Schema for the product manager's spec. */
export const productSpecSchema = z.object({
  markdown: z.preprocess((value) => coerceText(value), z.string().default('')),
  summary: z.preprocess((value) => coerceText(value), z.string().default('')),
  user_stories: z.preprocess((value) => asList(value), z.array(z.string()).default([])),
  acceptance_criteria: z.preprocess((value) => asList(value), z.array(z.string()).default([])),
  non_goals: z.preprocess((value) => asList(value), z.array(z.string()).default([])),
  risks: z.preprocess((value) => asList(value), z.array(z.string()).default([])),
  tasks: z.preprocess((value) => asObjectList(value), z.array(taskSchema).default([])),
});

/** Schema for a developer's implementation report. */
export const developerReportSchema = z.object({
  summary: z.preprocess((value) => coerceText(value), z.string().default('')),
  files_written: z.preprocess((value) => asList(value), z.array(z.string()).default([])),
  tests_run: z.preprocess((value) => asList(value), z.array(z.string()).default([])),
  known_issues: z.preprocess((value) => asList(value), z.array(z.string()).default([])),
  tasks_completed: z.preprocess((value) => asList(value), z.array(z.string()).default([])),
});

/** Schema for the tech lead's review verdict. */
export const techLeadReviewSchema = z.object({
  verdict: z.preprocess(
    (value) => value === true || value === 'true' || value === 'True',
    z.boolean().default(false),
  ),
  summary: textField,
  issues: listField,
});

/** Schema for the team lead's design review. */
export const designReviewSchema = z.object({
  approved: boolField,
  summary: textField,
  assignments: z.preprocess((value) => asObjectList(value), z.array(assignmentSchema).default([])),
  issues: listField,
  recommendations: listField,
});

/** Schema for triage of bugs opened by QA. */
export const bugTriageSchema = z.object({
  summary: textField,
  assignments: z.preprocess((value) => asObjectList(value), z.array(assignmentSchema).default([])),
  issues: listField,
});

/** Schema for the devops agent's report. */
export const devopsReportSchema = z.object({
  summary: z.preprocess((value) => coerceText(value), z.string().default('')),
  actions_taken: z.preprocess((value) => asList(value), z.array(z.string()).default([])),
  deployments: z.preprocess((value) => asList(value), z.array(z.string()).default([])),
  pipeline_status: z.preprocess((value) => coerceText(value), z.string().default('')),
  known_issues: z.preprocess((value) => asList(value), z.array(z.string()).default([])),
  tasks_completed: z.preprocess((value) => asList(value), z.array(z.string()).default([])),
  health_check: z.preprocess((value) => coerceText(value), z.string().default('')),
  health: z.preprocess((value) => coerceText(value), z.string().default('')),
  monitoring: z.preprocess((value) => coerceText(value), z.string().default('')),
  monitoring_status: z.preprocess((value) => coerceText(value), z.string().default('')),
  logging: z.preprocess((value) => coerceText(value), z.string().default('')),
});

/** QAReport type. */
export type QAReport = z.infer<typeof qaReportSchema>;
/** ProductSpec type. */
export type ProductSpec = z.infer<typeof productSpecSchema>;
/** Architecture type. */
export type Architecture = z.infer<typeof architectureSchema>;
/** DeveloperReport type. */
export type DeveloperReport = z.infer<typeof developerReportSchema>;
/** FilePlan type. */
export type FilePlan = z.infer<typeof filePlanSchema>;
/** TechLeadReview type. */
export type TechLeadReview = z.infer<typeof techLeadReviewSchema>;
/** DesignReview type. */
export type DesignReview = z.infer<typeof designReviewSchema>;
/** BugTriage type. */
export type BugTriage = z.infer<typeof bugTriageSchema>;
/** DevOpsReport type. */
export type DevOpsReport = z.infer<typeof devopsReportSchema>;
/** TaskSpec type. */
export type TaskSpec = z.infer<typeof taskSchema>;
/** BugSpec type. */
export type BugSpec = z.infer<typeof bugSchema>;
/** Assignment type. */
export type Assignment = z.infer<typeof assignmentSchema>;
