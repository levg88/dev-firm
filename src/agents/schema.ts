/**
 * @file Mapping from markdown `schema:` names to Zod output schemas.
 *
 * Agent definitions stay declarative; the runtime resolves the named schema
 * here so JSON output is still validated and audited.
 */

import type { ZodType } from 'zod';

import {
  architectureSchema,
  bugTriageSchema,
  designReviewSchema,
  developerReportSchema,
  devopsReportSchema,
  productSpecSchema,
  qaReportSchema,
  techLeadReviewSchema,
} from '../models';
import type { AgentDefinition, AgentSchemaName } from './definitions';

const SCHEMAS: Record<Exclude<AgentSchemaName, 'none'>, ZodType> = {
  product_spec: productSpecSchema,
  architecture: architectureSchema,
  design_review: designReviewSchema,
  bug_triage: bugTriageSchema,
  developer_report: developerReportSchema,
  tech_lead_review: techLeadReviewSchema,
  qa_report: qaReportSchema,
  devops_report: devopsReportSchema,
};

/** Resolve the output schema declared by an agent definition. */
export function schemaForAgent(definition: AgentDefinition): ZodType | undefined {
  if (definition.schema === 'none') return undefined;
  return SCHEMAS[definition.schema];
}
