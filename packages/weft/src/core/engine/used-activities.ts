/**
 * Registration-time normalization of a workflow's `.uses({...})` map: the
 * engine-provided activities it declares, kept as name and schema metadata.
 *
 * @module core/engine/used-activities
 */

import { isPlainRecord } from '../../worker/manifest/is-plain-record.ts';
import {
  validateDefinitionSchemaMetadata,
  type UsedActivityDefinition,
  type WorkflowDefinition,
} from '../types.ts';
import { validateWorkflowOrActivityName } from '../types/name-grammar.ts';

/**
 * Validate and copy a builder definition's `.uses()` map. The builder already
 * enforces this shape, but a dynamic workflow source's export is untrusted, so
 * the same rules are checked here: a plain record whose keys are valid activity
 * names, each entry named for its key, never also scoped by `.activities()`.
 */
export function normalizeUsedActivities(
  workflowType: string,
  registration: WorkflowDefinition & {
    readonly activities: Readonly<Record<string, unknown>>;
  },
): Readonly<Record<string, UsedActivityDefinition>> | undefined {
  const raw = (registration as { readonly uses?: unknown }).uses;
  if (raw === undefined) return undefined;
  if (!isPlainRecord(raw)) {
    throw new TypeError(`Workflow "${workflowType}": uses must be a plain object`);
  }
  const normalized = Object.create(null) as Record<string, UsedActivityDefinition>;
  for (const key of Object.keys(raw).toSorted()) {
    validateWorkflowOrActivityName(key, 'activity');
    const entry = raw[key];
    if (!isPlainRecord(entry) || entry['name'] !== key) {
      throw new TypeError(
        `Workflow "${workflowType}": uses entry "${key}" must be an activity definition named "${key}"`,
      );
    }
    if (Object.hasOwn(registration.activities, key)) {
      throw new TypeError(
        `Workflow "${workflowType}": activity "${key}" is declared in both activities and uses`,
      );
    }
    const label = `registration("${workflowType}").uses.${key}`;
    normalized[key] = Object.freeze({
      name: key,
      ...(entry['inputSchema'] === undefined
        ? {}
        : {
            inputSchema: validateDefinitionSchemaMetadata(
              entry['inputSchema'],
              `${label}.inputSchema`,
            ),
          }),
      ...(entry['outputSchema'] === undefined
        ? {}
        : {
            outputSchema: validateDefinitionSchemaMetadata(
              entry['outputSchema'],
              `${label}.outputSchema`,
            ),
          }),
    });
  }
  return Object.keys(normalized).length === 0 ? undefined : Object.freeze(normalized);
}

/** `{ uses }` with a fresh copy of `uses` when present, otherwise `{}`, for spreading into a definition. */
export function usedActivitiesField(
  uses: Readonly<Record<string, UsedActivityDefinition>> | undefined,
): { uses?: Readonly<Record<string, UsedActivityDefinition>> } {
  return uses === undefined ? {} : { uses: { ...uses } };
}
